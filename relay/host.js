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

// 版本号：单一事实来源是 extension/manifest.json（扩展才是提供 RPC 能力的一方）。
// host 与扩展同属一个发布单元，共用一个版本号，不再各自维护——
// 历史上 host 的 VERSION 停在 0.3.0 不动，而扩展已到 0.3.9，导致 agent
// 从 /status 读到的数字与实际能力对不上（误判 tabs.resolve 等能力不可用）。
const VERSION = (() => {
  try {
    const mf = path.join(__dirname, "..", "extension", "manifest.json");
    const v = JSON.parse(fs.readFileSync(mf, "utf8")).version;
    if (v) return String(v);
  } catch (e) {
    // 读不到 manifest（如 skill 被单独拷贝）时退回一个明确值，不静默假装成功
    // 注意：此处不能用 log()，它在下方才定义
    console.error(`[host] warn: 读不到 extension/manifest.json（${e.message}），版本号回退为 unknown`);
  }
  return "unknown";
})();
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
// token 是本地桥唯一的凭据。**读不到就必须拒绝启动**，绝不能降级成可猜测的固定值。
//
// 历史 bug：catch 里 `return "dev"`。于是 STATE_DIR 权限异常 / 磁盘满 / 只读挂载时，
// 桥会用一个写死在源码里的密码启动。这等于把「读 token 失败」静默变成
// 「任何知道这个默认值的人都能接管你的浏览器」。
//
// 「只监听 127.0.0.1」不是省略这层保护的理由：本机上的任意进程都能访问这个端口
// （被投毒的 npm postinstall、别的用户账户、以及恶意页面借 DNS rebinding 打到 127.0.0.1）。
const TOKEN_MIN_LENGTH = 16;

function tokenFailure(message, hint) {
  const err = new Error(message);
  err.code = "TOKEN_UNAVAILABLE";
  err.hint = hint;
  return err;
}

// 显式指定 token 的逃生通道（文件坏掉时仍能启动，且不必把 token 写进源码）。
// 优先级：环境变量 > 命令行。命令行会出现在 `ps` 输出里，所以只作为次选并明确告警。
function explicitToken() {
  const env = String(process.env.AGENT_BRIDGE_TOKEN || "").trim();
  if (env) return { token: env, source: "env:AGENT_BRIDGE_TOKEN", warn: null };
  const i = args.findIndex((a) => a === "--token");
  const v = i !== -1 ? String(args[i + 1] || "").trim() : "";
  if (v && v !== "auto") {
    return { token: v, source: "argv --token", warn: "命令行传入的 token 会出现在 `ps` 输出里，生产环境请改用环境变量 AGENT_BRIDGE_TOKEN" };
  }
  return null;
}

function validateToken(token, source) {
  if (!token) throw tokenFailure(`token 为空（来源: ${source}）`, "显式提供的 token 不能为空");
  if (token.length < TOKEN_MIN_LENGTH) {
    throw tokenFailure(
      `token 过短（${token.length} < ${TOKEN_MIN_LENGTH}，来源: ${source}）：弱凭据等于没有凭据`,
      `请删除 ${TOKEN_FILE} 后重启 host 以重新生成随机 token，或提供一个长度 ≥ ${TOKEN_MIN_LENGTH} 的值`
    );
  }
  return token;
}

function ensureToken() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw tokenFailure(
      `无法创建状态目录 ${STATE_DIR}（${e.code || e.message}）`,
      `确认该路径可写：mkdir -p ${STATE_DIR} && chmod 700 ${STATE_DIR}；若曾被 sudo 运行过，需 chown 回当前用户`
    );
  }

  let exists = false;
  try { exists = fs.existsSync(TOKEN_FILE); } catch (e) {
    throw tokenFailure(`无法检查 token 文件 ${TOKEN_FILE}（${e.code || e.message}）`, `chmod 700 ${STATE_DIR}`);
  }

  if (exists) {
    let raw;
    try {
      raw = fs.readFileSync(TOKEN_FILE, "utf8");
    } catch (e) {
      throw tokenFailure(
        `无法读取 token 文件 ${TOKEN_FILE}（${e.code || e.message}）`,
        `chmod 600 ${TOKEN_FILE}（目录 700）；或设置 AGENT_BRIDGE_TOKEN 显式提供 token`
      );
    }
    const token = raw.trim();
    if (!token) {
      // 空文件 = 没有任何可用凭据（通常是上一次写入中途崩溃）。重新生成是安全的：
      // 新值仍然是 24 字节随机数，不引入可猜测性。但必须留下明确记录，不静默处理。
      log(`warn: token 文件为空（${TOKEN_FILE}），重新生成`);
    } else {
      validateToken(token, TOKEN_FILE);
      ensureTokenFileMode();
      return token;
    }
  }

  const token = crypto.randomBytes(24).toString("hex");
  try {
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  } catch (e) {
    throw tokenFailure(
      `无法写入 token 文件 ${TOKEN_FILE}（${e.code || e.message}）`,
      `确认目录可写且未满：chmod 700 ${STATE_DIR}；或设置 AGENT_BRIDGE_TOKEN 显式提供 token`
    );
  }
  // 回读校验：磁盘满 / 只读挂载时 writeFileSync 可能「成功」但内容不对，
  // 那样 host 会拿一个自己以为写下去了、实际没生效的 token 去要求客户端。
  let back = "";
  try { back = fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch (e) {
    throw tokenFailure(`token 写入后无法回读 ${TOKEN_FILE}（${e.code || e.message}）`, `chmod 700 ${STATE_DIR}`);
  }
  if (back !== token) {
    throw tokenFailure(`token 写入未生效（回读不匹配，${TOKEN_FILE}）`, "磁盘可能已满或为只读挂载；修复后重启 host");
  }
  return token;
}

