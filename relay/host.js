#!/usr/bin/env node
// Agent Browser Bridge - Local Host
// 双角色（参考 ChatGPT/Claude 插件的 native host 设计）：
//   1. Native Messaging Host：由 Chrome 拉起，通过 stdio(4字节长度+JSON) 与扩展通信
//   2. 本地服务：127.0.0.1 上的 HTTP + WebSocket，供本地 Agent 调用
// 用法：
//   node host.js                # 由 Chrome 以 native host 方式拉起（stdio）
//   node host.js --standalone   # 手动运行（无扩展时也能启动，等扩展 WS 连入）
//   node host.js --port 8778 --token auto
"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { attachWsServer, WSConnection } = require("./ws-server");

const VERSION = "0.2.0";
const HOST_NAME = "com.agentbrowser.bridge";
const STATE_DIR = path.join(os.homedir(), ".chrome-agent-bridge");
const TOKEN_FILE = path.join(STATE_DIR, "token");
const LOG_FILE = path.join(STATE_DIR, "host.log");

const args = process.argv.slice(2);
const STANDALONE = args.includes("--standalone") || process.stdin.isTTY;
const PORT = (() => {
  const i = args.findIndex((a) => a === "--port");
  if (i !== -1 && args[i + 1]) return Number(args[i + 1]);
  const env = process.env.AGENT_BRIDGE_PORT;
  return env ? Number(env) : 8778;
})();

// ---------- 日志 ----------
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) { /* noop */ }
  if (STANDALONE) console.log(line);
}

// ---------- Token ----------
function ensureToken() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
      if (t) return t;
    }
    const token = crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    return token;
  } catch (e) {
    return "dev";
  }
}
const TOKEN = ensureToken();

// ---------- 扩展通道抽象 ----------
// 优先 native port，fallback 到 WS(/agent)
let nativePort = null;   // { send, postMessage, onDisconnect }
let extWs = null;        // WSConnection (扩展 ws 通道)
let agentWss = [];       // Agent 的 ws 订阅连接
const pending = new Map(); // requestId -> { resolve, reject, timer }

function nativeReady() { return !!(nativePort && nativePort.ready); }
function extReady() { return nativeReady() || !!(extWs && !extWs.closed); }

function genRequestId() {
  return crypto.randomUUID();
}

// 向扩展发一个 RPC，返回 Promise
// 扩展 MV3 service worker 会休眠导致 WS 短暂断开：未连接时先等待其重连（alarms 保活会唤醒）
async function requestExtension(method, params, timeoutMs = 60000) {
  if (!extReady()) {
    const waited = await new Promise((resolve) => {
      const start = Date.now();
      const t = setInterval(() => {
        if (extReady()) { clearInterval(t); resolve(true); }
        else if (Date.now() - start > 12000) { clearInterval(t); resolve(false); }
      }, 250);
    });
    if (!waited) {
      throw { code: "EXT_DISCONNECTED", message: "扩展未连接（请确认扩展已加载并开启）" };
    }
  }
  const requestId = genRequestId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject({ code: "TIMEOUT", message: `扩展响应超时(${timeoutMs}ms): ${method}` });
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer, method });

    try {
      if (nativeReady()) {
        nativePort.postMessage({ type: "request", requestId, method, params: params || {} });
      } else if (extWs && !extWs.closed) {
        extWs.sendJson({ id: requestId, method, params: params || {} });
      } else {
        clearTimeout(timer);
        pending.delete(requestId);
        reject({ code: "EXT_DISCONNECTED", message: "扩展连接在请求发出前断开，请重试" });
      }
    } catch (e) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject({ code: "SEND_FAILED", message: String(e) });
    }
  });
}

