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
const pending = new Map(); // requestId -> { resolve, reject, timer, method, tabId, startedAt, channel }

// 同一 tab 的 page.* 请求严格串行队列；跨 tab 并行。
// 目的：BOSS 重型 SPA 下同 tab 的 navigate/snapshot/evaluate 互相堆积导致 Host 超时。
const tabQueues = new Map(); // tabId -> { running: bool, queue: [{run, method}] }
const TAB_BUSY_RECOVERY_MS = 500; // tab 标记 unhealthy 后，下次请求先等恢复窗口（短，防雪崩但不长阻塞）
const tabUnhealthy = new Map();    // tabId -> until timestamp

// 这些 method 不绑定 tab（无需串行），其余 page.* / tabs.* / session.* 按 tabId 串行
function tabIdOf(method, params) {
  if (!params) return null;
  // 显式 tabId 优先；tabs.create / tabs.active 没有 tabId 不串行
  if (params.tabId !== undefined && params.tabId !== null) return String(params.tabId);
  return null;
}
function isSerialMethod(method) {
  return typeof method === "string" &&
    (method.startsWith("page.") || method.startsWith("session.") ||
     ["tabs.get", "tabs.activate", "tabs.close", "tabs.reload"].includes(method));
}

function nativeReady() { return !!(nativePort && nativePort.ready); }
function extReady() { return nativeReady() || !!(extWs && !extWs.closed); }
function currentChannel() {
  if (nativeReady()) return "native";
  if (extWs && !extWs.closed) return "ws";
  return null;
}

function genRequestId() {
  return crypto.randomUUID();
}

// 结构化诊断日志：不含 token / 页面内容
function rpcLog(level, ctx) {
  const line = [
    `level=${level}`, `method=${ctx.method || "-"}`,
    ctx.tabId != null ? `tab=${ctx.tabId}` : "tab=-",
    `channel=${ctx.channel || "-"}`, `reqId=${ctx.reqId || "-"}`,
    ctx.elapsedMs != null ? `elapsedMs=${ctx.elapsedMs}` : "",
    ctx.code ? `code=${ctx.code}` : "",
    ctx.note ? `note=${ctx.note}` : "",
  ].filter(Boolean).join(" ");
  log("rpc " + line);
}

// 向扩展发一个 RPC，返回 Promise。同一 tab 的串行方法排队串行执行。
async function requestExtension(method, params, timeoutMs = 60000) {
  const tabId = tabIdOf(method, params);
  const serial = isSerialMethod(method) && tabId != null;

  // tab unhealthy 恢复窗口：上次请求超时/断连后给一点恢复时间，避免雪崩
  if (serial && tabId != null) {
    const until = tabUnhealthy.get(tabId);
    if (until && Date.now() < until) {
      await new Promise((r) => setTimeout(r, until - Date.now()));
    } else if (until) {
      tabUnhealthy.delete(tabId);
    }
  }

  const exec = () => sendExtensionRequest(method, params, timeoutMs, tabId);
  if (!serial) return exec();

  // per-tab 串行队列
  let q = tabQueues.get(tabId);
  if (!q) { q = { running: false, queue: [] }; tabQueues.set(tabId, q); }
  return new Promise((resolve, reject) => {
    const run = () => exec().then(resolve, reject).finally(() => {
      if (q.queue.length) {
        const next = q.queue.shift();
        next.run();
      } else {
        q.running = false;
        // 空闲一段时间后清理队列结构，避免长期持有已关闭 tab
        const cleanup = setTimeout(() => {
          if (tabQueues.get(tabId) === q && !q.running && q.queue.length === 0) {
            tabQueues.delete(tabId);
          }
        }, 60000);
        if (cleanup.unref) cleanup.unref();
      }
    });
    if (q.running) q.queue.push({ run });
    else { q.running = true; run(); }
  });
}