// 权限收紧：token 文件必须只有属主可读（600）。
// 别的本地用户能读 token 就等于能接管浏览器，所以这里不只是「建议」。
function ensureTokenFileMode() {
  try {
    const st = fs.statSync(TOKEN_FILE);
    if ((st.mode & 0o077) !== 0) {
      fs.chmodSync(TOKEN_FILE, 0o600);
      log(`warn: token 文件权限过宽（${(st.mode & 0o777).toString(8)}）→ 已收紧为 600`);
    }
  } catch (e) {
    log(`warn: 无法收紧 token 文件权限（${e.code || e.message}），请手工 chmod 600 ${TOKEN_FILE}`);
  }
}

const TOKEN = (() => {
  try {
    const explicit = explicitToken();
    if (explicit) {
      if (explicit.warn) log(`warn: ${explicit.warn}`);
      log(`token 来源: ${explicit.source}`);
      return validateToken(explicit.token, explicit.source);
    }
    return ensureToken();
  } catch (e) {
    // 必须在这里终结，而不是把异常抛到模块顶层：抛出去会打印一大段 Node 堆栈，
    // 真正的诊断（code=TOKEN_UNAVAILABLE + 修复建议）会被淹没在堆栈里。
    // fatal() 是函数声明（已提升），可以在此安全调用。
    return fatal(e);
  }
})();
// TOKEN_UNAVAILABLE 必须在**监听端口之前**终结进程（fail-closed）。
// 若改为延迟到第一次请求时才报错，桥会先以「看似就绪」的状态接受连接，
// 客户端拿到的是一个不可用的服务——比启动失败更难诊断。
// fatal() 是函数声明（已提升），可以在这里安全调用。

// ---------- 扩展通道抽象 ----------
// 优先 native port，fallback 到 WS(/agent)
let nativePort = null;   // { send, postMessage, onDisconnect }
let extWs = null;        // WSConnection (扩展 ws 通道)
let agentWss = [];       // Agent 的 ws 订阅连接
// Agent 身份与 Tab 租约：不同 Agent 可并行；同一 Tab 明确互斥。
const agents = new Map();
const tabLeases = new Map();
const DEFAULT_LEASE_MS = 120000;
function touchAgent(agentId, name = "agent") {
  if (!agentId) return;
  const old = agents.get(agentId);
  agents.set(agentId, { name: name || old?.name || "agent", connectedAt: old?.connectedAt || Date.now(), lastSeen: Date.now() });
}
function cleanupLeases() {
  const now = Date.now();
  for (const [tabId, lease] of tabLeases) if (lease.expiresAt <= now) tabLeases.delete(tabId);
}
function checkLease(tabId, agentId) {
  cleanupLeases();
  const lease = tabLeases.get(String(tabId));
  return lease && lease.agentId !== agentId ? { code: "TAB_LEASED", message: `Tab ${tabId} 已被另一个 Agent 占用`, tabId, owner: lease.agentId } : null;
}
function claimTab(tabId, agentId, ttlMs = DEFAULT_LEASE_MS) {
  if (tabId === undefined || tabId === null || !agentId) throw { code: "BAD_PARAMS", message: "需要 tabId 和 agentId" };
  const denied = checkLease(tabId, agentId); if (denied) throw denied;
  const lease = { tabId, agentId, expiresAt: Date.now() + Math.max(1000, Math.min(Number(ttlMs) || DEFAULT_LEASE_MS, 3600000)) };
  tabLeases.set(String(tabId), lease); touchAgent(agentId); return lease;
}
function releaseTab(tabId, agentId) {
  const key = String(tabId), lease = tabLeases.get(key);
  if (!lease) return { released: false, tabId };
  if (lease.agentId !== agentId) throw { code: "TAB_LEASED", message: "只能释放自己持有的 Tab 租约", tabId };
  tabLeases.delete(key); return { released: true, tabId };
}
const pending = new Map(); // requestId -> { resolve, reject, timer, method, tabId, startedAt, channel }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
     ["tabs.get", "tabs.activate", "tabs.prepare", "tabs.close", "tabs.reload"].includes(method));
}

function nativeReady() { return !!(nativePort && nativePort.ready); }
function extReady() { return nativeReady() || !!(extWs && !extWs.closed); }

// 扩展自报的版本（native hello 与 WS hello 都会带）。
// 正常情况下应与 VERSION 一致；不一致说明扩展目录被单独更新过，
// 这时以扩展自报的为准（它才是实际跑着的那份代码）。
let extVersionCache = null;
function extVersion() { return extReady() ? extVersionCache : null; }
function noteExtVersion(v) { if (v) extVersionCache = String(v); }
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

// ---------- 客户端断开：取消尚未派发的请求 ----------
// 起因：「调用方以为失败」绝不能变成「稍后偷偷执行」。对 page.click / page.type /
// 发送消息 / 提交表单这类**不可逆**操作，这是最危险的失败模式：HTTP 客户端已经
// 超时返回并告诉了用户「失败」，而 host 还在队列里等，一会儿照样把点击发出去。
class ClientGoneError extends Error {
  constructor() { super("客户端已断开，尚未派发的请求已取消"); this.code = "CLIENT_GONE"; }
}

// ---------- 统一预算：排队 + 等重连 + 执行共用一个截止时间 ----------
// 历史 bug（已隔离复现）：计时器在请求**真正发出后**才启动，排队时间完全不计入，
// 于是「超时 10ms」的请求排队 52ms 后仍被发送。
function makeBudget(timeoutMs) {
  const total = Math.max(1, Number(timeoutMs) || 60000);
  const deadline = Date.now() + total;
  return {
    total,
    deadline,
    remaining() { return deadline - Date.now(); },
    expired() { return Date.now() >= deadline; },
  };
}

