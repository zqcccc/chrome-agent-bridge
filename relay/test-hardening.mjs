// 回归测试：五项加固修复（离线，不依赖真实 Chrome）
//
// 每一项都对应一个**已隔离复现**过的缺陷。测试写成「先构造当初能骗过旧代码的输入，
// 再断言新代码不接受它」，而不是只断言 happy path —— 否则这些 bug 会悄悄回来。
//
//   1. token 读取失败时静默降级为固定密码 "dev"          → 必须 fail-closed
//   2. agent.stop 只是通知，不清队列、不拦后续 RPC        → 必须真的拦
//   3. 排队不计入超时；租约只在入队前检查一次             → 预算 + 派发前重查
//   4. 客户端丢 details；超时报成 CONNECTION_REFUSED      → 错误契约统一
//   5. 分片 WS 消息被当成两条                              → 按 FIN 组装
//
// 用法: node relay/test-hardening.mjs   （也接入 npm test）
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import { attachWsServer, WSConnection, encodeFrame, decodeFrame, OPCODE } from "./ws-server.js";
import { Bridge, BridgeError, BridgeTimeoutError } from "../agent/client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_JS = path.join(__dirname, "host.js");
const REAL_TOKEN_FILE = path.join(os.homedir(), ".chrome-agent-bridge", "token");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function httpReq(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { /* noop */ }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------- 极简 WS 客户端（会正确 mask，服务端现在强制要求） ----------
function wsConnect(port, pathname, token) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        `GET ${pathname}${token ? "?token=" + encodeURIComponent(token) : ""} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    const pending = [];
    const queue = [];
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString();
        buf = buf.slice(idx + 4);
        handshakeDone = true;
        if (!head.includes("101")) { sock.destroy(); return reject(new Error("handshake failed: " + head.split("\r\n")[0])); }
        resolve(client);
      }
      for (;;) {
        const f = decodeFrame(buf);
        if (f.need !== undefined) break;
        buf = buf.slice(f.consumed);
        if (f.opcode === OPCODE.TEXT) {
          const obj = JSON.parse(f.payload.toString("utf8"));
          if (pending.length) pending.shift()(obj);
          else queue.push(obj);
        } else if (f.opcode === OPCODE.CLOSE) {
          while (pending.length) pending.shift()(null);
          sock.destroy();
        }
      }
    });
    sock.on("error", () => { while (pending.length) pending.shift()(null); });
    const client = {
      send(obj) {
        const data = Buffer.from(JSON.stringify(obj), "utf8");
        const mask = crypto.randomBytes(4);
        const masked = Buffer.alloc(data.length);
        for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3];
        let header;
        if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
        else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
        else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
        sock.write(Buffer.concat([header, mask, masked]));
      },
      next() {
        if (queue.length) return Promise.resolve(queue.shift());
        return new Promise((res) => pending.push(res));
      },
      close() { sock.destroy(); },
    };
  });
}

/** 启动 host 子进程；可覆盖 HOME（隔离 token 文件）与环境变量。 */
async function startHost({ port, home, env = {}, args = [] } = {}) {
  const p = port || (await pickFreePort());
  const child = spawn(process.execPath, [HOST_JS, "--standalone", "--port", String(p), ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENT_BRIDGE_PORT: String(p), ...(home ? { HOME: home } : {}), ...env },
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  let exited = null;
  child.on("exit", (code) => { exited = code; });
  return { child, port: p, out: () => out, exited: () => exited };
}

async function waitReady(port, token) {
  for (let i = 0; i < 60; i++) {
    try {
      const s = await httpReq(port, "GET", "/status");
      if (s.status === 200 && s.body && s.body.name === "com.agentbrowser.bridge") return true;
    } catch (e) { /* 还没起来 */ }
    await sleep(100);
  }
  return false;
}

async function stopHost(h) {
  if (!h) return;
  try { h.child.kill("SIGKILL"); } catch (e) { /* noop */ }
  await sleep(80);
}

/** 等子进程退出并返回 { code, out }。 */
async function waitExit(h, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (h.exited() !== null) return { code: h.exited(), out: h.out() };
    await sleep(50);
  }
  return { code: null, out: h.out() };
}

/**
 * 假扩展：连上 /agent 并应答 RPC。
 * handler(req) 可返回 Promise；返回 null 表示「不响应」（用于制造超时）。
 * manual:true 时不启动自动应答循环——测试自己用 ws.next() 消费请求并手工回错误。
 *   （两者同时消费同一个 ws 会互相抢消息，导致测试永远等不到请求而挂死。）
 */
async function fakeExtension(port, token, handler, { manual = false } = {}) {
  const ws = await wsConnect(port, "/agent", token);
  await ws.next(); // hello
  const received = [];
  const stop = { stopped: false };
  if (!manual) {
    (async () => {
      while (!stop.stopped) {
        const req = await ws.next();
        if (!req || stop.stopped) return;
        if (req.type === "event") { received.push({ event: req.event, payload: req.payload }); continue; }
        if (req.method === undefined) continue;
        received.push({ id: req.id, method: req.method, params: req.params });
        let resp;
        try { resp = await handler(req); } catch (e) { resp = { ok: false, error: { code: "FAKE_ERROR", message: String(e) } }; }
        if (resp === null) continue; // 故意不响应
        ws.send({ id: req.id, ok: true, result: resp === undefined ? { echoed: req.method } : resp });
      }
    })();
  }
  return { ws, received, close: () => { stop.stopped = true; ws.close(); } };
}

// 便于在测试之间共享的临时 HOME（每个测试自建，避免互相污染）
function tmpHome(prefix = "bridge-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// =====================================================================
// #1 token 读取失败必须 fail-closed，不得降级成固定密码
// =====================================================================

test("#1 token: 显式 token 过短 → 拒绝启动（exit 2 + TOKEN_UNAVAILABLE）", async () => {
  const h = await startHost({ env: { AGENT_BRIDGE_TOKEN: "short" } });
  const r = await waitExit(h);
  assert.equal(r.code, 2, `应非零退出，实际 ${r.code}；输出: ${r.out}`);
  assert.match(r.out, /TOKEN_UNAVAILABLE/, "stderr 必须给出可编程判断的错误码");
  assert.match(r.out, /修复:/, "必须给出可操作的修复建议，而不是只说失败");
  // fail-closed 的另一半：端口上不能有任何东西在服务
  await assert.rejects(httpReq(h.port, "GET", "/status"), /ECONNREFUSED/);
  await stopHost(h);
});

test("#1 token: token 文件不可读（EISDIR）→ 拒绝启动，绝不返回 dev", async () => {
  const home = tmpHome();
  const dir = path.join(home, ".chrome-agent-bridge");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, "token"));   // 同名目录：readFileSync 会 EISDIR
  const h = await startHost({ home });
  const r = await waitExit(h);
  assert.equal(r.code, 2, `应非零退出，实际 ${r.code}；输出: ${r.out}`);
  assert.match(r.out, /TOKEN_UNAVAILABLE/);
  assert.doesNotMatch(r.out, /\bdev\b/, "绝不能再出现固定密码 dev");
  await stopHost(h);
});

test("#1 token: 状态目录不可写 → 拒绝启动，且不残留半启动服务", async () => {
  const home = tmpHome();
  const dir = path.join(home, ".chrome-agent-bridge");
  fs.mkdirSync(dir, { recursive: true, mode: 0o500 });  // 只读目录：写 token 必失败
  const h = await startHost({ home });
  const r = await waitExit(h);
  assert.equal(r.code, 2, `应非零退出，实际 ${r.code}；输出: ${r.out}`);
  assert.match(r.out, /TOKEN_UNAVAILABLE/);
  await assert.rejects(httpReq(h.port, "GET", "/status"), /ECONNREFUSED/);
  fs.chmodSync(dir, 0o700);   // 让临时目录能被清理
  await stopHost(h);
});

test("#1 token: 权限过宽会被收紧到 600", async () => {
  const home = tmpHome();
  const dir = path.join(home, ".chrome-agent-bridge");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(path.join(dir, "token"), token, { mode: 0o644 });  // 别的本地用户可读 = 能接管浏览器
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port), `host 应启动；输出: ${h.out()}`);
  const mode = fs.statSync(path.join(dir, "token")).mode & 0o777;
  assert.equal(mode, 0o600, `token 文件权限应被收紧为 600，实际 ${mode.toString(8)}`);
  await stopHost(h);
});

test("#1 token: 空 token 文件 → 重新生成随机值（而不是空凭据）", async () => {
  const home = tmpHome();
  const dir = path.join(home, ".chrome-agent-bridge");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "token"), "", { mode: 0o600 });
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port), `host 应启动；输出: ${h.out()}`);
  const token = fs.readFileSync(path.join(dir, "token"), "utf8").trim();
  assert.ok(token.length >= 16, `应生成足够长的随机 token，实际长度 ${token.length}`);
  const ok = await httpReq(h.port, "POST", "/rpc", { method: "tabs.list" }, { Authorization: `Bearer ${token}` });
  assert.equal(ok.status, 200, "新 token 必须立即生效");
  await stopHost(h);
});

test("#1 token: 环境变量提供的合法 token 可用（且不碰用户真实 token 文件）", async () => {
  const home = tmpHome();   // 隔离 HOME：绝不触碰 ~/.chrome-agent-bridge/token
  const token = crypto.randomBytes(24).toString("hex");
  const h = await startHost({ home, env: { AGENT_BRIDGE_TOKEN: token } });
  assert.ok(await waitReady(h.port), `host 应启动；输出: ${h.out()}`);
  const bad = await httpReq(h.port, "POST", "/rpc", { method: "tabs.list" }, { Authorization: "Bearer dev" });
  assert.equal(bad.status, 401, "固定密码 dev 必须无效");
  const good = await httpReq(h.port, "POST", "/rpc", { method: "tabs.list" }, { Authorization: `Bearer ${token}` });
  assert.equal(good.status, 200);
  await stopHost(h);
});

test("#1 真实 token 文件未被本测试套件改动（安全护栏）", async () => {
  if (!fs.existsSync(REAL_TOKEN_FILE)) return;   // 本来就没有，无需断言
  const mode = fs.statSync(REAL_TOKEN_FILE).mode & 0o777;
  assert.equal(mode & 0o077, 0, `真实 token 文件权限不应被放宽，实际 ${mode.toString(8)}`);
});

// =====================================================================
// #5 WS 分片消息必须按 FIN 组装
// =====================================================================

/** 起一个只挂 WS 的 http server，返回 { port, messages, closes, close }。 */
async function wsFixture(routes = []) {
  const messages = [];
  const closes = [];
  const server = http.createServer();
  attachWsServer(server, [
    {
      path: "/t",
      token: "tok",
      onConnection(ws) {
        ws.on("message", (m) => messages.push(m));
        ws.on("close", () => closes.push(1));
        ws.on("protocolerror", (e) => closes.push(e));
      },
    },
    ...routes,
  ]);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, messages, closes, close: () => server.close() };
}

/** 手工构造一个帧（客户端帧默认 mask）。 */
function rawFrame(opcode, payload, { fin = true, mask = true, rsv = 0 } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const b0 = (fin ? 0x80 : 0) | (rsv << 4) | opcode;
  const maskBit = mask ? 0x80 : 0;
  let header;
  if (data.length < 126) header = Buffer.from([b0, maskBit | data.length]);
  else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = b0; header[1] = maskBit | 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[0] = b0; header[1] = maskBit | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  if (!mask) return Buffer.concat([header, data]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ key[i & 3];
  return Buffer.concat([header, key, masked]);
}

/** 连到一个 WS 端点（不走握手解析库，测试需要完全控制字节）。 */
function rawWsClient(port, pathname = "/t?token=tok") {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    let done = false;
    const frames = [];
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!done) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        buf = buf.slice(idx + 4);
        done = true;
        resolve(client);
      }
      for (;;) {
        const f = decodeFrame(buf);
        if (f.need !== undefined) break;
        buf = buf.slice(f.consumed);
        frames.push(f);
      }
    });
    sock.on("error", reject);
    const client = {
      sock, frames,
      write: (b) => sock.write(b),
      /** 等一个服务端帧（可带谓词）。 */
      async waitFrame(pred = () => true, timeoutMs = 2000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const i = frames.findIndex(pred);
          if (i !== -1) return frames.splice(i, 1)[0];
          if (Date.now() > deadline) return null;
          await sleep(20);
        }
      },
      closeCode: async () => {
        const f = await client.waitFrame((x) => x.opcode === OPCODE.CLOSE);
        return f && f.payload.length >= 2 ? f.payload.readUInt16BE(0) : null;
      },
    };
  });
}

test("#5 WS: 分片文本消息按 FIN 组装成一条（旧代码会拆成两条）", async () => {
  const fx = await wsFixture();
  try {
    const c = await rawWsClient(fx.port);
    c.write(rawFrame(OPCODE.TEXT, '{"ok":', { fin: false }));
    c.write(rawFrame(OPCODE.CONT, "true}", { fin: true }));
    await sleep(150);
    assert.deepEqual(fx.messages, ['{"ok":true}'], `必须只交付一条完整消息，实际 ${JSON.stringify(fx.messages)}`);
    c.sock.destroy();
  } finally { fx.close(); }
});

test("#5 WS: 分片中间夹 ping 不打断组装（控制帧可插入）", async () => {
  const fx = await wsFixture();
  try {
    const c = await rawWsClient(fx.port);
    c.write(rawFrame(OPCODE.TEXT, "par", { fin: false }));
    c.write(rawFrame(OPCODE.PING, "x"));            // 控制帧：必须回 pong，且不影响分片
    c.write(rawFrame(OPCODE.CONT, "t", { fin: true }));
    const pong = await c.waitFrame((f) => f.opcode === OPCODE.PONG);
    assert.ok(pong, "应回应 pong");
    await sleep(120);
    assert.deepEqual(fx.messages, ["part"]);
    c.sock.destroy();
  } finally { fx.close(); }
});

test("#5 WS: 未 mask 的客户端帧 → 1002 协议错误并断开", async () => {
  const fx = await wsFixture();
  try {
    const c = await rawWsClient(fx.port);
    c.write(rawFrame(OPCODE.TEXT, "hello", { mask: false }));
    assert.equal(await c.closeCode(), 1002, "RFC 6455 要求服务端拒绝未 mask 的客户端帧");
    c.sock.destroy();
  } finally { fx.close(); }
});

test("#5 WS: 超大消息按声明长度提前拒绝（1009），不会先攒满内存", async () => {
  const messages = [];
  const server = http.createServer();
  attachWsServer(server, [{
    path: "/t", token: "tok", maxMessageBytes: 64,
    onConnection(ws) { ws.on("message", (m) => messages.push(m)); },
  }]);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const c = await rawWsClient(server.address().port);
    // 只发帧头声明 200 字节，正文一个字节都不发：旧实现会一直 Buffer.concat 等下去
    const header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(200, 0);
    c.write(Buffer.concat([header, lenBuf, crypto.randomBytes(4)]));
    assert.equal(await c.closeCode(), 1009, "超限消息必须以 1009 关闭");
    assert.equal(messages.length, 0);
    c.sock.destroy();
  } finally { server.close(); }
});

test("#5 WS: 分片数超上限也会被拒绝（防无数小分片拖死 host）", async () => {
  const server = http.createServer();
  attachWsServer(server, [{
    path: "/t", token: "tok", maxFragments: 3, maxMessageBytes: 1024,
    onConnection(ws) { ws.on("message", () => {}); },
  }]);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const c = await rawWsClient(server.address().port);
    c.write(rawFrame(OPCODE.TEXT, "a", { fin: false }));
    for (let i = 0; i < 6; i++) c.write(rawFrame(OPCODE.CONT, "b", { fin: false }));
    assert.equal(await c.closeCode(), 1009, "分片数超限必须关闭连接");
    c.sock.destroy();
  } finally { server.close(); }
});

test("#5 WS: RSV 位非 0（未协商扩展）→ 1002，而不是把压缩数据当 JSON 静默丢掉", async () => {
  const fx = await wsFixture();
  try {
    const c = await rawWsClient(fx.port);
    c.write(rawFrame(OPCODE.TEXT, "x", { rsv: 1 }));
    assert.equal(await c.closeCode(), 1002);
    c.sock.destroy();
  } finally { fx.close(); }
});

test("#5 WS: 未知 opcode → 1002；控制帧不得分片/超 125 字节", async () => {
  const fx = await wsFixture();
  try {
    const c = await rawWsClient(fx.port);
    c.write(rawFrame(0x3, "x"));
    assert.equal(await c.closeCode(), 1002);
    c.sock.destroy();
  } finally { fx.close(); }

  const fx2 = await wsFixture();
  try {
    const c = await rawWsClient(fx2.port);
    c.write(rawFrame(OPCODE.PING, "y".repeat(200)));   // 控制帧 >125 字节
    assert.equal(await c.closeCode(), 1002);
    c.sock.destroy();
  } finally { fx2.close(); }
});

test("#5 WS: 慢消费者触发背压上限时断开（旧实现明确忽略 write 返回值）", async () => {
  // 假 socket：write 永不说 drain，也不回调 → _buffered 只增不减
  class StalledSocket extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.writable = true; this.written = []; }
    write(buf) { this.written.push(buf); return false; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit("close"); }
  }
  const sock = new StalledSocket();
  const ws = new WSConnection(sock, { maxBufferedBytes: 100 });
  let closed = false;
  ws.on("close", () => { closed = true; });
  for (let i = 0; i < 20 && !closed; i++) ws.sendText("x".repeat(40));
  assert.ok(closed, "超过背压上限必须断开，而不是无限缓冲");
  const closeFrames = sock.written.filter((b) => (b[0] & 0x0f) === OPCODE.CLOSE);
  assert.ok(closeFrames.length >= 1, "应发出 close 帧");
  assert.equal(closeFrames[closeFrames.length - 1].readUInt16BE(2), 1013, "背压断开用 1013 Try Again Later");
});

// =====================================================================
// #3 预算：排队计入超时；派发前重查租约/停止；客户端断开取消未派发请求
// =====================================================================

test("#3 排队时间计入超时：客户端已超时的请求不得再被派发", async () => {
  const home = tmpHome();
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port));
  const token = fs.readFileSync(path.join(home, ".chrome-agent-bridge", "token"), "utf8").trim();

  // 假扩展：tab=1 的第一个请求慢 700ms，用来把第二个请求压在队列里
  let first = true;
  const ext = await fakeExtension(h.port, token, async () => {
    if (first) { first = false; await sleep(700); }
    return { ok: true };
  });

  const t0 = Date.now();
  const slow = httpReq(h.port, "POST", "/rpc", { method: "page.snapshot", params: { tabId: 1 }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });
  await sleep(80);   // 确保第二个请求已入队（排在 slow 后面）
  const queued = await httpReq(h.port, "POST", "/rpc", { method: "page.click", params: { tabId: 1 }, timeoutMs: 250 }, { Authorization: `Bearer ${token}` });
  const elapsed = Date.now() - t0;

  assert.equal(queued.body.ok, false, `排队超时的请求必须失败，实际 ${JSON.stringify(queued.body)}`);
  assert.equal(queued.body.error.code, "TIMEOUT", "错误码应为 TIMEOUT");
  // 必须在**自己的预算**内失败，而不是一直等到排在前面那个慢请求结束（700ms）。
  // 旧实现没有排队计时器，调用方会白等到队列轮转才得知超时。
  assert.ok(elapsed < 600, `应在自己的预算内失败（排队期 700ms），实际 ${elapsed}ms`);
  // 关键断言：旧实现会在第一个请求完成后把 page.click 发出去 —— 那是「偷偷执行」。
  await (await slow);
  await sleep(300);
  const dispatchedClick = ext.received.some((r) => r.method === "page.click");
  assert.equal(dispatchedClick, false, "已超时的排队请求绝不能被派发（否则「以为失败」会变成「稍后偷偷点击」）");
  ext.close();
  await stopHost(h);
});

test("#3 客户端断开时取消尚未派发的请求（不让失败变成偷偷执行）", async () => {
  const home = tmpHome();
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port));
  const token = fs.readFileSync(path.join(home, ".chrome-agent-bridge", "token"), "utf8").trim();

  let first = true;
  const ext = await fakeExtension(h.port, token, async () => {
    if (first) { first = false; await sleep(600); }
    return { ok: true };
  });

  // 占住队列
  const blocker = httpReq(h.port, "POST", "/rpc", { method: "page.snapshot", params: { tabId: 2 }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });
  await sleep(80);

  // 发一个不可逆操作，然后在它排队期间直接断开（模拟 HTTP 客户端超时退出）
  const req = http.request({
    host: "127.0.0.1", port: h.port, path: "/rpc", method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  req.on("error", () => { /* 主动 destroy 会触发，忽略 */ });
  req.write(JSON.stringify({ method: "page.type", params: { tabId: 2, selector: "#x", text: "hi" }, timeoutMs: 30000 }));
  req.end();
  await sleep(120);
  req.destroy();     // 客户端走了

  await (await blocker);
  await sleep(300);
  const dispatched = ext.received.some((r) => r.method === "page.type");
  assert.equal(dispatched, false, "客户端已断开时，排队的不可逆操作必须被取消");
  ext.close();
  await stopHost(h);
});

test("#3 排队期间租约易主 → 派发前重查并拒绝（不再只在入队前查一次）", async () => {
  const home = tmpHome();
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port));
  const token = fs.readFileSync(path.join(home, ".chrome-agent-bridge", "token"), "utf8").trim();

  let first = true;
  const ext = await fakeExtension(h.port, token, async () => {
    if (first) { first = false; await sleep(600); }
    return { ok: true };
  });

  // agentA 持有 tab 5 的租约，并占住队列
  const claimA = await httpReq(h.port, "POST", "/tabs/claim", { tabId: 5, agentId: "agentA" }, { Authorization: `Bearer ${token}` });
  assert.equal(claimA.body.ok, true, JSON.stringify(claimA.body));
  const blocker = httpReq(h.port, "POST", "/rpc", { method: "page.snapshot", params: { tabId: 5 }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}`, "X-Agent-Id": "agentA" });
  await sleep(80);

  // 同一个 agent 排一个请求在队列里，然后让出/易主
  const queued = httpReq(h.port, "POST", "/rpc", { method: "page.click", params: { tabId: 5, selector: "#go" }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}`, "X-Agent-Id": "agentA" });
  await sleep(60);
  await httpReq(h.port, "POST", "/tabs/release", { tabId: 5, agentId: "agentA" }, { Authorization: `Bearer ${token}` });
  const claimB = await httpReq(h.port, "POST", "/tabs/claim", { tabId: 5, agentId: "agentB" }, { Authorization: `Bearer ${token}` });
  assert.equal(claimB.body.ok, true, JSON.stringify(claimB.body));

  const res = await queued;
  assert.equal(res.body.ok, false, "租约易主后，排队中的请求必须被拒绝");
  assert.equal(res.body.error.code, "TAB_LEASED", `应报 TAB_LEASED，实际 ${JSON.stringify(res.body.error)}`);
  await (await blocker);
  await sleep(250);
  assert.equal(ext.received.some((r) => r.method === "page.click"), false, "被租约拒绝的请求不得派发");
  ext.close();
  await stopHost(h);
});

// =====================================================================
// #2 agent.stop 必须真的停止（拦新请求 + 取消排队），而不是只广播
// =====================================================================

test("#2 agent.stop：拒绝后续 RPC（含只走 HTTP、没订阅事件的客户端）", async () => {
  const home = tmpHome();
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port));
  const token = fs.readFileSync(path.join(home, ".chrome-agent-bridge", "token"), "utf8").trim();
  const ext = await fakeExtension(h.port, token, async () => ({ ok: true }));

  const stopRes = await httpReq(h.port, "POST", "/agent/stop", { reason: "user" }, { Authorization: `Bearer ${token}` });
  assert.equal(stopRes.body.ok, true, JSON.stringify(stopRes.body));
  assert.equal(stopRes.body.result.stopped, true);
  assert.equal(stopRes.body.result.scope, "all");
  assert.match(stopRes.body.result.note, /无法撤销/, "必须说明「已完成的动作不能撤销」这个语义边界");

  // 旧的 /rpc 通道：以前它完全不知道用户按了停止
  const blocked = await httpReq(h.port, "POST", "/rpc", { method: "page.click", params: { tabId: 3, selector: "#pay" } }, { Authorization: `Bearer ${token}` });
  assert.equal(blocked.body.ok, false, "停止后必须拒绝新的页面操作");
  assert.equal(blocked.body.error.code, "AGENT_STOPPED");
  assert.equal(blocked.body.error.details.resumeWith, "agent.resume", "details 要给出恢复方式，Agent 才能自救");
  assert.equal(ext.received.some((r) => r.method === "page.click"), false, "被拦的请求绝不能到扩展");

  // 停止状态可查询（不依赖事件订阅）
  const st = await httpReq(h.port, "GET", "/status");
  assert.equal(st.body.stopped, true);
  assert.ok(Array.isArray(st.body.stops) && st.body.stops.length >= 1);

  // 只读操作不被拦：停止后仍要能看状态，否则 Agent 无法判断该不该恢复
  const read = await httpReq(h.port, "POST", "/rpc", { method: "tabs.list" }, { Authorization: `Bearer ${token}` });
  assert.equal(read.body.ok, true, "只读方法不应被停止闸门拦住");

  // 显式恢复后才放行
  const resume = await httpReq(h.port, "POST", "/agent/resume", {}, { Authorization: `Bearer ${token}` });
  assert.equal(resume.body.result.stopped, false);
  const after = await httpReq(h.port, "POST", "/rpc", { method: "page.click", params: { tabId: 3, selector: "#pay" } }, { Authorization: `Bearer ${token}` });
  assert.equal(after.body.ok, true, "恢复后应重新放行");
  ext.close();
  await stopHost(h);
});

test("#2 agent.stop：取消排队中尚未派发的请求，并如实报告已派发的数量", async () => {
  const home = tmpHome();
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port));
  const token = fs.readFileSync(path.join(home, ".chrome-agent-bridge", "token"), "utf8").trim();

  let first = true;
  const ext = await fakeExtension(h.port, token, async () => {
    if (first) { first = false; await sleep(500); }
    return { ok: true };
  });

  const blocker = httpReq(h.port, "POST", "/rpc", { method: "page.snapshot", params: { tabId: 7 }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });
  await sleep(80);
  const queued = httpReq(h.port, "POST", "/rpc", { method: "page.type", params: { tabId: 7, selector: "#a", text: "x" }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });
  await sleep(60);

  const stopRes = await httpReq(h.port, "POST", "/agent/stop", { reason: "user" }, { Authorization: `Bearer ${token}` });
  const r = stopRes.body.result;
  assert.equal(r.cancelledQueued, 1, `应取消 1 个排队请求，实际 ${r.cancelledQueued}`);
  assert.equal(r.inFlight, 1, `应报告 1 个已派发（无法撤回）的请求，实际 ${r.inFlight}`);
  assert.match(r.note, /已派发请求无法撤回/);

  const qres = await queued;
  assert.equal(qres.body.ok, false);
  assert.equal(qres.body.error.code, "AGENT_STOPPED", "排队请求应立刻收到停止错误，而不是等它排到队首");

  await (await blocker);
  await sleep(250);
  assert.equal(ext.received.some((x) => x.method === "page.type"), false, "被取消的排队请求不得派发");
  ext.close();
  await stopHost(h);
});

// =====================================================================
// 契约：host 与扩展的「停止拦什么」清单必须逐字一致
// =====================================================================
// 两个实现各拦一段：host 拦「还没派发的」，扩展拦「已派发但还没落到页面上的」。
// 清单一旦漂移就会出现「host 放行、扩展拒绝」这类极难定位的行为，所以把它固化成测试。
// 这里用文本提取而不是 require：background.js 是 MV3 service worker，依赖 chrome.*，
// 在 Node 里根本加载不起来。
test("契约: host 与 extension 的 SIDE_EFFECT_METHODS 完全一致", async () => {
  const hostSrc = fs.readFileSync(path.join(__dirname, "host.js"), "utf8");
  const extSrc = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");

  function extract(src, label) {
    const m = src.match(/SIDE_EFFECT_METHODS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(m, `${label} 里应能找到 SIDE_EFFECT_METHODS 定义`);
    const out = [];
    const re = /"([^"]+)"/g;
    let x;
    while ((x = re.exec(m[1])) !== null) out.push(x[1]);
    return out.sort();
  }

  const hostList = extract(hostSrc, "relay/host.js");
  const extList = extract(extSrc, "extension/background.js");
  assert.deepEqual(extList, hostList,
    `两侧副作用清单必须一致。仅 host 有: ${hostList.filter((x) => !extList.includes(x))}；仅扩展有: ${extList.filter((x) => !hostList.includes(x))}`);

  // 不可逆操作必须在里面
  for (const must of ["page.click", "page.type", "page.press", "page.navigate", "page.scroll", "tabs.create"]) {
    assert.ok(hostList.includes(must), `${must} 是有副作用的，必须被停止拦住`);
  }
  // 观察 / 释放 / 恢复类必须不在里面，否则停止会把桥自己锁死
  for (const mustNot of ["tabs.list", "tabs.get", "page.info", "page.snapshot", "page.evaluate",
    "bridge.status", "bridge.ping", "agent.resume", "agent.stopStatus",
    "session.attach", "session.detach", "tabs.close", "tabs.prepare", "extension.reload"]) {
    assert.ok(!hostList.includes(mustNot), `${mustNot} 是观察/释放/恢复类，不应被停止拦住（拦了会让桥卡死或资源泄漏）`);
  }

  // session.send 按 CDP method 细分：Input.* 是「点击/输入」，必须拦；
  // Runtime.* / 截图 是纯读取，必须放行（否则停止后 Agent 被盲住，连状态都看不了）。
  for (const src of [hostSrc, extSrc]) {
    assert.match(src, /BLOCKED_CDP_PREFIXES = \["Input\."\]/, "Input.* 必须被停止拦住（它就是「点击/输入」）");
    assert.match(src, /isBlockedCdpCall/, "session.send 必须按 CDP method 细分判定");
  }
});

test("#2 agent.stop 会转发给扩展（页面侧/已派发动作由扩展拦）", async () => {
  const home = tmpHome();
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port));
  const token = fs.readFileSync(path.join(home, ".chrome-agent-bridge", "token"), "utf8").trim();
  const ext = await fakeExtension(h.port, token, async () => ({ ok: true }));

  await httpReq(h.port, "POST", "/agent/stop", { reason: "user" }, { Authorization: `Bearer ${token}` });
  await sleep(150);
  const ev = ext.received.find((r) => r.event === "agent.stop");
  assert.ok(ev, "必须把 agent.stop 事件下发到扩展（host 只能拦未派发的）");

  // 扩展未连接时，host 侧停止仍必须生效 —— 这是「停止不能依赖桥可用」的核心
  ext.close();
  await sleep(200);
  const r2 = await httpReq(h.port, "POST", "/agent/resume", {}, { Authorization: `Bearer ${token}` });
  assert.equal(r2.body.ok, true, "扩展离线时 resume 也必须成功");
  await stopHost(h);
});

// =====================================================================
// #4 错误契约：保留 details，区分超时/断连/鉴权/业务错误
// =====================================================================

test("#2 经 RPC 发的 agent.resume 也必须清掉 host 侧状态（两条路径不能分叉）", async () => {
  const home = tmpHome();
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port));
  const token = fs.readFileSync(path.join(home, ".chrome-agent-bridge", "token"), "utf8").trim();
  const ext = await fakeExtension(h.port, token, async () => ({ ok: true }));

  // 用 HTTP 路由停
  await httpReq(h.port, "POST", "/agent/stop", { reason: "user" }, { Authorization: `Bearer ${token}` });
  // 用 RPC 恢复（端到端踩到的坑：RPC 路径以前只转发给扩展，host 的 stopState 不变，
  // 于是“resume 成功了但写操作还是被拦”）
  const res = await httpReq(h.port, "POST", "/rpc", { method: "agent.resume", params: {}, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(res.body.result.stopped, false);

  const st = await httpReq(h.port, "GET", "/status");
  assert.equal(st.body.stopped, false, "RPC resume 后 host 侧必须不再处于停止状态");
  const after = await httpReq(h.port, "POST", "/rpc", { method: "page.click", params: { tabId: 51, selector: "#x" }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });
  assert.equal(after.body.ok, true, "恢复后写操作必须放行（否则两条路径状态分叉）");
  ext.close();
  await stopHost(h);
});

test("#2 stopStatus 区分「有停止生效」与「本 tab 被拦」", async () => {
  const home = tmpHome();
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port));
  const token = fs.readFileSync(path.join(home, ".chrome-agent-bridge", "token"), "utf8").trim();

  await httpReq(h.port, "POST", "/agent/stop", { tabId: 61, reason: "user" }, { Authorization: `Bearer ${token}` });
  const forTab = await httpReq(h.port, "POST", "/rpc", { method: "agent.stopStatus", params: { tabId: 61 }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });
  assert.equal(forTab.body.result.stopped, true, "存在停止时应报 stopped=true");
  assert.equal(forTab.body.result.applicable, true, "当前 tab 应被拦");
  assert.equal(forTab.body.result.scope, "tab");

  const otherTab = await httpReq(h.port, "POST", "/rpc", { method: "agent.stopStatus", params: { tabId: 62 }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });
  assert.equal(otherTab.body.result.stopped, true, "全局看仍有停止在生效");
  assert.equal(otherTab.body.result.applicable, false, "但另一个 tab 不应被这个 tab 级停止拦住");
  await stopHost(h);
});

test("#2 session.send 按 CDP method 细分：Input.* 拦、Runtime.* 放行", async () => {
  const home = tmpHome();
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port));
  const token = fs.readFileSync(path.join(home, ".chrome-agent-bridge", "token"), "utf8").trim();
  const ext = await fakeExtension(h.port, token, async () => ({ ok: true }));

  await httpReq(h.port, "POST", "/agent/stop", { reason: "user" }, { Authorization: `Bearer ${token}` });

  // Input.* 就是「点击/输入」：必须拦
  const input = await httpReq(h.port, "POST", "/rpc", { method: "session.send", params: { tabId: 71, method: "Input.dispatchMouseEvent" }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });
  assert.equal(input.body.error.code, "AGENT_STOPPED", `Input.* 必须被拦，实际 ${JSON.stringify(input.body)}`);

  // Runtime.* 是纯读取：必须放行，否则停止后 Agent 被盲住（skill 的 ev 全走 CDP）
  const read = await httpReq(h.port, "POST", "/rpc", { method: "session.send", params: { tabId: 71, method: "Runtime.evaluate", params: { expression: "1" } }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });
  assert.equal(read.body.ok, true, `Runtime.evaluate 应放行，实际 ${JSON.stringify(read.body)}`);

  // 截图也是读
  const shot = await httpReq(h.port, "POST", "/rpc", { method: "session.send", params: { tabId: 71, method: "Page.captureScreenshot" }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });
  assert.equal(shot.body.ok, true, "截图应放行");
  ext.close();
  await stopHost(h);
});

test("#4 details 三层链路不丢（扩展 → host → HTTP 客户端）", async () => {
  const home = tmpHome();
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port));
  const token = fs.readFileSync(path.join(home, ".chrome-agent-bridge", "token"), "utf8").trim();

  const ext = await fakeExtension(h.port, token, async () => null, { manual: true });   // 先连上，再手工回错误
  await sleep(50);
  const pendingReq = httpReq(h.port, "POST", "/rpc", { method: "page.scroll", params: { tabId: 11, checked: true, expectGrowth: true }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });
  const req = await ext.ws.next();
  ext.ws.send({ id: req.id, ok: false, error: { code: "SCROLL_NO_GROWTH", message: "滚了但没加载出新内容", details: { atBottom: false, wasHidden: true, recoverable: true, grew: false } } });

  const res = await pendingReq;
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, "SCROLL_NO_GROWTH");
  assert.deepEqual(res.body.error.details, { atBottom: false, wasHidden: true, recoverable: true, grew: false },
    "HTTP 出口必须原样透传 details（历史 bug：被静默丢弃，Agent 只能解析 message 文本）");
  ext.close();
  await stopHost(h);
});

test("#4 details 在 WS /bridge 出口同样保留（两个出口契约一致）", async () => {
  const home = tmpHome();
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port));
  const token = fs.readFileSync(path.join(home, ".chrome-agent-bridge", "token"), "utf8").trim();

  const ext = await fakeExtension(h.port, token, async () => null, { manual: true });
  const agentWs = await wsConnect(h.port, "/bridge", token);
  await agentWs.next(); // hello
  agentWs.send({ id: "w1", method: "page.scroll", params: { tabId: 12 }, timeoutMs: 5000 });
  const req = await ext.ws.next();
  ext.ws.send({ id: req.id, ok: false, error: { code: "SCROLL_STALLED", message: "没动", details: { recoverable: false, moved: false } } });

  const res = await agentWs.next();
  assert.equal(res.ok, false);
  assert.deepEqual(res.error.details, { recoverable: false, moved: false }, "WS 出口不能比 HTTP 出口少信息");
  ext.close();
  agentWs.close();
  await stopHost(h);
});

test("#4 客户端：超时报 TIMEOUT（不再伪装成 CONNECTION_REFUSED）", async () => {
  const home = tmpHome();
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port));
  const token = fs.readFileSync(path.join(home, ".chrome-agent-bridge", "token"), "utf8").trim();
  const ext = await fakeExtension(h.port, token, async () => null, { manual: true });   // 永不响应

  const bridge = new Bridge({ port: h.port, token, timeoutMs: 400, agentId: "t-timeout" });
  const err = await bridge.rpc("page.snapshot", { tabId: 21 }).catch((e) => e);
  assert.equal(err.code, "TIMEOUT", `本地请求超时必须报 TIMEOUT，实际 ${err.code}：${err.message}`);
  assert.ok(err instanceof BridgeTimeoutError, "应能用 instanceof 判断超时");
  assert.notEqual(err.code, "CONNECTION_REFUSED", "超时不是连接失败——旧代码把排查方向带偏到「请启动桥」");
  ext.close();
  await stopHost(h);
});

test("#4 客户端：连不上才是 CONNECTION_REFUSED；业务错误保留 details", async () => {
  const deadPort = await pickFreePort();
  const bridge = new Bridge({ port: deadPort, token: "x", timeoutMs: 500, agentId: "t-refused" });
  const refused = await bridge.rpc("tabs.list").catch((e) => e);
  assert.equal(refused.code, "CONNECTION_REFUSED");
  assert.ok(refused instanceof BridgeError);

  // 业务错误：details 必须到客户端手里
  const home = tmpHome();
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port));
  const token = fs.readFileSync(path.join(home, ".chrome-agent-bridge", "token"), "utf8").trim();
  const ext = await fakeExtension(h.port, token, async () => null, { manual: true });
  const b2 = new Bridge({ port: h.port, token, timeoutMs: 5000, agentId: "t-details" });
  const p = b2.rpc("page.scroll", { tabId: 22 }).catch((e) => e);
  const req = await ext.ws.next();
  ext.ws.send({ id: req.id, ok: false, error: { code: "SCROLL_NO_GROWTH", message: "no growth", details: { recoverable: true, atBottom: false } } });
  const e2 = await p;
  assert.equal(e2.code, "SCROLL_NO_GROWTH");
  assert.equal(e2.detail("recoverable"), true, "client.mjs 必须能读到 details（历史 bug：只保留 code/message）");
  ext.close();
  await stopHost(h);
});

test("#4 客户端：鉴权失败报 UNAUTHORIZED（不是业务错误或连接失败）", async () => {
  const home = tmpHome();
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port));
  const bridge = new Bridge({ port: h.port, token: "definitely-wrong-token", timeoutMs: 3000, agentId: "t-auth" });
  const err = await bridge.rpc("tabs.list").catch((e) => e);
  assert.equal(err.code, "UNAUTHORIZED");
  await stopHost(h);
});

test("#4 客户端：register/claim/release 用 POST（旧代码把它们发成 GET → 404）", async () => {
  const home = tmpHome();
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port));
  const token = fs.readFileSync(path.join(home, ".chrome-agent-bridge", "token"), "utf8").trim();
  const bridge = new Bridge({ port: h.port, token, timeoutMs: 3000, agentId: "t-post" });

  const reg = await bridge.register("post-test");
  assert.equal(reg.ok, true, `register 应成功（POST），实际 ${JSON.stringify(reg)}`);
  const claim = await bridge.claimTab(31, 30000);
  assert.equal(claim.ok, true, `claimTab 应成功（POST），实际 ${JSON.stringify(claim)}`);
  const rel = await bridge.releaseTab(31);
  assert.equal(rel.ok, true, `releaseTab 应成功（POST），实际 ${JSON.stringify(rel)}`);
  await stopHost(h);
});

test("#4 客户端：stop/resume 走独立路由（扩展离线时也能停）", async () => {
  const home = tmpHome();
  const h = await startHost({ home });
  assert.ok(await waitReady(h.port));
  const token = fs.readFileSync(path.join(home, ".chrome-agent-bridge", "token"), "utf8").trim();
  const bridge = new Bridge({ port: h.port, token, timeoutMs: 3000, agentId: "t-stop" });

  const s = await bridge.stop(null, { reason: "test" });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(s.result.stopped, true);
  const blocked = await bridge.rpc("page.click", { tabId: 41, selector: "#x" }).catch((e) => e);
  assert.equal(blocked.code, "AGENT_STOPPED");
  const r = await bridge.resume(null);
  assert.equal(r.result.stopped, false);
  await stopHost(h);
});