async function sendExtensionRequest(method, params, timeoutMs, tabId) {
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
  const channel = currentChannel();
  const startedAt = Date.now();
  rpcLog("info", { method, tabId, channel, reqId: requestId, note: "dispatch" });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const p = pending.get(requestId);
      if (!p) return; // 已被 resolve/reject 处理
      pending.delete(requestId);
      // 标记 tab unhealthy，阻止后续同 tab 请求立刻雪崩；给恢复窗口
      if (tabId != null) tabUnhealthy.set(tabId, Date.now() + TAB_BUSY_RECOVERY_MS);
      rpcLog("warn", { method, tabId, channel, reqId: requestId, elapsedMs: timeoutMs, code: "TIMEOUT" });
      reject({ code: "TIMEOUT", message: `扩展响应超时(${timeoutMs}ms): ${method}`, method, tabId, channel, elapsedMs: timeoutMs });
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer, method, tabId, channel, startedAt });

    try {
      if (nativeReady()) {
        nativePort.postMessage({ type: "request", requestId, method, params: params || {} });
      } else if (extWs && !extWs.closed) {
        extWs.sendJson({ id: requestId, method, params: params || {} });
      } else {
        clearTimeout(timer);
        pending.delete(requestId);
        rpcLog("warn", { method, tabId, channel, reqId: requestId, code: "EXT_DISCONNECTED", note: "pre-send" });
        reject({ code: "EXT_DISCONNECTED", message: "扩展连接在请求发出前断开，请重试", method, tabId, channel });
      }
    } catch (e) {
      clearTimeout(timer);
      pending.delete(requestId);
      rpcLog("warn", { method, tabId, channel, reqId: requestId, code: "SEND_FAILED" });
      reject({ code: "SEND_FAILED", message: String(e), method, tabId, channel });
    }
  });
}

function resolvePending(requestId, payload) {
  const p = pending.get(requestId);
  if (!p) return; // 可能是已超时的 stale 响应，直接丢弃，不再 resolve（避免覆盖 reject）
  clearTimeout(p.timer);
  pending.delete(requestId);
  rpcLog("info", { method: p.method, tabId: p.tabId, channel: p.channel, reqId: requestId, elapsedMs: Date.now() - p.startedAt, note: "resolved" });
  p.resolve(payload);
}

function rejectPending(requestId, error) {
  const p = pending.get(requestId);
  if (!p) return; // stale 响应，丢弃
  clearTimeout(p.timer);
  pending.delete(requestId);
  rpcLog("warn", { method: p.method, tabId: p.tabId, channel: p.channel, reqId: requestId, elapsedMs: Date.now() - p.startedAt, code: (error && error.code) || "EXT_ERROR" });
  p.reject({ code: (error && error.code) || "EXT_ERROR", message: (error && error.message) || String(error), method: p.method, tabId: p.tabId, channel: p.channel });
}