function err(code, message, extra) { return Object.assign({ code, message }, extra || {}); }

function budgetExpiredError(method, tabId, budget, note) {
  return err("TIMEOUT", `请求超时(${budget.total}ms)：${method}${note ? " · " + note : ""}`, {
    method, tabId, elapsedMs: Date.now() - (budget.deadline - budget.total),
    details: { phase: note || "dispatch", budgetMs: budget.total },
  });
}

// ---------- 停止状态（用户点「停止 Agent」） ----------
// 历史问题：agent.stop 只是**通知**——广播给订阅者、页面隐藏按钮——但 host 不清空
// 待执行队列，也不拦后续 RPC。通过 HTTP 调用、没订阅事件的 Agent 根本不知道用户
// 按了停止，排队的点击/输入会继续执行，而界面已经显示「已放开」。
// 现在停止是一个**可查询、会拒绝新请求、会取消未派发请求**的状态；只有显式
// agent.resume 才解除。已经完成的页面动作无法撤销，响应里会如实说明这一点。
const STOP_DEFAULT_TTL_MS = 300000; // 5 分钟：够长到不会被误当「已恢复」，又不是永久
const stopState = new Map();        // "*" | tabId -> { at, reason, by, tabId, expiresAt }
const inflight = new Set();         // 已受理但可能尚未派发的请求（用于取消）

function stopKey(tabId) { return tabId === undefined || tabId === null ? "*" : String(tabId); }
function clearExpiredStops() {
  const now = Date.now();
  for (const [k, v] of stopState) if (v.expiresAt <= now) stopState.delete(k);
}
function activeStop(tabId) {
  clearExpiredStops();
  // tab 级停止优先于全局停止
  return (tabId != null ? stopState.get(String(tabId)) : null) || stopState.get("*") || null;
}
// 停止/恢复类方法自身必须能穿过停止闸门，否则停止无法解除。
function isStopMethod(method) {
  return method === "agent.stop" || method === "agent.resume" || method === "agent.stopStatus";
}

// 停止会拦哪些方法：**只拦真正改变页面/浏览器状态的写操作**。
//
// 不拦三类（这条边界很重要，别随手加）：
//   1. **观察类**（tabs.list / page.info / page.snapshot / bridge.status）：
//      Agent 必须能看当前状态才能决定「该等用户、还是该恢复」，全拦等于把它盲住；
//      而且 /extension/reload 流程自己会轮询 bridge.status，拦了会把桥卡死。
//   2. **释放类**（tabs.close / session.detach）：停止不能把资源泄漏变成新问题。
//      拦住 detach 会留下未释放的 debugger 会话，之后每个 page.* 都 attach 不上——
//      「停止」比不停更糟。
//   3. **恢复类**（agent.resume / session.attach）：不能自锁。
//      attach 本身不改页面内容（只是开 CDP 通道），危险动作在 session.send。
//
// ⚠ 这份清单必须与 extension/background.js 的 SIDE_EFFECT_METHODS **逐字一致**：
//   host 拦「还没派发的」，扩展拦「已派发但还没落到页面上的」。两边不一致就会出现
//   「host 放行、扩展拒绝」这类难以定位的行为。test-hardening.mjs 有契约测试防止漂移。
const SIDE_EFFECT_METHODS = new Set([
  "page.click", "page.type", "page.press", "page.select", "page.scroll",
  "page.hover", "page.focusEl", "page.navigate", "page.back", "page.forward",
  "page.reload", "page.waitFor", "page.activateAndShot", "page.ensureActive",
  "tabs.create", "tabs.reload", "tabs.activate",
]);

// session.send 是个“包罗万象”的 CDP 通道：既能 Input.dispatchMouseEvent（真点击），
// 也能 Runtime.evaluate / Page.captureScreenshot（纯读取）。一刀切拦掉会把 Agent 的
// 观察能力一起封死（skill 的 ev/attach 全走 CDP），所以按 **CDP method** 细分：
//   · 输入/导航类（Input.*、Page.navigate、Page.reload…）→ 拦（这就是“点击/输入”）；
//   · 其余（Runtime.*、DOM.*、Network.*、Page.captureScreenshot…）→ 放行。
const BLOCKED_CDP_PREFIXES = ["Input."];
const BLOCKED_CDP_METHODS = new Set([
  "Page.navigate", "Page.reload", "Page.navigateToHistoryEntry",
  "Page.setDocumentContent", "DOM.setAttributeValue", "DOM.setOuterHTML",
]);
function isBlockedCdpCall(cdpMethod) {
  const m = String(cdpMethod || "");
  if (BLOCKED_CDP_METHODS.has(m)) return true;
  return BLOCKED_CDP_PREFIXES.some((p) => m.startsWith(p));
}

function isBlockedByStop(method, params) {
  if (typeof method !== "string" || isStopMethod(method)) return false;
  if (method.startsWith("page.indicator.")) return false;   // 指示器只是视觉，不拦
  if (method === "session.send") return isBlockedCdpCall(params && params.method);
  return SIDE_EFFECT_METHODS.has(method);
}
function stoppedError(st, method, tabId) {
  return err("AGENT_STOPPED", `用户已停止 Agent（${st.reason}${st.tabId != null ? ` · tab ${st.tabId}` : " · 全部"}），本请求未执行`, {
    method, tabId: tabId != null ? tabId : st.tabId,
    details: { stoppedAt: st.at, reason: st.reason, scope: st.tabId != null ? "tab" : "all", resumeWith: "agent.resume" },
  });
}