function resolvePending(requestId, payload) {
  const p = pending.get(requestId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(requestId);
  p.resolve(payload);
}

function rejectPending(requestId, error) {
  const p = pending.get(requestId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(requestId);
  p.reject({ code: (error && error.code) || "EXT_ERROR", message: (error && error.message) || String(error) });
}

// 向 Agent 广播事件（ws 订阅者）
function broadcastToAgent(event, payload) {
  const msg = JSON.stringify({ type: "event", event, payload: payload || null });
  for (const ws of agentWss) {
    if (!ws.closed) ws.sendText(msg);
  }
}

// 向扩展发事件（如 agent.stop）
function sendEventToExtension(event, payload) {
  try {
    if (nativeReady()) {
      nativePort.postMessage({ type: "event", event, payload: payload || null });
    } else if (extWs && !extWs.closed) {
      extWs.sendJson({ type: "event", event, payload: payload || null });
    }
  } catch (e) { /* noop */ }
}

// ---------- Native Messaging（stdio） ----------
function setupNativeMessaging() {
  let buffer = Buffer.alloc(0);
  let expectedLength = -1;

  process.stdin.on("readable", () => {
    let chunk;
    while ((chunk = process.stdin.read()) !== null) {
      buffer = Buffer.concat([buffer, chunk]);
      if (expectedLength === -1 && buffer.length >= 4) {
        expectedLength = buffer.readUInt32LE(0);
        buffer = buffer.slice(4);
      }
      if (expectedLength !== -1 && buffer.length >= expectedLength) {
        const msgBuf = buffer.slice(0, expectedLength);
        buffer = buffer.slice(expectedLength);
        expectedLength = -1;
        try {
          handleNativeMessage(JSON.parse(msgBuf.toString("utf8")));
        } catch (e) {
          log("native parse error:", e.message);
        }
      }
    }
  });

  process.stdin.on("end", () => {
    log("native channel closed by Chrome");
    nativePort = null;
    // Chrome 关闭连接后进程即将退出；standalone 时继续存活
    if (!STANDALONE) {
      setTimeout(() => process.exit(0), 500);
    }
  });
  process.stdin.on("error", () => { /* noop */ });
}

function writeNative(obj) {
  const buf = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([header, buf]));
}

function handleNativeMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  // 扩展 hello
  if (msg.type === "hello") {
    nativePort = {
      ready: true,
      postMessage: (obj) => writeNative(obj),
      onDisconnect: () => { nativePort = null; },
    };
    log("extension connected via native messaging:", msg.name || msg.client, msg.version || "");
    writeNative({
      type: "hello",
      host: HOST_NAME,
      version: VERSION,
      token: TOKEN,
      port: PORT,
      auth: "token",
    });
    broadcastToAgent("ext.connected", { channel: "native" });
    return;
  }
  // 扩展 ping
  if (msg.type === "ping") {
    writeNative({ type: "pong", t: Date.now() });
    return;
  }
  // RPC 响应
  if (msg.type === "response" && msg.responseToRequestId) {
    if (msg.error) rejectPending(msg.responseToRequestId, msg.error);
    else resolvePending(msg.responseToRequestId, msg.payload);
    return;
  }
  // 扩展上报事件（如 agent.stop 确认）
  if (msg.type === "event") {
    broadcastToAgent(msg.event, msg.payload);
    return;
  }
}

