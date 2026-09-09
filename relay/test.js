// Agent Browser Bridge - 集成测试（零依赖）
// 覆盖：host 启动、token 鉴权、HTTP /rpc、WS /agent（模拟扩展）、WS /bridge（agent 订阅）
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 8899; // 测试用独立端口，避免与正式 host 冲突
const TOKEN_FILE = path.join(os.homedir(), ".chrome-agent-bridge", "token");

// token 在 host 首次启动时生成，因此延迟到 host 就绪后读取
function readToken() {
  return fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, "utf8").trim() : "test-token";
}

let passed = 0;
let failed = 0;
let hostOut = "";
process.on("unhandledRejection", (e) => {
  console.error("\n!! unhandledRejection:", e && e.message || e);
  console.error("--- host 输出 ---\n" + hostOut.slice(-3000));
  process.exit(1);
});
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? "  -> " + JSON.stringify(extra) : ""}`); }
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

// 极简 WS 客户端（Node 22 全局 WebSocket 不可用时的手写实现）
function wsConnect(port, pathname, token) {
  return new Promise((resolve, reject) => {
    const net = require("net");
    const crypto = require("crypto");
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
    const listeners = [];

    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString();
        buf = buf.slice(idx + 4);
        handshakeDone = true;
        if (!head.includes("101")) { sock.destroy(); return reject(new Error("handshake failed: " + head.split("\n")[0])); }
        resolve(client);
      }
      // 解析帧（服务端不 mask）
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
          const text = payload.toString();
          if (pending.length) pending.shift()(JSON.parse(text));
          else listeners.forEach((l) => l(JSON.parse(text)));
        } else if (opcode === 8) { sock.destroy(); }
      }
    });

    const client = {
      send(obj) {
        const data = Buffer.from(JSON.stringify(obj), "utf8");
        let header;
        if (data.length < 126) header = Buffer.from([0x81, data.length]);
        else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2); }
        else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
        sock.write(Buffer.concat([header, data]));
      },
      next() { return new Promise((res) => pending.push(res)); },
      onMessage(fn) { listeners.push(fn); },
      close() { sock.destroy(); },
    };
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log("== Agent Browser Bridge 集成测试 ==");

  // 1. 启动 host（standalone）
  const host = spawn(process.execPath, [path.join(__dirname, "host.js"), "--standalone", "--port", String(PORT)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENT_BRIDGE_PORT: String(PORT) },
  });
  hostOut = "";
  host.stdout.on("data", (d) => { hostOut += d; });
  host.stderr.on("data", (d) => { hostOut += d; });

  // 等端口就绪
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const s = await httpReq(PORT, "GET", "/status");
      if (s.status === 200) { ready = true; break; }
    } catch (e) { /* retry */ }
    await sleep(250);
  }
  ok("host 启动并监听 /status", ready);
  const token = readToken();

  // 2. 鉴权：敏感 API 必须携带正确 token
  const noAuth = await httpReq(PORT, "POST", "/rpc", { method: "tabs.list" });
  ok("无 token 访问 /rpc 返回 401", noAuth.status === 401, noAuth.status);
  const badAuth = await httpReq(PORT, "POST", "/rpc", { method: "tabs.list" }, { Authorization: "Bearer wrong" });
  ok("错误 token 访问 /rpc 返回 401", badAuth.status === 401, badAuth.status);

  // 3. 无扩展时 /rpc 报 EXT_DISCONNECTED
  const noExt = await httpReq(PORT, "POST", "/rpc", { method: "tabs.list" }, { Authorization: `Bearer ${token}` });
  ok("无扩展时 /rpc 返回 EXT_DISCONNECTED", noExt.body && noExt.body.ok === false && noExt.body.error.code === "EXT_DISCONNECTED", noExt.body);

  // 4. 模拟扩展通过 WS /agent 连入
  const extWs = await wsConnect(PORT, "/agent", token);
  ok("扩展 ws /agent 握手成功", !!extWs);
  const hello = await extWs.next();
  ok("收到 host hello", hello.type === "hello" && hello.host === "com.agentbrowser.bridge", hello);

  // 5. 扩展响应一个 RPC（模拟 tabs.list；ws 通道为 JSON-RPC 格式）
  const rpcPromise = httpReq(PORT, "POST", "/rpc", { method: "tabs.list" }, { Authorization: `Bearer ${token}` });
  const extReq = await extWs.next();
  ok("host 转发 RPC 给扩展", extReq.method === "tabs.list", extReq);
  extWs.send({ id: extReq.id, ok: true, result: { tabs: [{ id: 1, title: "fake", url: "https://example.com" }] } });
  const rpcRes = await rpcPromise;
  ok("RPC 响应回传 Agent", rpcRes.body.ok === true && rpcRes.body.result.tabs[0].title === "fake", rpcRes.body);

  // 6. 扩展上报事件 → agent ws 订阅收到
  const agentWs = await wsConnect(PORT, "/bridge", token);
  await agentWs.next(); // hello
  const sub = agentWs.next();
  extWs.send({ type: "event", event: "agent.stop", payload: { from: "test" } });
  const ev = await sub;
  ok("agent 订阅收到扩展事件", ev.type === "event" && ev.event === "agent.stop", ev);

  // 7. 扩展 RPC 报错传播
  const errPromise = httpReq(PORT, "POST", "/rpc", { method: "page.click" }, { Authorization: `Bearer ${token}` });
  const errReq = await extWs.next();
  extWs.send({ id: errReq.id, ok: false, error: { code: "BAD_PARAMS", message: "缺少 tabId" } });
  const errRes = await errPromise;
  ok("扩展错误传播给 Agent", errRes.body.ok === false && errRes.body.error.code === "BAD_PARAMS", errRes.body);

  extWs.close();
  agentWs.close();
  host.kill();

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log("--- host 输出 ---\n" + hostOut.slice(-2000));
    process.exit(1);
  }
}

main().catch((e) => { console.error("测试异常:", e); process.exit(1); });