/**
 * 取消**尚未派发**的请求。已派发到扩展的无法撤回（如实返回 cancelled 与 note）。
 * pred(entry) 决定哪些请求受影响。
 */
function cancelInflight(pred, reason) {
  let n = 0;
  for (const e of inflight) {
    if (e.dispatched) continue;         // 已发出的请求无法撤销
    if (!pred(e)) continue;
    e.cancelled = reason;
    if (typeof e.rejectNow === "function") e.rejectNow(reason);
    n++;
  }
  return n;
}

/**
 * 设置停止状态。返回 { stop, cancelledQueued, inFlight }。
 * 注意语义边界：已经执行的页面动作不能撤销，返回值里必须说清楚。
 */
function setStop(tabId, opts = {}) {
  const key = stopKey(tabId);
  const ttl = Math.max(1000, Math.min(Number(opts.ttlMs) || STOP_DEFAULT_TTL_MS, 3600000));
  const st = {
    at: Date.now(),
    reason: opts.reason || "user",
    by: opts.by || "user",
    tabId: tabId === undefined || tabId === null ? null : tabId,
    expiresAt: Date.now() + ttl,
  };
  stopState.set(key, st);
  const cancelledQueued = cancelInflight(
    (e) => st.tabId === null || String(e.tabId) === String(st.tabId),
    err("AGENT_STOPPED", `用户已停止 Agent（${st.reason}），排队中的请求已取消`)
  );
  let inFlight = 0;
  for (const e of inflight) {
    if (st.tabId !== null && String(e.tabId) !== String(st.tabId)) continue;
    if (e.dispatched) inFlight++;
  }
  log(`agent.stop scope=${st.tabId === null ? "all" : "tab=" + st.tabId} reason=${st.reason} cancelledQueued=${cancelledQueued} inFlight=${inFlight}`);
  return { stop: st, cancelledQueued, inFlight };
}

function clearStop(tabId) {
  const key = stopKey(tabId);
  const had = stopState.delete(key);
  if (tabId === undefined || tabId === null) stopState.clear();
  return had;
}

// 向扩展发一个 RPC，返回 Promise。同一 tab 的串行方法排队串行执行。
async function requestExtension(method, params, timeoutMs = 60000, agentId = "anonymous", agentName = "", opts = {}) {
  const tabId = tabIdOf(method, params);
  // 预算从**入口**开始计，排队、等重连、执行共用它。
  const budget = makeBudget(timeoutMs);
  touchAgent(agentId, agentName);
  const agentInfo = agents.get(agentId) || { name: agentName || "agent" };
  const effectiveAgentName = agentName || agentInfo.name || "agent";

  // 停止/恢复/查询停止状态：**在 host 本地处理，不转发给扩展**。
  //
  // 为什么必须拦在这里（端到端踩到的坑）：客户端可能用两条路发同一个意图——
  // HTTP 的 /agent/stop 路由，或者普通 RPC `agent.resume`。如果只实现前者，
  // 用 RPC 发 resume 的客户端会只清掉扩展侧的停止，host 的 stopState 仍然是停的，
  // 于是「明明 resume 成功了，写操作还是被拦」——两边状态分叉。
  // 统一在这里收敛：host 是停止状态的事实来源，扩展只是把同一个意图下发给页面。
  if (method === "agent.stop") return agentStop(params, { agentId, agentName: effectiveAgentName });
  if (method === "agent.resume") return agentResume(params, { agentId, agentName: effectiveAgentName });
  if (method === "agent.stopStatus") return agentStopStatus(params);

  // 停止状态：拒绝新的**写**操作（不是只广播一条事件）。
  if (isBlockedByStop(method, params)) {
    const st = activeStop(tabId);
    if (st) throw stoppedError(st, method, tabId);
  }

  const denied = tabId != null ? checkLease(tabId, agentId) : null;
  if (denied) throw denied;
  const serial = isSerialMethod(method) && tabId != null;

  const entry = {
    method, tabId, agentId, agentName: effectiveAgentName,
    dispatched: false,        // 真正发到扩展后置 true（之后不可取消）
    cancelled: null,          // 取消原因（错误对象）
    budget, agentWss: opts.clientWs || null,
  };
  inflight.add(entry);
  // 排队超时计时器：**这是「排队时间计入超时」真正生效的地方**。
  // 只在派发前重查是不够的：调用方会一直等到轮到它才得知超时（实测排队 52ms +
  // 自己的预算，客户端早已放弃）。这里到点就立刻失败。
  const budgetTimer = setTimeout(() => {
    if (entry.dispatched || entry.settled) return;
    const e = budgetExpiredError(method, tabId, budget, "queued");
    if (!entry.cancelled) entry.cancelled = e;
    if (typeof entry.rejectNow === "function") entry.rejectNow(entry.cancelled);
  }, Math.max(1, budget.remaining()));
  try {
    // tab unhealthy 恢复窗口：上次请求超时/断连后给一点恢复时间，避免雪崩
    if (serial && tabId != null) {
      const until = tabUnhealthy.get(tabId);
      if (until && Date.now() < until) {
        // 恢复窗口不能突破预算：等不完就直接失败，而不是先等再超时。
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(until - Date.now(), budget.remaining()))));
      } else if (until) {
        tabUnhealthy.delete(tabId);
      }
    }

    // 排队/等待之后重新校验：预算、停止状态、租约都可能已经变了。
    // 历史 bug：只在入队前查一次，排队期间租约易主也不会阻止派发。
    const early = preDispatchError(entry, method, tabId, agentId, budget, "pre-dispatch", params);
    if (early) throw early;

    if (!serial) return await sendExtensionRequest(entry, params, agentId, effectiveAgentName);

    // per-tab 串行队列
    let q = tabQueues.get(tabId);
    if (!q) { q = { running: false, queue: [] }; tabQueues.set(tabId, q); }
    return await new Promise((resolve, reject) => {
      // 允许「取消」立即回错，而不用等它排到队首才告诉调用方（用户按了停止，
      // 调用方应该立刻知道；否则界面显示已停止、Agent 还在傻等）。
      entry.rejectNow = (e) => { if (!entry.settled) { entry.settled = true; reject(e); } };
      const run = async () => {
        try {
          // 轮到执行时**再查一次**：这是修复「排队期间状态变了照样发」的关键位置。
          const again = entry.cancelled || preDispatchError(entry, method, tabId, agentId, budget, "queued", params);
          if (again) throw again;
          const result = await sendExtensionRequest(entry, params, agentId, effectiveAgentName);
          if (!entry.settled) { entry.settled = true; resolve(result); }
        } catch (e) {
          if (!entry.settled) { entry.settled = true; reject(e); }
        } finally {
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
        }
      };
      if (q.running) q.queue.push({ run, entry });
      else { q.running = true; run(); }
    });
  } finally {
    clearTimeout(budgetTimer);
    inflight.delete(entry);
  }
}