// ---------- HTTP ----------
function httpServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const auth = req.headers["authorization"] || "";
    const authed = auth === `Bearer ${TOKEN}`;

    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(body);
    };

    // 未鉴权的敏感路由一律 401
    if (url.pathname !== "/status" && !authed) {
      send(401, { ok: false, error: { code: "UNAUTHORIZED", message: "缺少或错误 Bearer token（见 ~/.chrome-agent-bridge/token）" } });
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      send(200, {
        ok: true,
        name: HOST_NAME,
        version: VERSION,
        channel: nativeReady() ? "native" : (extWs && !extWs.closed ? "ws" : "disconnected"),
        extConnected: extReady(),
        pending: pending.size,
        uptimeSec: Math.round(process.uptime()),
        pid: process.pid,
        port: PORT,
        tokenPrefix: TOKEN.slice(0, 6),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/rpc") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 8 * 1024 * 1024) req.destroy(); });
      req.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body || "{}"); } catch (e) {
          return send(400, { ok: false, error: { code: "BAD_JSON", message: "请求体不是合法 JSON" } });
        }
        const method = parsed.method;
        const params = parsed.params || {};
        const timeoutMs = parsed.timeoutMs || 60000;
        if (!method) return send(400, { ok: false, error: { code: "BAD_PARAMS", message: "缺少 method" } });
        requestExtension(method, params, timeoutMs)
          .then((result) => send(200, { ok: true, result: result === undefined ? null : result }))
          .catch((e) => send(200, { ok: false, error: { code: e.code || "INTERNAL", message: e.message || String(e) } }));
      });
      return;
    }

    send(404, { ok: false, error: { code: "NOT_FOUND", message: url.pathname } });
  });

  // WS：/agent 扩展通道（fallback），/bridge Agent 订阅通道
  attachWsServer(server, [
    {
      path: "/agent",
      token: TOKEN,
      onConnection(ws) {
        extWs = ws;
        log("extension connected via ws /agent");
        ws.sendJson({ type: "hello", host: HOST_NAME, version: VERSION });
        broadcastToAgent("ext.connected", { channel: "ws" });
        ws.on("message", (text) => {
          let msg;
          try { msg = JSON.parse(text); } catch (e) { return; }
          if (msg.type === "hello" || msg.type === "ping" || msg.type === "pong") return;
          if (msg.type === "event") {
            broadcastToAgent(msg.event, msg.payload);
            return;
          }
          if (msg.id !== undefined && msg.method) {
            // 扩展主动发起的请求（目前不使用），仅响应错误
            ws.sendJson({ id: msg.id, ok: false, error: { code: "NOT_SUPPORTED", message: "扩展不应主动发起请求" } });
            return;
          }
          if (msg.id !== undefined) {
            // RPC 响应（来自扩展对 /agent 请求的应答）
            if (msg.ok) resolvePending(msg.id, msg.result);
            else rejectPending(msg.id, msg.error);
          }
        });
        ws.on("close", () => {
          if (extWs === ws) {
            extWs = null;
            log("extension ws /agent disconnected");
            broadcastToAgent("ext.disconnected", {});
          }
        });
      },
    },
    {
      path: "/bridge",
      token: TOKEN,
      onConnection(ws) {
        agentWss.push(ws);
        log("agent connected via ws /bridge");
        ws.sendJson({ type: "hello", host: HOST_NAME, version: VERSION, extConnected: extReady() });
        ws.on("message", (text) => {
          let msg;
          try { msg = JSON.parse(text); } catch (e) { return; }
          if (msg.id !== undefined && msg.method) {
            const requestId = String(msg.id);
            const timeoutMs = msg.timeoutMs || 60000;
            requestExtension(msg.method, msg.params || {}, timeoutMs)
              .then((result) => ws.sendJson({ id: requestId, ok: true, result: result === undefined ? null : result }))
              .catch((e) => ws.sendJson({ id: requestId, ok: false, error: { code: e.code || "INTERNAL", message: e.message || String(e) } }));
          }
        });
        ws.on("close", () => {
          agentWss = agentWss.filter((w) => w !== ws);
        });
      },
    },
  ]);

  server.listen(PORT, "127.0.0.1", () => {
    log(`listening on http://127.0.0.1:${PORT}  token=${TOKEN.slice(0, 6)}…  ext=${extReady() ? "connected" : "waiting"}`);
    if (STANDALONE) {
      console.log(`\n  Agent Browser Bridge host v${VERSION}`);
      console.log(`  状态: curl http://127.0.0.1:${PORT}/status`);
      console.log(`  Token: ${TOKEN}  (保存于 ${TOKEN_FILE})`);
      console.log(`  Agent 通道: HTTP /rpc · WS /bridge\n`);
    }
  });
  server.on("error", (e) => {
    log("http server error:", e.message);
    if (e.code === "EADDRINUSE") {
      log(`端口 ${PORT} 已被占用（可能 host 已在运行）`);
      if (!STANDALONE) process.exit(0);
    }
  });
}

// ---------- 启动 ----------
// 单连接异常（ECONNRESET 等）不应拖垮整个桥：记录并继续服务
process.on("uncaughtException", (e) => {
  log("uncaughtException:", e && e.message, (e && e.stack || "").split("\n")[1] || "");
});
process.on("unhandledRejection", (e) => {
  log("unhandledRejection:", e && e.message);
});
log(`host v${VERSION} start, standalone=${STANDALONE}, port=${PORT}`);
setupNativeMessaging();
httpServer();

// 定期清理超时 pending
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of pending) {
    if (p.timer && now - p.timer._idleStart > 90000) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject({ code: "TIMEOUT", message: `扩展响应超时: ${p.method}` });
    }
  }
}, 30000).unref();