// 通道断开：所有 pending 标记失败，避免无限挂起
function failAllPending(code, message) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    pending.delete(id);
    if (p.tabId != null) tabUnhealthy.set(p.tabId, Date.now() + TAB_BUSY_RECOVERY_MS);
    rpcLog("warn", { method: p.method, tabId: p.tabId, channel: p.channel, reqId: id, code: code || "EXT_DISCONNECTED" });
    p.reject({ code: code || "EXT_DISCONNECTED", message: message || "扩展通道断开", method: p.method, tabId: p.tabId, channel: p.channel });
  }
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
// 循环 drain buffer，支持多帧/粘包/拆包。
// 原实现只处理一个完整帧，粘包/多帧滞留会丢消息，导致 RPC 偶发无响应。
function setupNativeMessaging() {
  let buffer = Buffer.alloc(0);

  function drainBuffer() {
    for (;;) {
      // 需要至少 4 字节读出长度头
      if (buffer.length < 4) return;
      const expectedLength = buffer.readUInt32LE(0);
      // 防御：上限 16MB，避免脏数据导致巨型分配
      if (expectedLength > 16 * 1024 * 1024) {
        log("native frame too large, dropping buffer:", expectedLength);
        buffer = Buffer.alloc(0);
        return;
      }
      if (buffer.length < 4 + expectedLength) return; // 拆包，等更多数据
      const msgBuf = buffer.slice(4, 4 + expectedLength);
      // 保留剩余字节（可能还有下一帧：粘包）
      buffer = buffer.slice(4 + expectedLength);
      try {
        handleNativeMessage(JSON.parse(msgBuf.toString("utf8")));
      } catch (e) {
        log("native parse error:", e.message);
      }
    }
  }

  process.stdin.on("readable", () => {
    let chunk;
    while ((chunk = process.stdin.read()) !== null) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    }
    drainBuffer();
  });

  process.stdin.on("end", () => {
    log("native channel closed by Chrome");
    nativePort = null;
    // 通道断开：未完成的 pending 不能无限挂起
    failAllPending("EXT_DISCONNECTED", "Native 通道已关闭");
    broadcastToAgent("ext.disconnected", { channel: "native" });
    // Chrome 关闭连接后进程即将退出；standalone 时继续存活
    if (!STANDALONE) {
      setTimeout(() => process.exit(0), 500);
    }
  });
  process.stdin.on("error", (e) => {
    log("native stdin error:", e && e.message);
    nativePort = null;
    failAllPending("EXT_DISCONNECTED", "Native stdin 错误");
  });
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
        channel: currentChannel() || "disconnected",
        mode: STANDALONE ? "standalone" : "native",
        extConnected: extReady(),
        pending: pending.size,
        tabQueues: tabQueues.size,
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
            // 通道断开：pending 请求必须确定结局，不能无限挂起
            failAllPending("EXT_DISCONNECTED", "扩展 WS 通道断开");
          }
        });
        ws.on("wserror", (e) => {
          log("extension ws /agent error:", e && e.code, e && e.message);
        });
        ws.on("error", () => { /* WSConnection 已处理，避免 EventEmitter unhandled */ });
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
        ws.on("wserror", (e) => {
          log("agent ws /bridge error:", e && e.code, e && e.message);
        });
        ws.on("error", () => { /* WSConnection 已处理 */ });
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
// 单连接异常（ECONNRESET / EPIPE 等）不应拖垮整个桥，也不应刷爆日志。
// 这些是连接断开时的常规错误，WSConnection 已处理；这里只作兑底，避免进程崩。
let lastUncaughtLog = 0;
process.on("uncaughtException", (e) => {
  const code = e && (e.code || "");
  const benign = ["ECONNRESET", "EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"].includes(code);
  // 限流：无害错误每秒最多记一条，避免日志风暴 + CPU 烧
  const now = Date.now();
  if (benign) {
    if (now - lastUncaughtLog > 1000) { lastUncaughtLog = now; log("conn error (benign):", code, e && e.message); }
    return;
  }
  log("uncaughtException:", e && e.message, (e && e.stack || "").split("\n")[1] || "");
});
process.on("unhandledRejection", (e) => {
  log("unhandledRejection:", e && e.message);
});
log(`host v${VERSION} start, standalone=${STANDALONE}, port=${PORT}`);
setupNativeMessaging();
httpServer();

// 定期清理超时 pending（超时由自身 timer 触发；此处兑底，防 timer 泄漏）
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of pending) {
    if (p.startedAt && now - p.startedAt > 120000) {
      clearTimeout(p.timer);
      pending.delete(id);
      if (p.tabId != null) tabUnhealthy.set(p.tabId, now + TAB_BUSY_RECOVERY_MS);
      rpcLog("warn", { method: p.method, tabId: p.tabId, channel: p.channel, reqId: id, code: "TIMEOUT", note: "swept" });
      p.reject({ code: "TIMEOUT", message: `扩展响应超时(swept): ${p.method}`, method: p.method, tabId: p.tabId, channel: p.channel });
    }
  }
}, 30000).unref();