/**
 * 派发前的统一闸门：取消 / 停止 / 租约 / 预算 / 客户端存活。
 * 返回 null 表示可以派发，否则返回应抛出的错误对象。
 */
function preDispatchError(entry, method, tabId, agentId, budget, phase, params) {
  if (entry.cancelled) return entry.cancelled;
  if (isBlockedByStop(method, params)) {
    const st = activeStop(tabId);
    if (st) return stoppedError(st, method, tabId);
  }
  const denied = tabId != null ? checkLease(tabId, agentId) : null;
  if (denied) return denied;
  if (budget.expired()) return budgetExpiredError(method, tabId, budget, phase);
  return null;
}

async function sendExtensionRequest(entry, params, agentId, agentName) {
  const { method, tabId, budget } = entry;
  if (!extReady()) {
    // 等重连也**消耗同一个预算**（历史 bug：这里固定 12s，与 timeoutMs 无关）。
    // 而且必须能被取消立刻打断：否则用户按了停止，请求还要在「等重连」里再挂满 12s。
    const waited = await new Promise((resolve) => {
      const startedWaiting = Date.now();
      let cancelTimer = null;
      const finish = (ok) => { clearInterval(t); if (cancelTimer) clearTimeout(cancelTimer); resolve(ok); };
      const t = setInterval(() => {
        if (extReady()) finish(true);
        else if (budget.expired() || entry.cancelled || Date.now() - startedWaiting > 12000) finish(false);
      }, 250);
      cancelTimer = setTimeout(() => finish(false), Math.max(1, budget.remaining()));
      if (cancelTimer.unref) cancelTimer.unref();
    });
    if (!waited) {
      if (entry.cancelled) throw entry.cancelled;
      if (budget.expired()) throw budgetExpiredError(method, tabId, budget, "waiting-ext");
      throw err("EXT_DISCONNECTED", "扩展未连接（请确认扩展已加载并开启）", { method, tabId });
    }
  }
  const requestId = genRequestId();
  const channel = currentChannel();
  const startedAt = Date.now();
  const remaining = budget.remaining();
  if (remaining <= 0) throw budgetExpiredError(method, tabId, budget, "pre-send");
  entry.dispatched = true;   // 此后不可取消：已经交给扩展了
  rpcLog("info", { method, tabId, channel, reqId: requestId, note: "dispatch" });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const p = pending.get(requestId);
      if (!p) return; // 已被 resolve/reject 处理
      pending.delete(requestId);
      // 标记 tab unhealthy，阻止后续同 tab 请求立刻雪崩；给恢复窗口
      if (tabId != null) tabUnhealthy.set(tabId, Date.now() + TAB_BUSY_RECOVERY_MS);
      rpcLog("warn", { method, tabId, channel, reqId: requestId, elapsedMs: Date.now() - startedAt, code: "TIMEOUT" });
      reject(err("TIMEOUT", `扩展响应超时(${Math.round(remaining)}ms): ${method}`, {
        method, tabId, channel, elapsedMs: Date.now() - startedAt,
        details: { phase: "executing", budgetMs: budget.total, queuedMs: startedAt - (budget.deadline - budget.total) },
      }));
    }, Math.max(1, remaining));
    pending.set(requestId, { resolve, reject, timer, method, tabId, channel, startedAt, agentWss: entry.agentWss });

    const reqPayload = { type: "request", requestId, method, params: params || {}, agentId, agentName };
    try {
      if (nativeReady()) {
        nativePort.postMessage(reqPayload);
      } else if (extWs && !extWs.closed) {
        extWs.sendJson({ id: requestId, method, params: params || {}, agentId, agentName });
      } else {
        clearTimeout(timer);
        pending.delete(requestId);
        rpcLog("warn", { method, tabId, channel, reqId: requestId, code: "EXT_DISCONNECTED", note: "pre-send" });
        reject(err("EXT_DISCONNECTED", "扩展连接在请求发出前断开，请重试", { method, tabId, channel }));
      }
    } catch (e) {
      clearTimeout(timer);
      pending.delete(requestId);
      rpcLog("warn", { method, tabId, channel, reqId: requestId, code: "SEND_FAILED" });
      reject(err("SEND_FAILED", String(e), { method, tabId, channel }));
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
  // 透传 details（如 SCROLL_NO_GROWTH 的 atBottom/wasHidden）：调用方要能**可编程判断**，
  // 而不是去解析 message 文本。这里不能重建对象时漏掉它（历史 bug：details 被静默丢弃）。
  const e = err((error && error.code) || "EXT_ERROR", (error && error.message) || String(error), {
    method: p.method, tabId: p.tabId, channel: p.channel,
  });
  if (error && error.details) e.details = error.details;
  p.reject(e);
}

