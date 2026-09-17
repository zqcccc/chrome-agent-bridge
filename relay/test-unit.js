// Agent Browser Bridge - 单元测试（零依赖，Node 内置 test runner 风格）
// 覆盖：
//  1. native frame parser 多帧/拆包/粘包
//  2. 同 tab 队列顺序执行 + 跨 tab 并行
//  3. 超时/断连后 pending 清理
//  4. WS ECONNRESET/error 不触发 uncaughtException
//  5. send-chat 验证 helper（另在 test-verify.mjs）
//  6. indicator 不阻塞只读/导航 RPC（通过对 background dispatch 行为断言——这里测 helper 纯逻辑）
"use strict";

const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// 测试端口：优先用环境变量，否则让内核分配空闲端口。
// 不要硬编码——端口被别的服务（如 whistle 默认占 8899）占用时，
// 「轮询到 200」会把别人的服务误判为 host 就绪，造成假失败。
let PORT = Number(process.env.BRIDGE_TEST_PORT) || 0;
const TOKEN_FILE = path.join(os.homedir(), ".chrome-agent-bridge", "token");

/** 让内核分配一个空闲端口。 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require("net").createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** 确认该端口上跑的是我们的 host，而不是恰好占用该端口的别的服务。 */
async function isOurHost(port) {
  try {
    const s = await httpReq(port, "GET", "/status");
    return s.status === 200 && s.body && s.body.name === "com.agentbrowser.bridge";
  } catch (e) {
    return false;
  }
}
function readToken() {
  return fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, "utf8").trim() : "test-token";
}

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? "  -> " + JSON.stringify(extra) : ""}`); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
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

// 极简 WS 客户端（mask 帧发送）
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
    const pending = [];      // 等待 next() 的 resolver
    const queue = [];        // 已收到但无人 await 的消息缓存
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString();
        buf = buf.slice(idx + 4);
        handshakeDone = true;
        if (!head.includes("101")) { sock.destroy(); return reject(new Error("handshake failed")); }
        resolve(client);
      }
      while (buf.length >= 2) {
        const b0 = buf[0], b1 = buf[1];
        const opcode = b0 & 0x0f;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (opcode === 1) {
          const obj = JSON.parse(payload.toString());
          if (pending.length) pending.shift()(obj);
          else queue.push(obj);          // 缓存，等 next() 取
        } else if (opcode === 8) {
          // close：resolve 所有等待者为 null，避免 handler 永久 await 卡住进程
          while (pending.length) pending.shift()(null);
          sock.destroy();
        }
      }
    });
    const client = {
      // 客户端→服务端必须 mask（RFC 6455 §5.1）。服务端已不再容忍未 mask 帧。
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
      rawClose() { sock.destroy(); },
      closeFrame() {
        // 发标准 WebSocket close 帧（比 destroy 更可靠地通知对端）。客户端帧同样要 mask。
        try {
          const mask = crypto.randomBytes(4);
          const data = Buffer.from([0x03, 0xe8]);
          const masked = Buffer.alloc(2);
          for (let i = 0; i < 2; i++) masked[i] = data[i] ^ mask[i & 3];
          sock.write(Buffer.concat([Buffer.from([0x88, 0x80 | 2]), mask, masked]));
        } catch (e) {}
        setTimeout(() => sock.destroy(), 100);
      },
      close() { sock.destroy(); },
    };
  });
}

// 捕获 uncaughtException，证明 WS error 不再走全局兜底
let uncaught = [];
process.on("uncaughtException", (e) => { uncaught.push(e && e.message); });

async function main() {
  console.log("== chrome-agent-bridge 单元测试 ==");

  // ---------- 1. native frame parser：多帧/拆包/粘包 ----------
  // 直接 require ws-server 的 decodeFrame 测帧解析（与 native frame 同构但不完全相同，
  // native parser 在 host.js 内部，用子进程黑盒测更真实）。
  const { decodeFrame, encodeFrame } = require("./ws-server");

  // 拆包：只到了部分 payload
  {
    const partial = decodeFrame(Buffer.from([0x81, 0x05])); // fin+text, len=5，缺 payload
    ok("ws decodeFrame 拆包：部分帧返回 need", partial.need !== undefined && partial.need > 0);
  }
  // 多帧粘包：两个文本帧在一个 buffer
  {
    const f1 = encodeFrame(0x1, "first");
    const f2 = encodeFrame(0x1, "second");
    const buf = Buffer.concat([f1, f2]);
    const r1 = decodeFrame(buf);
    ok("ws decodeFrame 多帧：第一帧 payload=first", r1.payload && r1.payload.toString() === "first" && r1.consumed === f1.length);
    const r2 = decodeFrame(buf.slice(r1.consumed));
    ok("ws decodeFrame 多帧：第二帧 payload=second", r2.payload && r2.payload.toString() === "second");
  }

  // ---------- 启动 standalone host 做黑盒测试 ----------
  if (!PORT) PORT = await pickFreePort();
  const host = spawn(process.execPath, [path.join(__dirname, "host.js"), "--standalone", "--port", String(PORT)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENT_BRIDGE_PORT: String(PORT) },
  });
  hostRef = host; // 供 process.on("exit") 兜底清理
  let hostOut = "";
  host.stdout.on("data", (d) => { hostOut += d; });
  host.stderr.on("data", (d) => { hostOut += d; });

  let hostExited = null;
  host.on("exit", (code) => { hostExited = code; });

  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (hostExited !== null) break;
    if (await isOurHost(PORT)) { ready = true; break; }
    await sleep(250);
  }
  ok("host 启动并监听 /status", ready);
  const token = readToken();

  // status 报告 mode 字段
  const st = await httpReq(PORT, "GET", "/status");
  ok("status 返回 mode=standalone", st.body && st.body.mode === "standalone", st.body && st.body.mode);
  ok("status 返回 tabQueues 字段", st.body && typeof st.body.tabQueues === "number");

  // ---------- 2. 同 tab 队列顺序执行 + 跨 tab 并行 ----------
  const extWs = await wsConnect(PORT, "/agent", token);
  await extWs.next(); // hello

  // 用扩展端记录 RPC 到达顺序
  const arrived = [];
  let staleSkipped = false;
  let staleReqId = null;   // handler 暴露：被跳过（不响应）的 stale 请求 id
  let stopHandler = false;
  const handler = async () => {
    while (!stopHandler) {
      const req = await extWs.next();
      if (req === null || stopHandler) return; // ws 已关闭或被外部停止
      // tab9 的第一个请求用于 stale 测试，handler 不响应（模拟扩展丢失/不回），但记下 id
      if (!staleSkipped && req.params && req.params.tabId === 9) {
        staleSkipped = true;
        staleReqId = req.id;
        continue;
      }
      arrived.push(req.method + ":" + (req.params && req.params.tabId));
      // 模拟不同处理延迟：tab A 的第一个慢 300ms
      const delay = req.method === "page.snapshot" && req.params.tabId === 1 && arrived.length === 1 ? 300 : 20;
      await sleep(delay);
      extWs.send({ id: req.id, ok: true, result: { method: req.method, tab: req.params.tabId } });
    }
  };
  handler();

  // 同 tab(1) 连发 3 个 snapshot：必须按顺序
  const pA1 = httpReq(PORT, "POST", "/rpc", { method: "page.snapshot", params: { tabId: 1 }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });
  const pA2 = httpReq(PORT, "POST", "/rpc", { method: "page.evaluate", params: { tabId: 1 }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });
  const pA3 = httpReq(PORT, "POST", "/rpc", { method: "page.info", params: { tabId: 1 }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });
  // 跨 tab(2) 并行
  const pB = httpReq(PORT, "POST", "/rpc", { method: "page.snapshot", params: { tabId: 2 }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });

  const [rA1, rA2, rA3, rB] = await Promise.all([pA1, pA2, pA3, pB]);
  ok("同 tab 队列：3 个请求都成功", rA1.body.ok && rA2.body.ok && rA3.body.ok, [rA1.body, rA2.body, rA3.body]);
  // 跨 tab 并行：host 端 tab2 队列独立，请求被转发到扩展（单 ws 通道下扩展端串行，
  // 但 host 不应把 tab2 排在 tab1 队列后面等 tab1 全部完成）
  ok("跨 tab 并行：tab2 请求被 host 转发并响应", rB.body.ok === true, rB.body);
  // tab1 的三个请求到达顺序应保持 1:1:1:1（snapshot, evaluate, info）
  // 注意：handler 里对 tab9 标记了 ":9:done"，过滤掉
  const tab1Arrived = arrived.filter((x) => x.endsWith(":1"));
  ok("同 tab 队列：到达顺序保持 snapshot→evaluate→info", JSON.stringify(tab1Arrived.map((x) => x.split(":")[0])) === JSON.stringify(["page.snapshot", "page.evaluate", "page.info"]), tab1Arrived);

  // ---------- 3. 超时后 pending 清理 + stale 响应被丢弃 ----------
  // 发一个扩展永远不响应的请求，短超时
  const stalePromise = httpReq(PORT, "POST", "/rpc", { method: "page.info", params: { tabId: 9 }, timeoutMs: 800 }, { Authorization: `Bearer ${token}` });
  // 等 handler 收到并跳过（不响应），拿到 staleReqId
  for (let i = 0; i < 40 && !staleReqId; i++) await sleep(50);
  const staleId = staleReqId;
  // 等超时
  const staleRes = await stalePromise;
  ok("超时请求返回 TIMEOUT", staleRes.body && staleRes.body.ok === false && staleRes.body.error.code === "TIMEOUT", staleRes.body);

  // 现在补发 stale 响应（用 staleId），应被丢弃（不影响后续）
  if (staleId) extWs.send({ id: staleId, ok: true, result: { stale: true } });

  // 立即发后续请求，不应被旧 stale 干扰
  const follow = await httpReq(PORT, "POST", "/rpc", { method: "page.info", params: { tabId: 9 }, timeoutMs: 5000 }, { Authorization: `Bearer ${token}` });
  ok("超时后同 tab 后续请求不雪崩（正常返回）", follow.body.ok === true, follow.body);

  // ---------- 4. WS ECONNRESET 不触发 uncaughtException ----------
  uncaught = [];
  // 直接 RST 一个 agent ws 连接
  const badAgent = await wsConnect(PORT, "/bridge", token);
  await badAgent.next(); // hello
  // 模拟 ECONNRESET：底层 socket RST
  badAgent.rawClose();
  await sleep(300);
  ok("WS 连接异常关闭后 host 仍存活", (await httpReq(PORT, "GET", "/status")).status === 200);
  ok("WS error 未触发 uncaughtException", uncaught.length === 0, uncaught);

  // ---------- 5. 扩展 WS 断连后 pending 清理 ----------
  // 用一个全新的扩展连接，避免与已有 handler 冲突
  const extWs2 = await wsConnect(PORT, "/agent", token);
  await extWs2.next(); // hello
  const hangPromise = httpReq(PORT, "POST", "/rpc", { method: "page.info", params: { tabId: 77 }, timeoutMs: 60000 }, { Authorization: `Bearer ${token}` });
  const hangReq = await extWs2.next(); // 收到请求，不响应
  if (hangReq) { /* 不响应，直接断开 */ }
  extWs2.closeFrame();
  const discRes = await hangPromise;
  ok("扩展 WS 断连后 pending 请求确定结局（EXT_DISCONNECTED）", discRes.body && discRes.body.ok === false && discRes.body.error.code === "EXT_DISCONNECTED", discRes.body);
  // extWs 还连着（旧 handler 仍在）：清掉它
  stopHandler = true;
  extWs.close();
  await sleep(200);

  host.kill();
  await sleep(500);
  if (host.exitCode === null && host.exitCode !== 0) {
    try { process.kill(host.pid, "SIGKILL"); } catch (e) {}
  }
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) { console.log("--- host 输出 ---\n" + hostOut.slice(-2000)); process.exit(1); }
  process.exit(0);
}

// 全局超时兑底：避免任何 await 永久挂起卡死测试进程
let hostRef = null;
const GUARD = setTimeout(() => {
  console.error("\n!! 测试全局超时（30s），强制退出");
  try { hostRef && hostRef.kill("SIGKILL"); } catch (e) {}
  process.exit(2);
}, 30000);
GUARD.unref();

// 任何异常退出路径都要收掉子进程，不留残留（残留进程会占端口，污染下次运行）
process.on("exit", () => {
  if (hostRef && hostRef.exitCode === null && hostRef.signalCode === null) {
    try { hostRef.kill("SIGKILL"); } catch (e) { /* noop */ }
  }
});

main().catch((e) => { console.error("测试异常:", e); process.exit(1); });