// 通道断开：所有 pending 标记失败，避免无限挂起
function failAllPending(code, message) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    pending.delete(id);
    if (p.tabId != null) tabUnhealthy.set(p.tabId, Date.now() + TAB_BUSY_RECOVERY_MS);
    rpcLog("warn", { method: p.method, tabId: p.tabId, channel: p.channel, reqId: id, code: code || "EXT_DISCONNECTED" });
    p.reject(err(code || "EXT_DISCONNECTED", message || "扩展通道断开", { method: p.method, tabId: p.tabId, channel: p.channel }));
  }
}

// ---------- agent.stop / agent.resume（本地状态，不依赖扩展在线） ----------
// 关键设计：停止状态存在 host 里，所以「通过 HTTP 调用、没订阅事件的 Agent」也会被拦住。
// 扩展端也维护一份同样的状态（拦截已受理但还没真正点下去的 content 动作），两边互补：
// host 拦的是「还没派发的」，扩展拦的是「已派发但还没落到页面上的」。
async function agentStop(params = {}, caller = {}) {
  const tabId = params.tabId !== undefined && params.tabId !== null ? params.tabId : null;
  const r = setStop(tabId, { reason: params.reason || "user", by: caller.agentId || "user", ttlMs: params.ttlMs });
  // 告知扩展（拦已派发、清视觉状态）；扩展不在线也不影响 host 侧已生效的停止。
  const forwarded = sendEventToExtension("agent.stop", { tabId, reason: r.stop.reason, at: r.stop.at });
  const payload = {
    stopped: true,
    scope: tabId === null ? "all" : "tab",
    tabId,
    reason: r.stop.reason,
    stoppedAt: r.stop.at,
    expiresAt: r.stop.expiresAt,
    resumeWith: "agent.resume",
    cancelledQueued: r.cancelledQueued,
    inFlight: r.inFlight,
    forwardedToExtension: forwarded,
    // 必须说清楚的语义边界：停止不是「回放」，已发生的页面动作无法撤销。
    note: "已完成的页面动作无法撤销；本调用只取消尚未派发的请求并拒绝后续请求。" + (r.inFlight ? ` 有 ${r.inFlight} 个已派发请求无法撤回。` : ""),
  };
  broadcastToAgent("agent.stop", payload);
  return payload;
}

async function agentResume(params = {}, caller = {}) {
  const tabId = params.tabId !== undefined && params.tabId !== null ? params.tabId : null;
  const had = clearStop(tabId);
  const forwarded = sendEventToExtension("agent.resume", { tabId, at: Date.now() });
  const payload = { stopped: false, scope: tabId === null ? "all" : "tab", tabId, wasStopped: had, forwardedToExtension: forwarded, by: caller.agentId || "user" };
  broadcastToAgent("agent.resume", payload);
  return payload;
}

function agentStopStatus(params = {}) {
  clearExpiredStops();
  const tabId = params.tabId !== undefined && params.tabId !== null ? params.tabId : null;
  const applicable = activeStop(tabId);
  return {
    // stopped = 「当前有没有任何停止在生效」；applicable 才是「这个 tabId 会不会被拦」。
    // 两个都给出来，避免调用方把「无全局停止」误读成「没被停」。
    stopped: stopState.size > 0,
    applicable: !!applicable,
    scope: applicable ? (applicable.tabId != null ? "tab" : "all") : null,
    stop: applicable || null,
    stops: [...stopState].map(([key, st]) => ({ key, ...st })),
    inFlight: inflight.size,
  };
}

// 客户端（HTTP 响应流 / WS 连接）消失：取消尚未派发的请求，并让已派发的标记归属。
// 返回被取消的排队请求数。
function noteClientGone(agentId, clientWs) {
  const n = cancelInflight(
    (e) => (clientWs ? e.agentWss === clientWs : (agentId != null && e.agentId === agentId)),
    new ClientGoneError()
  );
  if (n) log(`client gone: cancelled ${n} queued request(s)${agentId ? ` agent=${agentId}` : ""}`);
  return n;
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
      return true;
    }
    if (extWs && !extWs.closed) {
      extWs.sendJson({ type: "event", event, payload: payload || null });
      return true;
    }
  } catch (e) { /* noop */ }
  return false;
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
    noteExtVersion(msg.version);
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
    applyHostEvent(msg.event, msg.payload);
    broadcastToAgent(msg.event, msg.payload);
    return;
  }
}

/**
 * 处理扩展上报的事件。**agent.stop / agent.resume 必须在这里落到 host 状态**，
 * 而不是只广播给订阅者。
 *
 * 历史 bug（端到端复现过）：用户点页面上的「停止 Agent」→ 扩展发 event 给 host →
 * host 只 broadcastToAgent，自己的 stopState 没变。结果：界面/扩展都停了，但通过
 * HTTP 调用的 Agent 完全不受影响，排队的点击照发。这正是「按钮是通知而不是强制停止」。
 */
function applyHostEvent(event, payload) {
  if (event === "agent.stop") {
    const tabId = payload && payload.tabId !== undefined && payload.tabId !== null ? payload.tabId : null;
    setStop(tabId, { reason: (payload && payload.reason) || "user", by: "extension" });
  } else if (event === "agent.resume") {
    const tabId = payload && payload.tabId !== undefined && payload.tabId !== null ? payload.tabId : null;
    clearStop(tabId);
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
        // 统一版本号：host 与扩展同属一个发布单元，共用 extension/manifest.json 里的版本。
        // agent 直接用这个值判断能力是否可用（见 CHANGELOG 的症状对照表）。
        version: VERSION,
        channel: currentChannel() || "disconnected",
        mode: STANDALONE ? "standalone" : "native",
        // 扩展自报的版本。正常情况下与 version 相同；不同说明扩展目录被单独更新过，
        // 此时以这个值为准（它才是实际在跑的那份代码）。
        reportedExtensionVersion: extVersion(),
        extConnected: extReady(),
        pending: pending.size,
        tabQueues: tabQueues.size,
        // 停止状态：客户端（含只走 HTTP 的）可以查询自己是否被拦。
        stopped: stopState.size > 0,
        stops: [...stopState].map(([key, st]) => ({ key, ...st })),
        inFlight: inflight.size,
        agents: [...agents].map(([agentId, a]) => ({ agentId, ...a })),
        tabLeases: [...tabLeases].map(([tabId, lease]) => ({ tabId, ...lease })),
        uptimeSec: Math.round(process.uptime()),
        pid: process.pid,
        port: PORT,
        tokenPrefix: TOKEN.slice(0, 6),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/agents/register") {
      let body = ""; req.on("data", (c) => { body += c; });
      req.on("end", () => { try { const p = JSON.parse(body || "{}"); const agentId = String(p.agentId || crypto.randomUUID()); touchAgent(agentId, p.name); send(200, { ok: true, agent: { agentId, ...agents.get(agentId) } }); } catch (e) { send(400, { ok: false, error: { code: "BAD_JSON", message: e.message } }); } }); return;
    }
    // 重载扩展并等待其重新连上：省去人工到 chrome://extensions 点刷新。
    // 流程：RPC extension.reload（扩展先回响应再延迟自重载）→ 轮询 bridge.ping 直到恢复。
    if (req.method === "POST" && url.pathname === "/extension/reload") {
      let body = ""; req.on("data", (c) => { body += c; });
      req.on("end", async () => {
        try {
          const p = JSON.parse(body || "{}");
          const waitMs = Math.max(0, Math.min(Number(p.waitMs) || 15000, 60000));
          const r = await requestExtension("extension.reload", { delayMs: p.delayMs ?? 300 }, 10000, "host", "host-reload");
          const fromVersion = r && r.fromVersion;
          // 等扩展重连：轮询 bridge.status，直到拿到版本号（重连后 service worker 是新实例）
          const deadline = Date.now() + waitMs;
          let reconnected = false, version = null;
          await sleep(1200);
          while (Date.now() < deadline) {
            try {
              const st = await requestExtension("bridge.status", {}, 4000, "host", "host-reload");
              const v = st && st.version;
              if (v) { reconnected = true; version = v; break; }
            } catch (e) { /* 重载中，继续等 */ }
            await sleep(500);
          }
          send(200, { ok: reconnected, fromVersion, version, waitedMs: waitMs });
        } catch (e) {
          send(502, { ok: false, error: { code: "RELOAD_FAILED", message: e && e.message || String(e) } });
        }
      });
      return;
    }
    // 停止 / 恢复：用户点页面上的「停止 Agent」或客户端主动调用。
    // 幂等，且**不依赖扩展在线**——状态在 host 侧生效（见 setStop 注释）。
    if (req.method === "POST" && (url.pathname === "/agent/stop" || url.pathname === "/agent/resume")) {
      let body = ""; req.on("data", (c) => { body += c; });
      req.on("end", async () => {
        let p = {};
        try { p = JSON.parse(body || "{}"); } catch (e) { /* 空 body 合法：表示全局停止 */ }
        const agentId = String(req.headers["x-agent-id"] || p.agentId || "anonymous");
        const result = url.pathname === "/agent/stop" ? await agentStop(p, { agentId }) : await agentResume(p, { agentId });
        send(200, { ok: true, result });
      });
      return;
    }
    if (req.method === "POST" && (url.pathname === "/tabs/claim" || url.pathname === "/tabs/release")) {
      let body = ""; req.on("data", (c) => { body += c; });
      req.on("end", () => { try { const p = JSON.parse(body || "{}"); const agentId = String(p.agentId || req.headers["x-agent-id"] || ""); const result = url.pathname.endsWith("claim") ? claimTab(p.tabId, agentId, p.ttlMs) : releaseTab(p.tabId, agentId); send(200, { ok: true, result }); } catch (e) { send(409, { ok: false, error: { code: e.code || "LEASE_FAILED", message: e.message || String(e) } }); } }); return;
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
        const agentId = String(req.headers["x-agent-id"] || parsed.agentId || "anonymous");
        let rawAgentName = req.headers["x-agent-name"] || parsed.agentName || "";
        try { rawAgentName = decodeURIComponent(rawAgentName); } catch (e) { /* noop */ }
        const agentName = String(rawAgentName || "");
        // 调用方（HTTP 客户端）提前断开时取消**尚未派发**的请求。
        // 历史 bug：排队的请求会在客户端已经超时退出后照样被发出去——
        // 「调用方以为失败」于是变成「稍后偷偷执行」。
        let gone = false;
        const onGone = () => { if (!gone) { gone = true; noteClientGone(agentId); } };
        req.on("aborted", onGone);
        res.on("close", () => { if (!res.writableEnded) onGone(); });
        requestExtension(method, params, timeoutMs, agentId, agentName)
          .then((result) => send(200, { ok: true, result: result === undefined ? null : result }))
          .catch((e) => {
            // 客户端已走：不用再写响应（写了也无人接收），但错误必须落到 host.log。
            if (gone) { rpcLog("warn", { method, tabId: tabIdOf(method, params), code: e.code || "INTERNAL", note: "client-gone" }); return; }
            const err = { code: e.code || "INTERNAL", message: e.message || String(e) };
            if (e.details) err.details = e.details;   // 同上：不要丢 details
            send(200, { ok: false, error: err });
          });
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
          if (msg.type === "hello") { noteExtVersion(msg.version); return; }
          if (msg.type === "ping" || msg.type === "pong") return;
          if (msg.type === "event") {
            applyHostEvent(msg.event, msg.payload);
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
        // 协议错误（分片/长度/未 mask 等）：以前这些帧被静默忽略，表现为
        // 「扩展连上了但从不响应」。现在进 host.log，可 grep。
        ws.on("protocolerror", (e) => {
          log(`extension ws /agent protocolerror code=${e.code} reason=${e.reason} count=${e.count}`);
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
      onConnection(ws, req) {
        const reqUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
        const agentId = String(reqUrl.searchParams.get("agentId") || crypto.randomUUID());
        const agentName = String(reqUrl.searchParams.get("name") || reqUrl.searchParams.get("agentName") || "");
        touchAgent(agentId, agentName); ws.agentId = agentId; ws.agentName = agentName;
        agentWss.push(ws);
        log("agent connected via ws /bridge", agentId, agentName ? `(${agentName})` : "");
        ws.sendJson({ type: "hello", host: HOST_NAME, version: VERSION, extConnected: extReady() });
        ws.on("message", (text) => {
          let msg;
          try { msg = JSON.parse(text); } catch (e) { return; }
          if (msg.id !== undefined && msg.method) {
            const requestId = String(msg.id);
            const timeoutMs = msg.timeoutMs || 60000;
            const callerId = msg.agentId || ws.agentId;
            const callerName = msg.agentName || ws.agentName;
            requestExtension(msg.method, msg.params || {}, timeoutMs, callerId, callerName, { clientWs: ws })
              .then((result) => ws.sendJson({ id: requestId, ok: true, result: result === undefined ? null : result }))
              .catch((e) => {
                // details 必须透传（与 HTTP 出口一致）：否则 WS 客户端比 HTTP 客户端
                // 少一半信息，recoverable 这类判断字段就没了。
                const errorPayload = { code: e.code || "INTERNAL", message: e.message || String(e) };
                if (e.details) errorPayload.details = e.details;
                ws.sendJson({ id: requestId, ok: false, error: errorPayload });
              });
          }
        });
        ws.on("close", () => {
          agentWss = agentWss.filter((w) => w !== ws);
          // WS 客户端断开：取消它排队中、还没派发的请求。
          noteClientGone(agentId, ws);
        });
        ws.on("wserror", (e) => {
          log("agent ws /bridge error:", e && e.code, e && e.message);
        });
        ws.on("protocolerror", (e) => {
          log(`agent ws /bridge protocolerror code=${e.code} reason=${e.reason} count=${e.count}`);
        });
        ws.on("error", () => { /* WSConnection 已处理 */ });
      },
    },
  ]);

  const leaseTimer = setInterval(cleanupLeases, 10000); if (leaseTimer.unref) leaseTimer.unref();
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
      // native 模式：Chrome 拉起了第二个 host，说明已有 host 在服务，静默退出即可。
      // standalone 模式：这是明确的启动失败，必须非零退出——
      //   否则调用方（如集成测试）会把端口上「别的服务」当成 host 就绪，
      //   拿到一堆莫名其妙的 404（历史踩坑：test.js 曾硬编码 8899，
      //   而 8899 是 whistle 的默认代理端口——开着 whistle 时集成测试会假失败）。
      if (!STANDALONE) process.exit(0);
      console.error(`[host] FATAL: 端口 ${PORT} 已被占用，standalone 启动失败（EADDRINUSE）`);
      process.exit(3);
    }
  });
}

// ---------- 启动 ----------
// 启动期致命错误（token 不可用 / 端口被占）：必须非零退出 + 给出可操作的诊断，
// **不允许降级到弱默认值继续跑**。输出要同时满足两个读者：
// 人（看终端里的 修复: 一行）和 Agent（从 stderr 提取 `code=XXX`）。
function fatal(err) {
  const code = (err && err.code) || "STARTUP_FAILED";
  const message = (err && err.message) || String(err);
  const lines = [
    `[host] FATAL code=${code}`,
    `  ${message}`,
  ];
  if (err && err.hint) lines.push(`  修复: ${err.hint}`);
  // 诊断「为什么读不到 token」几乎总要翻 host.log，所以把路径一并给出。
  lines.push(`  日志: ${LOG_FILE}`);
  const text = lines.join("\n");
  try { log(text); } catch (e) { /* 日志本身不可写时不再递归失败 */ }
  console.error(text);
  process.exit(2);
}

// 单连接异常（ECONNRESET / EPIPE 等）不应拖垮整个桥，也不应刷爆日志。
// 这些是连接断开时的常规错误，WSConnection 已处理；这里只作兑底，避免进程崩。
// 注意：startupDone 之前的异常走 fatal —— 半启动的桥比不启动更危险。
let startupDone = false;
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
  if (!startupDone) return fatal(e);
  log("uncaughtException:", e && e.message, (e && e.stack || "").split("\n")[1] || "");
});
process.on("unhandledRejection", (e) => {
  if (!startupDone && e && e.code === "TOKEN_UNAVAILABLE") return fatal(e);
  log("unhandledRejection:", e && e.message);
});
log(`host v${VERSION} start, standalone=${STANDALONE}, port=${PORT}`);
setupNativeMessaging();
httpServer();
startupDone = true;

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
