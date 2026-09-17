// Agent Browser Bridge - background service worker (MV3)
// 参考 ChatGPT/Claude 插件设计：
//   主通道：Native Messaging（chrome.runtime.connectNative → 本地 host）
//   兜底通道：WebSocket 直连本地 host
// 职责：连接管理、RPC 命令执行、事件转发、alarms 保活
const DEFAULT_CONFIG = { host: "127.0.0.1", port: 8778, token: "", channel: "auto" };
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const NAV_TIMEOUT_MS = 45000;
const HOST_NAME = "com.agentbrowser.bridge";

let config = { ...DEFAULT_CONFIG };
let nativePort = null;        // native messaging port
let ws = null;                // ws 兜底连接
let activeChannel = null;     // "native" | "ws"
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;
let shutdown = false;

// ---------- 配置 ----------
async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get("bridgeConfig");
    if (stored && stored.bridgeConfig) config = { ...DEFAULT_CONFIG, ...stored.bridgeConfig };
  } catch (e) { /* noop */ }
}
async function saveConfig(next) {
  config = { ...config, ...next };
  await chrome.storage.local.set({ bridgeConfig: config });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.bridgeConfig) {
    const prevUrl = `${config.channel}|${config.host}|${config.port}`;
    config = { ...DEFAULT_CONFIG, ...changes.bridgeConfig.newValue };
    const newUrl = `${config.channel}|${config.host}|${config.port}`;
    if (prevUrl !== newUrl) reconnectNow();
  }
});

function wsUrl() {
  return `ws://${config.host || "127.0.0.1"}:${config.port || 8778}/agent?token=${encodeURIComponent(normalizeToken(config.token))}`;
}
// token 归一：宿主写入时可能被 URI 编码过（表现为末尾出现 %25 —— '%' 被二次编码）。
// 原样再 encodeURIComponent 一次就会双重编码，WS 握手必然 401/认证失败。
// 这里先把已编码形态解回原始字符串，确保「只编码一次」。
function normalizeToken(raw) {
  let t = String(raw == null ? "" : raw).trim();
  // 含 %xx 才尝试解码；解码失败（畸形序列）则保留原值，不制造新错误
  if (/%[0-9A-Fa-f]{2}/.test(t)) {
    try { const d = decodeURIComponent(t); if (d) t = d; } catch (e) { /* 保持原值 */ }
  }
  return t;
}

// ---------- 保活（MV3 SW 会休眠，用 alarms 保持通道） ----------
function ensureKeepAlive() {
  try {
    chrome.alarms.create("bridge-keepalive", { periodInMinutes: 0.5 });
  } catch (e) { /* noop */ }
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bridge-keepalive") {
    keepAliveTick();
  }
});

function keepAliveTick() {
  if (!shutdown && !isChannelOpen()) connect();
  // 顺手发个 ping 保活
  try {
    if (nativePort) nativePort.postMessage({ type: "ping" });
    else if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
  } catch (e) { /* noop */ }
}

function isChannelOpen() {
  if (nativePort) return true;
  return !!(ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING));
}

// ---------- 连接管理 ----------
function connect() {
  if (shutdown) return;
  if (isChannelOpen()) return;

  const want = config.channel || "auto";
  if (want === "native" || want === "auto") {
    if (tryConnectNative()) return;
    if (want === "native") {
      // native 失败：等下次重试（host 可能未注册）
      scheduleReconnect();
      return;
    }
  }
  if (want === "ws" || want === "auto") {
    if (tryConnectWs()) return;
  }
  scheduleReconnect();
}

function tryConnectNative() {
  try {
    const port = chrome.runtime.connectNative(HOST_NAME);
    nativePort = port;
    activeChannel = "native";
    port.onMessage.addListener((msg) => handleNativeMsg(msg));
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      nativePort = null;
      activeChannel = null;
      console.warn("[bridge] native channel disconnected", err && err.message);
      if (config.channel === "auto" && !shutdown) {
        // native 不可用（host 未注册、进程立即退出或端口被 standalone 占用）→ 回退 ws
        reconnectDelay = RECONNECT_BASE_MS;
        if (tryConnectWs()) return;
      }
      scheduleReconnect();
    });
    port.postMessage({ type: "hello", name: "Agent Browser Bridge", version: chrome.runtime.getManifest().version });
    console.log("[bridge] native channel connecting…");
    return true;
  } catch (e) {
    console.warn("[bridge] connectNative failed:", e && e.message);
    nativePort = null;
    return false;
  }
}

function tryConnectWs() {
  const url = wsUrl();
  console.log("[bridge] ws connecting:", url.replace(/token=.*/, "token=***"));
  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.warn("[bridge] ws create failed", e);
    return false;
  }
  activeChannel = "ws";
  ws.onopen = () => {
    console.log("[bridge] ws connected");
    reconnectDelay = RECONNECT_BASE_MS;
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handleWsMsg(msg);
  };
  ws.onclose = () => {
    ws = null;
    activeChannel = null;
    console.log("[bridge] ws disconnected");
    if (!shutdown) scheduleReconnect();
  };
  ws.onerror = (e) => console.warn("[bridge] ws error", e);
  return true;
}

function scheduleReconnect() {
  if (shutdown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function reconnectNow() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectDelay = RECONNECT_BASE_MS;
  if (nativePort) { try { nativePort.disconnect(); } catch (e) { /* noop */ } nativePort = null; }
  if (ws) { try { ws.close(); } catch (e) { /* noop */ } ws = null; }
  activeChannel = null;
  connect();
}

function sendToHost(obj) {
  if (nativePort) { nativePort.postMessage(obj); return true; }
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(obj)); return true; }
  return false;
}

// 已知「页面上下文失效」的 tab：导航超时 / 注入失败后打标记（tabId -> 时间戳）。
// 命中时 evaluate 立即快速失败，而不是让每个后续调用都挂满 CONTENT_CALL_TIMEOUT_MS
// （实测一个坏 tab 会连累后续每个调用各挂满 60s）。导航成功或 prepare 成功后清除。
const brokenTabs = new Map();
const BROKEN_TTL_MS = 30000;
// 注入探测超时：chrome.tabs.sendMessage 对「content script 不存在」不会 reject、会一直挂起，
// 必须自己加超时把「挂起」变成「快速可判定」，否则 RPC 会被拖到 CONTENT_CALL_TIMEOUT_MS。
const PING_TIMEOUT_MS = 3000;
const INJECT_TIMEOUT_MS = 10000;
// 单次求值超时。用 CONTENT_CALL_TIMEOUT_MS(30s) 会让坏 tab 上每个调用都挂满 30s；
// ensureInjected 已能在 3s 内判定 content script 是否存在，这里给 12s 足够正常页面执行，
// 又不会让失效页面的每个调用都拖满。超时后由 brokenTabs 让后续调用立即失败。
const EVAL_TIMEOUT_MS = 12000;
function markBroken(tabId) { brokenTabs.set(tabId, Date.now()); }
function clearBroken(tabId) { brokenTabs.delete(tabId); }
function isBroken(tabId) {
  const t = brokenTabs.get(tabId);
  if (t === undefined) return false;
  if (Date.now() - t > BROKEN_TTL_MS) { brokenTabs.delete(tabId); return false; }
  return true;
}

// 降级日志：预期内的失败（受限页、调用方参数问题）不进 console.error，
// 否则 chrome://extensions 的 errors 列表会被噪音刷满，真正的故障被淹没。
const EXPECTED_ERROR_CODES = new Set([
  "UNSUPPORTED_URL",   // chrome:// chrome-extension:// 等本就不可注入
  "TAB_DISCARDED",     // 被 OneTab / 浏览器冻结的 tab
  "TAB_GONE",          // tab 已关闭
  "BAD_PARAMS",        // 调用方没传对参数
  "UNKNOWN_METHOD",    // 文档/版本不匹配，属调用方问题
  "SCREENSHOT_FAILED",
]);
function logRpcError(method, e) {
  const code = normalizeErrCode(e);
  if (EXPECTED_ERROR_CODES.has(code)) {
    console.warn("[bridge] rpc skipped", method, code);
  } else {
    console.error("[bridge] rpc error", method, e && e.message);
  }
}
// Chrome API 抛的是原生 Error（如 "No tab with id: 1."），没有 code 字段，
// 默认会落进 INTERNAL 并在 errors 面板刷成红字。这里按消息归一化出结构化 code，
// 让调用方可编程判断，也让预期内的失败降级成 warn。
function normalizeErrCode(e) {
  if (e && e.code) return e.code;
  const m = String((e && e.message) || e || "");
  if (/No tab with id/i.test(m)) return "TAB_GONE";
  if (/Cannot access contents of the page|Cannot access a chrome:/i.test(m)) return "UNSUPPORTED_URL";
  if (/Receiving end does not exist|Frame with ID .* was removed/i.test(m)) return "PAGE_CONTEXT_TIMEOUT";
  if (/Another debugger|already attached/i.test(m)) return "DEBUGGER_BUSY";
  return "INTERNAL";
}

// 错误里可以带结构化细节（如 SCROLL_NO_GROWTH 的 atBottom/wasHidden），让调用方**可编程判断**
// 而不必解析 message 文本。只透传白名单字段：避免把任意对象（可能含页面内容）带出去。
const ERROR_DETAIL_KEYS = [
  "atBottom", "wasHidden", "grew", "moved", "heightBefore", "heightAfter", "yBefore", "yAfter",
  "tabId", "recoverable", "retryAfterMs",
  // 停止类错误的细节（AGENT_STOPPED）：调用方靠 resumeWith 知道怎么恢复，
  // 靠 scope 知道是「整机停了」还是「只有这个 tab 停了」。
  "resumeWith", "scope", "stoppedAt", "reason", "action",
];
function errorDetails(e) {
  if (!e || typeof e !== "object") return undefined;
  const out = {};
  for (const k of ERROR_DETAIL_KEYS) {
    if (e[k] !== undefined && e[k] !== null) out[k] = e[k];
  }
  return Object.keys(out).length ? out : undefined;
}

// 统一的错误响应体构造：所有出口都走这里，避免漏掉 details（历史 bug：details 被静默丢弃）。
function errorPayload(e) {
  const payload = { code: normalizeErrCode(e), message: e && e.message ? String(e.message) : String(e) };
  const details = errorDetails(e);
  if (details) payload.details = details;
  return payload;
}

// ---------- 入站：native ----------
function handleNativeMsg(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "hello") {
    console.log("[bridge] host hello:", msg.host, msg.version, "channel=native");
    return;
  }
  if (msg.type === "pong") return;
  if (msg.type === "request" && msg.requestId !== undefined && msg.method) {
    const caller = { agentName: msg.agentName, agentId: msg.agentId };
    dispatch(msg.method, msg.params || {}, caller)
      .then((result) => {
        nativePort.postMessage({ type: "response", responseToRequestId: msg.requestId, payload: result === undefined ? null : result });
      })
      .catch((e) => {
        logRpcError(msg.method, e);
        nativePort.postMessage({
          type: "response",
          responseToRequestId: msg.requestId,
          error: errorPayload(e),
        });
      });
    return;
  }
  if (msg.type === "event") {
    handleHostEvent(msg.event, msg.payload);
    return;
  }
}

// ---------- 入站：ws ----------
function handleWsMsg(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "hello" || msg.type === "pong") return;
  if (msg.type === "event") {
    handleHostEvent(msg.event, msg.payload);
    return;
  }
  if (msg.id !== undefined && msg.method) {
    const caller = { agentName: msg.agentName, agentId: msg.agentId };
    dispatch(msg.method, msg.params || {}, caller)
      .then((result) => ws.send(JSON.stringify({ id: msg.id, ok: true, result: result === undefined ? null : result })))
      .catch((e) => ws.send(JSON.stringify({ id: msg.id, ok: false, error: errorPayload(e) })));
  }
}

// ---------- 停止状态（扩展侧） ----------
// 为什么扩展也要维护一份：host 只能拦住「还没派发」的请求。一个已经发到扩展、
// 正在 content script 里跑的 page.click / page.type 不受 host 控制；
// 如果用户在那一瞬间按了停止，扩展必须自己知道「不要再往下做了」。
//
// 历史问题：agent.stop 只做了视觉撤销（隐藏光标/按钮/badge），语义上是一个通知；
// 界面显示「已放开」而排队的操作照跑。
const stoppedScopes = new Map();   // "*" | String(tabId) -> { at, reason, expiresAt }
const STOP_TTL_MS = 300000;

function isStopped(tabId) {
  const now = Date.now();
  for (const [k, v] of stoppedScopes) if (v.expiresAt <= now) stoppedScopes.delete(k);
  if (stoppedScopes.size === 0) return null;
  if (tabId !== undefined && tabId !== null) {
    const t = stoppedScopes.get(String(tabId));
    if (t) return t;
  }
  return stoppedScopes.get("*") || null;
}

function setStopped(tabId, reason) {
  const key = tabId === undefined || tabId === null ? "*" : String(tabId);
  // tabId 必须存进记录里：stopStatus / stoppedError 靠它区分「整机停了」还是「只有这个 tab 停了」。
  // （不存的话 scope 会永远是 "all"，调用方就无法判断自己这个 tab 到底该不该等。）
  const st = {
    at: Date.now(), reason: reason || "user", expiresAt: Date.now() + STOP_TTL_MS,
    tabId: tabId === undefined || tabId === null ? null : tabId,
  };
  stoppedScopes.set(key, st);
  return st;
}
function clearStopped(tabId) {
  if (tabId === undefined || tabId === null) { const had = stoppedScopes.size > 0; stoppedScopes.clear(); return had; }
  return stoppedScopes.delete(String(tabId));
}
function stoppedError(st, method, tabId) {
  return {
    code: "AGENT_STOPPED",
    message: `用户已停止 Agent（${st.reason}），${method} 未执行`,
    details: {
      stoppedAt: st.at, reason: st.reason, resumeWith: "agent.resume",
      // 与 host 的 stoppedError 保持同一形状（契约测试守着）。
      scope: st.tabId != null ? "tab" : "all",
      tabId: tabId != null ? tabId : st.tabId,
    },
  };
}

// 停止状态会拦哪些方法？只拦**有副作用**的（真正动页面的），不拦读取/状态/停止控制本身。
// 否则用户在停止后连「看一下当前状态」都做不到，而且 agent.resume 也永远调不通。
//
// ⚠ 这份清单必须与 relay/host.js 的 SIDE_EFFECT_METHODS **逐字一致**：host 拦
// 「还没派发的」，扩展拦「已派发但还没落到页面上的」。两边不一致就会出现
// 「host 放行、扩展拒绝」这类难定位的行为。test-hardening.mjs 有契约测试防止漂移。
const SIDE_EFFECT_METHODS = new Set([
  "page.click", "page.type", "page.press", "page.select", "page.scroll",
  "page.hover", "page.focusEl", "page.navigate", "page.back", "page.forward",
  "page.reload", "page.waitFor", "page.activateAndShot", "page.ensureActive",
  "tabs.create", "tabs.reload", "tabs.activate",
]);

// session.send 是“包罗万象”的 CDP 通道：既能 Input.dispatchMouseEvent（真点击），
// 也能 Runtime.evaluate / Page.captureScreenshot（纯读取）。一刀切拦掉会把 Agent 的
// 观察能力一起封死（skill 的 ev/attach 全走 CDP），所以按 **CDP method** 细分。
// ⚠ 与 relay/host.js 的同名定义必须一致（契约测试守着）。
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

function isSideEffectMethod(method, params) {
  if (typeof method !== "string") return false;
  if (method === "agent.stop" || method === "agent.resume" || method === "agent.stopStatus") return false;
  if (method.startsWith("page.indicator.")) return false;  // 指示器只是视觉，不拦
  if (method === "session.send") return isBlockedCdpCall(params && params.method);
  return SIDE_EFFECT_METHODS.has(method);
}

// host 下发事件
function handleHostEvent(event, payload) {
  switch (event) {
    case "agent.stop": {
      const tabId = payload && payload.tabId !== undefined ? payload.tabId : null;
      setStopped(tabId, (payload && payload.reason) || "user");
      // 用户按下停止：光标、按钮和标签页接管状态都立即撤销。
      broadcastToTabs({ type: "bridge.indicator", action: "hide" });
      broadcastToTabs({ type: "bridge.indicator", action: "hideStop" });
      broadcastToTabs({ type: "bridge.indicator", action: "setControl", state: "released" });
      clearAllTabControlBadges();
      // 告诉页面里的 content 脚本也进入停止态：它手上可能有一个正在跑的
      // 多步动作（如滚动循环 / 逐字输入），需要它自己在下一步前退出。
      broadcastToTabs({ type: "bridge.stopState", stopped: true, reason: (payload && payload.reason) || "user", tabId });
      break;
    }
    case "agent.resume": {
      const tabId = payload && payload.tabId !== undefined ? payload.tabId : null;
      clearStopped(tabId);
      broadcastToTabs({ type: "bridge.stopState", stopped: false, tabId });
      break;
    }
    default:
      break;
  }
}

function broadcastToTabs(msg) {
  chrome.tabs.query({}, (tabs) => {
    if (!chrome.runtime.lastError) {
      for (const t of tabs) {
        if (!t.id) continue;
        // 单次调用 + .catch：避免每个 tab 两次调用，且保护 promise rejection
        try {
          const p = chrome.tabs.sendMessage(t.id, msg);
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch (e) { /* noop */ }
      }
    }
  });
}

// 记录每个 Tab 当前被哪个 Agent 接管（用于 popup 界面与监控）：tabId -> { agentDisplay, agentName, agentId, lastActiveAt, timer }
const activeTabAgents = new Map();
const TAB_AGENT_EXPIRE_MS = 15_000;

function recordTabAgent(tabId, agentName, agentId, agentDisplay) {
  if (tabId === undefined || tabId === null) return;
  const existing = activeTabAgents.get(tabId);
  if (existing?.timer) clearTimeout(existing.timer);

  // 格式化展示名称
  let display = agentDisplay;
  if (!display) {
    const rawName = typeof agentName === "string" ? agentName.trim() : "";
    const rawId = typeof agentId === "string" ? agentId.trim() : "";
    let shortId = "";
    if (rawId && rawId !== "anonymous") {
      shortId = rawId.replace(/^agent-/, "").replace(/^[a-zA-Z_-]+-/, "");
      if (!shortId) shortId = rawId;
    }
    if (!rawName || rawName === "agent" || rawName === "anonymous") {
      display = shortId ? `Agent #${shortId}` : "Agent";
    } else if (shortId && (rawName.includes(shortId) || rawName.includes(rawId))) {
      display = rawName;
    } else {
      display = shortId ? `${rawName} #${shortId}` : rawName;
    }
  }

  const timer = setTimeout(() => {
    activeTabAgents.delete(tabId);
    // 自愈兜底（v0.3.1）：页面端 12s 闲置计时器可能因后台冻结(Memory Saver)/导航
    // 而失效，导致「接管中」标题与 toolbar badge 永久滞留。15s 无新控制请求时，
    // 后台直接撤销 badge，并请求页面释放（页面存活则立即恢复原标题；冻结页唤醒后
    // 收到该消息同样会恢复）。
    setTabControlBadge(tabId, false);
    try { indicatorCall(tabId, { action: "setControl", state: "released" }); } catch (e) { /* noop */ }
    try { indicatorCall(tabId, { action: "hideStop" }); } catch (e) { /* noop */ }
  }, TAB_AGENT_EXPIRE_MS);

  activeTabAgents.set(tabId, {
    tabId,
    agentDisplay: display,
    agentName: agentName || "",
    agentId: agentId || "",
    lastActiveAt: Date.now(),
    timer,
  });
}

function clearTabAgent(tabId) {
  const existing = activeTabAgents.get(tabId);
  if (existing?.timer) clearTimeout(existing.timer);
  activeTabAgents.delete(tabId);
}

// Chrome 不允许扩展改写网站 tab 的标题或 favicon；因此使用扩展图标 badge，
// 并和页面内状态条配对，提供浏览器级和页面级两个可见信号。
function setTabControlBadge(tabId, active, agentDisplay) {
  if (tabId === undefined || tabId === null) return;
  try {
    chrome.action.setBadgeText({ tabId, text: active ? "ON" : "" });
    if (active) chrome.action.setBadgeBackgroundColor({ tabId, color: "#1d4ed8" });
    const title = active
      ? (agentDisplay ? `[${agentDisplay}] 接管中` : "Agent 接管中")
      : "Agent Browser Bridge";
    chrome.action.setTitle({ tabId, title });
  } catch (e) { /* noop */ }
}
function clearAllTabControlBadges() {
  chrome.tabs.query({}, (tabs) => tabs.forEach((tab) => setTabControlBadge(tab.id, false)));
}

// ---------- 命令分发 ----------
// 所有会触及页面的 RPC 都在标签标题和页面右上角明确标为「Agent 接管中」。
// 标记会由页面端的闲置计时器自动撤销；收到 agent.stop 时则立即撤销，避免用户
// 只能从一次性的幽灵光标判断脚本是否还持有该标签页。
// 护栏：只对真实交互操作（click/type/press/scroll/hover/focusEl/select/waitFor）
// 显示「停止 Agent」按钮。只读/导航/evaluate/snapshot/waitLoad 不被 indicator 阻塞，
// 避免给读操作和导航增加竞态。indicator 失败不得影响主 RPC。
const INTERACTIVE_METHODS = new Set([
  "page.click", "page.type", "page.press", "page.scroll",
  "page.hover", "page.focusEl", "page.waitFor", "page.select",
]);
function isPageControlMethod(method) {
  return typeof method === "string" && method.startsWith("page.") && !method.startsWith("page.indicator.");
}
async function dispatch(method, params, caller) {
  const agentName = caller?.agentName || "";
  const agentId = caller?.agentId || "";

  // 停止闸门（在**任何副作用之前**）：用户按了停止后，新到的写操作一律拒绝，
  // 而不是只广播一条事件然后照做。见 isStopped / SIDE_EFFECT_METHODS 的注释。
  if (isSideEffectMethod(method, params)) {
    const st = isStopped(params && params.tabId);
    if (st) throw stoppedError(st, method, params && params.tabId);
  }
  // 停止 / 恢复本身：本地状态立即生效，host 侧也会各自维护一份（两边互补）。
  if (method === "agent.stop") {
    const tabId = params && params.tabId !== undefined ? params.tabId : null;
    const st = setStopped(tabId, params && params.reason);
    broadcastToTabs({ type: "bridge.indicator", action: "hide" });
    broadcastToTabs({ type: "bridge.indicator", action: "hideStop" });
    broadcastToTabs({ type: "bridge.indicator", action: "setControl", state: "released" });
    clearAllTabControlBadges();
    broadcastToTabs({ type: "bridge.stopState", stopped: true, reason: st.reason, tabId });
    return { stopped: true, scope: tabId === null ? "all" : "tab", tabId, reason: st.reason, stoppedAt: st.at, expiresAt: st.expiresAt, resumeWith: "agent.resume" };
  }
  if (method === "agent.resume") {
    const tabId = params && params.tabId !== undefined ? params.tabId : null;
    const had = clearStopped(tabId);
    broadcastToTabs({ type: "bridge.stopState", stopped: false, tabId });
    return { stopped: false, scope: tabId === null ? "all" : "tab", tabId, wasStopped: had };
  }
  if (method === "agent.stopStatus") {
    const st = isStopped(params && params.tabId);
    // 与 host 的 agentStopStatus 保持同一形状：stopped = 「有没有停止在生效」，
    // applicable = 「这个 tabId 会不会被拦」。两个都给，避免误读。
    return {
      stopped: stoppedScopes.size > 0,
      applicable: !!st,
      scope: st ? (st.tabId != null ? "tab" : "all") : null,
      stop: st || null,
      scopes: [...stoppedScopes.keys()],
    };
  }

  if (isPageControlMethod(method) && params && params.tabId) {
    recordTabAgent(params.tabId, agentName, agentId);
    // 有未完成的「借前台」时续期：还原只发生在真的空闲之后，不会在长流程中途抢走前台。
    touchBorrow(params.tabId);
    // 不 await：indicator 只是视觉提示，但它对冻结/受限页要先撞 3s PING 超时。
    // 串在 RPC 前面等于给每个 page.* 白加 3s 延迟（冻结 tab 上尤其明显）。
    indicatorCall(params.tabId, { action: "setControl", state: "active", agentName, agentId })
      .catch(() => { /* chrome:// 等受限页忽略 */ });
  }
  if (INTERACTIVE_METHODS.has(method) && params && params.tabId) {
    indicatorCall(params.tabId, { action: "showStop", label: "停止 Agent", agentName, agentId })
      .catch(() => { /* 同上：失败不影响主 RPC */ });
  }
  switch (method) {
    case "bridge.status": return bridgeStatus();
    case "bridge.connect": return bridgeConnect(params);
    case "bridge.disconnect": return bridgeDisconnect();
    case "bridge.ping": return { pong: Date.now(), relayTime: params.t || null };

    // 自我重载：先回响应（reload 会中断自身执行，不能等它完成再回），再延迟触发。
    // 免除手工到 chrome://extensions 点刷新的步骤。
    case "extension.reload": return extensionReload(params);

    case "tabs.list": return tabsList(params);
    case "tabs.get": return tabsGet(params.tabId);
    case "tabs.active": return tabsActive();
    case "tabs.create": return tabsCreate(params);
    case "tabs.activate": return tabsActivate(params.tabId);
    case "tabs.prepare": return tabsPrepare(params.tabId);
    case "tabs.close": return tabsClose(params.tabId);
    case "tabs.reload": return tabsReload(params.tabId, params);
    // 别名：文档/调用方常用名，统一映射到既有实现，避免 UNKNOWN_METHOD
    // 打开 URL 的首选入口：复用「用户没在看」的同类标签页，否则静默新开后台标签页。
    // tabs.create/别名只做「无条件新开」，日常不应用它打开网址。
    case "tabs.resolve":
    case "tabs.openUrl":
    case "page.open": return tabsResolve(params);
    case "tabs.open":
    case "tabs.new": return tabsCreate({ url: params.url, ...params });
    case "tabs.claim":
    case "tabs.release": {
      // 租约账本在 host 侧（HTTP /tabs/claim|/tabs/release 才是真正的互斥来源）。
      // 经 RPC 进来时无法登记租约，做兼容降级：claim 等价于 prepare（保证可用），
      // release 无本地状态可清。并在 warning 里点明正确入口，避免误以为拿到了互斥租约。
      if (method === "tabs.release") {
        return { ok: true, tabId: params.tabId, leased: false, note: "租约由 host 管理，请用 HTTP POST /tabs/release 释放" };
      }
      const prep = await tabsPrepare(params.tabId);
      return { ...prep, leased: false, note: "租约未登记（由 host 管理），请用 HTTP POST /tabs/claim 获取真实互斥租约" };
    }
    case "page.reload": return tabsReload(params.tabId, params);

    case "page.info": return pageInfo(params.tabId);
    case "page.navigate": return pageNavigate(params.tabId, params.url, params);
    case "page.back": return pageBack(params.tabId);
    case "page.forward": return pageForward(params.tabId);
    case "page.focus": return pageFocus(params.tabId);
    case "page.ensureActive": return pageEnsureActive(params.tabId, params);
    case "page.restoreActive": return pageRestoreActive(params.tabId);
    case "page.waitLoad": return waitForLoad(params.tabId, params.timeoutMs);
    case "page.waitForReady": return waitForReady(params.tabId, params.timeoutMs);
    case "page.waitForUrl": return waitForUrl(params.tabId, params);
    case "page.waitForSelector": return waitForSelector(params.tabId, params);

    case "page.snapshot": return pageSnapshot(params.tabId, params);
    case "page.evaluate": return pageEvaluate(params.tabId, params);
    case "page.inspect": return pageInspect(params.tabId, params);
    case "page.record.start": return pageRecordStart(params.tabId);
    case "page.record.stop": return pageRecordStop(params.tabId);
    case "page.record.status": return pageRecordStatus(params.tabId);
    case "page.record.get": return pageRecordGet(params.tabId, params);
    case "page.record.clear": return pageRecordClear(params.tabId);
    case "page.click": return pageAction(params.tabId, "click", params);
    case "page.type": return pageAction(params.tabId, "type", params);
    case "page.press": return pageAction(params.tabId, "press", params);
    case "page.scroll": return params.checked ? pageScrollChecked(params.tabId, params) : pageAction(params.tabId, "scroll", params);
    case "page.hover": return pageAction(params.tabId, "hover", params);
    case "page.focusEl": return pageAction(params.tabId, "focusEl", params);
    case "page.waitFor": return pageAction(params.tabId, "waitFor", params);
    case "page.select": return pageAction(params.tabId, "select", params);
    case "page.screenshot": return pageScreenshot(params.tabId, params);
    case "page.activateAndShot": return pageActivateAndShot(params.tabId, params);

    // 视觉指示器（参考 Claude phantom-cursor）
    case "page.indicator.move": return indicatorCall(params.tabId, { action: "move", x: params.x, y: params.y, instant: !!params.instant });
    case "page.indicator.click": return indicatorCall(params.tabId, { action: "click", x: params.x, y: params.y });
    case "page.indicator.highlight": return indicatorCall(params.tabId, { action: "highlight", selector: params.selector });
    case "page.indicator.hide": return indicatorCall(params.tabId, { action: "hide" });
    case "page.indicator.stop": return params.show
      ? indicatorCall(params.tabId, { action: "showStop", label: params.label })
      : indicatorCall(params.tabId, { action: "hideStop" });
    case "page.indicator.hideAll": {
      broadcastToTabs({ type: "bridge.indicator", action: "hide" });
      broadcastToTabs({ type: "bridge.indicator", action: "hideStop" });
      return { ok: true };
    }

    case "session.attach": return sessionAttach(params.tabId);
    case "session.detach": return sessionDetach(params.tabId);
    case "session.send": return sessionSend(params.tabId, params);

    default:
      throw { code: "UNKNOWN_METHOD", message: `未知方法: ${method}` };
  }
}

// ---------- 扩展自我重载 ----------
// chrome.runtime.reload() 无需额外权限。但它会立即终止当前 service worker 执行，
// 因此必须「先回响应、再延迟触发」——否则调用方永远收不到结果，只能看到超时。
// delayMs 默认值给足时间让响应写回 native port / ws。
function extensionReload(params) {
  const delayMs = Math.max(0, Math.min((params && params.delayMs) ?? 300, 5000));
  const version = chrome.runtime.getManifest().version;
  setTimeout(() => {
    try { chrome.runtime.reload(); } catch (e) { /* 若被中断则忽略 */ }
  }, delayMs);
  return { ok: true, reloading: true, fromVersion: version, delayMs };
}

// ---------- bridge 状态 ----------
async function bridgeStatus() {
  const manifest = chrome.runtime.getManifest();
  let active = null;
  try { active = await tabsActive(); } catch (e) { /* noop */ }

  // 组装当前被各个 Agent 接管中的 Tab 列表
  const activeTabs = [];
  const now = Date.now();
  for (const [tabId, info] of activeTabAgents.entries()) {
    if (now - info.lastActiveAt > TAB_AGENT_EXPIRE_MS) {
      activeTabAgents.delete(tabId);
      continue;
    }
    let tabDetail = null;
    try {
      const t = await chrome.tabs.get(tabId);
      tabDetail = serializeTab(t);
    } catch {
      // tab 可能已关闭
      activeTabAgents.delete(tabId);
      continue;
    }
    activeTabs.push({
      tabId,
      agentDisplay: info.agentDisplay,
      agentName: info.agentName,
      agentId: info.agentId,
      lastActiveAt: info.lastActiveAt,
      tab: tabDetail,
    });
  }

  return {
    name: manifest.name,
    version: manifest.version,
    channel: activeChannel,
    connected: isChannelOpen(),
    relayUrl: wsUrl().replace(/token=.*/, "token=***"),
    activeTab: active ? active.tab : null,
    operatingAgents: activeTabs,
  };
}

function bridgeConnect(params) {
  return saveConfig({
    host: params.host || config.host,
    port: params.port || config.port,
    token: params.token !== undefined ? normalizeToken(params.token) : normalizeToken(config.token),
    channel: params.channel || config.channel,
  }).then(() => {
    reconnectNow();
    return { ok: true };
  });
}

function bridgeDisconnect() {
  shutdown = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (nativePort) { try { nativePort.disconnect(); } catch (e) { /* noop */ } nativePort = null; }
  if (ws) { try { ws.close(); } catch (e) { /* noop */ } ws = null; }
  activeChannel = null;
  return { ok: true };
}

// ---------- 标签页 ----------
async function tabsList(params) {
  const query = {};
  if (params && params.windowId !== undefined) query.windowId = params.windowId;
  if (params && params.active !== undefined) query.active = !!params.active;
  const tabs = await chrome.tabs.query(query);
  return { tabs: tabs.map(serializeTab) };
}
function serializeTab(t) {
  return {
    id: t.id, windowId: t.windowId, index: t.index, active: t.active, pinned: t.pinned,
    audible: t.audible, muted: t.mutedInfo ? t.mutedInfo.muted : false, incognito: t.incognito,
    status: t.status, url: t.url, title: t.title, favIconUrl: t.favIconUrl, discarded: t.discarded || false,
  };
}
async function tabsGet(tabId) {
  requireTabId(tabId);
  const t = await chrome.tabs.get(tabId);
  return { tab: serializeTab(t) };
}
async function tabsActive() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw { code: "NO_ACTIVE_TAB", message: "没有活动标签页" };
  return { tab: serializeTab(tab) };
}
async function tabsCreate(params) {
  const props = {};
  if (params.url) props.url = params.url;
  if (params.active !== undefined) props.active = !!params.active;
  if (params.index !== undefined) props.index = params.index;
  const tab = await chrome.tabs.create(props);
  return { tab: serializeTab(tab) };
}
async function tabsActivate(tabId) {
  requireTabId(tabId);
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) { /* noop */ }
  return { tab: serializeTab(tab) };
}

// ---------- 前台渲染保障：必要时临时激活，用完自动还原 ----------
// 背景：Chrome 对后台标签页把 requestAnimationFrame **完全暂停**（实测 2s 内 0 帧，
// 活动页 60 帧），`document.visibilityState = "hidden"`。依赖 rAF 的懒加载 / 瀑布流 /
// 无限滚动在后台永不推进——注意这是「暂停」不是「节流」，加长超时没用。
//
// 已试过但不行的方案（实测）：CDP `Emulation.setFocusEmulationEnabled` 确实能把 rAF 拉起来，
// 但它 **detach 或页面导航后立即失效**，而 detach 是每次 RPC 收尾都会做的事，等于没用。
// 所以只能真让标签页 active。
//
// 本实现的取舍：只切**标签页**，不聚焦窗口（不调 chrome.windows.update({focused:true})）。
// 实测 `chrome.tabs.update({active:true})` 单独就能恢复 rAF（Chrome 非前台时同样有效），
// 所以用户正在别的应用里工作时不会被弹到 Chrome。用完空闲 N 秒把活动标签页还给用户原来那个。
const borrowedActive = new Map();   // tabId -> { prevTabId, windowId, timer, at }
const BORROW_RESTORE_MS = 20000;

function clearBorrow(tabId) {
  const b = borrowedActive.get(tabId);
  if (b && b.timer) clearTimeout(b.timer);
  borrowedActive.delete(tabId);
}

// 每次对该 tab 的 page.* 调用都重置计时：还原只发生在「真的闲着」之后，
// 不会在长流程中途（比如滚动循环里两次调用间隔 20s+）把前台抢走。
// 用 per-borrow 的 restoreMs（而不是全局常量），调用方可按需缩短/加长。
function touchBorrow(tabId) {
  const b = borrowedActive.get(tabId);
  if (!b) return;
  if (b.timer) clearTimeout(b.timer);
  b.at = Date.now();
  b.timer = setTimeout(() => { restoreBorrowed(tabId, "idle"); }, b.restoreMs || BORROW_RESTORE_MS);
}

// 把活动标签页还给用户原来那个。返回被还原到的 tabId，没做事则返回 null。
async function restoreBorrowed(tabId, reason) {
  const b = borrowedActive.get(tabId);
  if (!b) return null;
  clearBorrow(tabId);
  try {
    // 用户已经自己切走了（目标 tab 不再是活动页）：不要跟他抢，直接放弃还原。
    const cur = await chrome.tabs.get(tabId);
    if (!cur.active) return null;
  } catch (e) { return null; }
  try {
    const prev = await chrome.tabs.get(b.prevTabId);
    if (prev.windowId !== b.windowId) return null;   // 用户把原标签页移走了
    await chrome.tabs.update(b.prevTabId, { active: true });
    return b.prevTabId;
  } catch (e) {
    // 原标签页已关：尝试退到该窗口里任意一个别的页，而不是把 agent 的页留在前台
    try {
      const others = await chrome.tabs.query({ windowId: b.windowId });
      const fallback = others.find((t) => t.id !== tabId);
      if (fallback) { await chrome.tabs.update(fallback.id, { active: true }); return fallback.id; }
    } catch (e2) { /* noop */ }
    return null;
  }
}

// 同窗口里当前的活动标签页（排除自己）。
async function activeTabInWindow(windowId, exceptTabId) {
  const list = await chrome.tabs.query({ windowId, active: true });
  const t = list.find((x) => x.id !== exceptTabId);
  return t ? t.id : null;
}

// 确保目标页真的在渲染（必要时临时激活）。返回实际状态供调用方判断。
async function pageEnsureActive(tabId, params) {
  requireTabId(tabId);
  const t = await chrome.tabs.get(tabId);
  if (!/^(https?|file):/.test(t.url || "")) {
    throw { code: "UNSUPPORTED_URL", message: `该页面不支持操作（${t.url || "未知"}）` };
  }
  const restoreAfterMs = (params && params.restoreAfterMs) || BORROW_RESTORE_MS;
  // 用 document.hidden 判定而不是 tab.active：非聚焦窗口里的活动标签页 rAF 是正常的，
  // 那种情况不需要动它（实测 hidden=false、rAF=61）。
  let hidden = false;
  try {
    const probe = await pageEvaluate(tabId, { expression: "({hidden: document.hidden, vis: document.visibilityState})" });
    hidden = !!(probe && probe.result && probe.result.hidden);
  } catch (e) {
    // 探不到就按 tab.active 保守判断
    hidden = !t.active;
  }
  if (!hidden) {
    return { activated: false, alreadyRendering: true, hidden: false, tabId };
  }

  const prevTabId = await activeTabInWindow(t.windowId, tabId);
  // 只切标签页，不聚焦窗口：Chrome 非前台时同样能恢复 rAF，不把用户从别的应用里弹出来。
  await chrome.tabs.update(tabId, { active: true });
  clearBorrow(tabId);
  if (prevTabId != null) {
    borrowedActive.set(tabId, { prevTabId, windowId: t.windowId, at: Date.now(), timer: null, restoreMs: restoreAfterMs });
    touchBorrow(tabId);
  }
  // 让渲染器真正跑起来（等一两帧），否则调用方紧接着的操作可能仍撞在旧的 hidden 状态上。
  await sleepMs(250);
  return {
    activated: true, alreadyRendering: false, hidden: false, tabId,
    restoreAfterMs,
    willRestoreTo: prevTabId,
    note: prevTabId != null
      ? `已临时激活以保证渲染；${Math.round(restoreAfterMs / 1000)}s 无操作后自动切回标签页 ${prevTabId}（不聚焦窗口）`
      : "已激活以保证渲染（该窗口内没有可还原的原标签页）",
  };
}
// 打开一个 URL：优先复用同类「用户没在看」的标签页，绝不抢占用户正在浏览的页面。
//
// 复用候选默认排除：聚焦窗口的活动标签页（= 用户正在看，navigate 它会把人家的页面顶掉）、
// pinned、discarded、非 http(s)/file。没有可用候选时静默新开后台标签页
// （active:false，不切标签、不聚焦窗口）。
//
// 参数：{ url, match: "host"|"origin"|"exact", reuseActive, includePinned, windowId, waitLoad, timeoutMs }
// 返回：{ tab, tabId, reused, navigated, reason }
async function tabsResolve(params) {
  let url = params && params.url;
  if (!url) throw { code: "BAD_PARAMS", message: "缺少 url" };
  if (!/^(https?|file):\/\//i.test(url)) url = "https://" + url;
  const match = (params && params.match) || "host";
  const reuseActive = !!(params && params.reuseActive);
  const includePinned = !!(params && params.includePinned);
  const windowId = params && params.windowId;
  const waitLoad = !(params && params.waitLoad === false);
  const timeoutMs = (params && params.timeoutMs) || NAV_TIMEOUT_MS;

  // 「用户正在看」= 聚焦窗口的活动标签页。未聚焦窗口的 active tab 不打扰用户，可复用。
  const protectedIds = new Set();
  if (!reuseActive) {
    let focusedWindowId = null;
    try { const w = await chrome.windows.getLastFocused({}); focusedWindowId = w && w.id; } catch (e) { /* noop */ }
    const all = await chrome.tabs.query(windowId !== undefined ? { windowId } : {});
    for (const t of all) {
      if (!t.active) continue;
      if (focusedWindowId == null || t.windowId === focusedWindowId) protectedIds.add(t.id);
    }
  }

  const allTabs = await chrome.tabs.query(windowId !== undefined ? { windowId } : {});
  const sameKind = allTabs.filter((t) => urlMatches(t.url || "", url, match));
  const protectedSameKind = sameKind.filter((t) => protectedIds.has(t.id)).length;
  const candidates = sameKind
    .filter((t) => !protectedIds.has(t.id))
    .filter((t) => includePinned || !t.pinned)
    .filter((t) => !t.discarded)
    .filter((t) => /^(https?|file):/.test(t.url || ""))
    .sort((a, b) => b.index - a.index);   // 优先最近打开的（靠右）

  let lastErr = null;
  for (const cand of candidates) {
    try {
      // 候选健康检查：不跑解冻自愈——一个真被冻结的候选不值得为它挂调试器 + 等 13s，
      // 直接换下一个 / 落到新建（tabs.resolve 的语义是「找个能用的 tab」，不是「救活这个 tab」）。
      await ensureInjected(cand.id, { noRecover: true });
      try { await chrome.tabs.update(cand.id, { autoDiscardable: false }); } catch (e) { /* noop */ }
      if (cand.url === url) {
        // 目标页已在该 tab 打开：不重复导航（会整页刷新，丢状态且多发一次请求）
        const t = await chrome.tabs.get(cand.id);
        return { tab: serializeTab(t), tabId: cand.id, reused: true, navigated: false, reason: "reuse-existing-url" };
      }
      const r = await pageNavigate(cand.id, url, { waitLoad, timeoutMs });
      return { tab: r.tab, tabId: cand.id, reused: true, navigated: true, reason: "reuse-inactive-tab" };
    } catch (e) {
      lastErr = e;
      // 换下一个候选；全部失败则落到新建
    }
  }

  const props = { url, active: false };   // 静默：不切激活标签、不聚焦窗口
  if (windowId !== undefined) props.windowId = windowId;
  const created = await chrome.tabs.create(props);
  try { await chrome.tabs.update(created.id, { autoDiscardable: false }); } catch (e) { /* noop */ }
  if (waitLoad) await waitForLoad(created.id, timeoutMs).catch(() => null);
  const t = await chrome.tabs.get(created.id);
  return {
    tab: serializeTab(t), tabId: created.id, reused: false, navigated: true,
    reason: candidates.length
      ? `同类标签页不可用，已静默新开（最后一个错误 ${normalizeErrCode(lastErr)}）`
      : (protectedSameKind ? `同类标签页只有 ${protectedSameKind} 个且正在被用户看，已静默新开` : "无同类标签页，已静默新开"),
  };
}
function urlMatches(tabUrl, targetUrl, mode) {
  if (mode === "exact") return tabUrl === targetUrl;
  try {
    const a = new URL(tabUrl), b = new URL(targetUrl);
    if (mode === "origin") return a.origin === b.origin;
    return a.hostname === b.hostname;   // 默认 host：同域名即视为同类（含子域不同端口）
  } catch (e) {
    return tabUrl === targetUrl;
  }
}
// 静默准备：保证 content script 已注入 + 目标 tab 不会被后台冻结/回收。
// 全程不切 active tab、不聚焦窗口——用户在用别的应用时不会被抢焦点。
// 需要用户眼睛的步骤（登录/验证码/扫码/最终核对）才显式用 tabs.activate / page.focus。
async function tabsPrepare(tabId) {
  requireTabId(tabId);
  const t = await chrome.tabs.get(tabId);
  if (t.discarded) {
    // 已被浏览器/OneTab 冻结（discarded）的 tab 无法静默唤醒：注入会失败。
    // 明确报错，让 Agent 决定是否用 tabs.activate（激活即触发重载）。
    throw { code: "TAB_DISCARDED", message: `标签页已被冻结/丢弃（${t.title || t.url}），tabs.prepare 无法静默唤醒；请改用 tabs.activate（会切到该 tab 并重载页面）` };
  }
  try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch (e) { /* noop */ }
  // 注入失败先试一次解冻自愈（冻结的 tab 看上去与坏 tab 一模一样）。
  // ensureInjected 自带 CDP 解冻兜底；这里只是确保错误码区分得开：
  // 冻结能救回来就走成功路径，救不回来才报 PAGE_CONTEXT_TIMEOUT。
  try {
    await ensureInjected(tabId);
    clearBroken(tabId);   // 注入成功 => 上下文恢复正常，解除快速失败标记
  } catch (e) {
    markBroken(tabId);
    throw e;
  }
  return { ok: true, tabId };
}
async function tabsClose(tabId) {
  requireTabId(tabId);
  freezeState.delete(tabId);
  // 关掉一个正被「借前台」的 tab：先把活动页还给用户，否则前台会落在一个空位/随机页上。
  await restoreBorrowed(tabId, "closing").catch(() => null);
  await chrome.tabs.remove(tabId);
  return { ok: true, tabId };
}
async function tabsReload(tabId, params) {
  requireTabId(tabId);
  await chrome.tabs.reload(tabId, { bypassCache: !!params.bypassCache });
  await waitForLoad(tabId, params.timeoutMs || NAV_TIMEOUT_MS).catch(() => null);
  const t = await chrome.tabs.get(tabId);
  return { tab: serializeTab(t) };
}

// ---------- 页面导航 ----------
async function pageInfo(tabId) {
  requireTabId(tabId);
  const t = await chrome.tabs.get(tabId);
  return { tab: serializeTab(t) };
}
async function pageNavigate(tabId, url, params) {
  requireTabId(tabId);
  if (!url) throw { code: "BAD_PARAMS", message: "缺少 url" };
  if (!/^(https?|file):\/\//i.test(url)) url = "https://" + url;
  clearBroken(tabId);
  freezeState.delete(tabId);   // 导航成功 = 渲染器必然已被重新激活
  await chrome.tabs.update(tabId, { url });
  if (params.waitLoad !== false) {
    await waitForLoad(tabId, params.timeoutMs || NAV_TIMEOUT_MS).catch(() => {
      // 导航超时 = 页面上下文可能已销毁。打标记，让后续 evaluate 快速失败而不是每次空等
      // CONTENT_CALL_TIMEOUT_MS（实测一个坏 tab 会连累后续每个调用各挂满 60s）。
      brokenTabs.set(tabId, Date.now());
      throw { code: "NAV_TIMEOUT", message: `导航超时(${params.timeoutMs || NAV_TIMEOUT_MS}ms): ${url}` };
    });
  }
  const t = await chrome.tabs.get(tabId);
  return { tab: serializeTab(t) };
}
async function pageBack(tabId) {
  requireTabId(tabId);
  await chrome.tabs.goBack(tabId);
  await waitForLoad(tabId, NAV_TIMEOUT_MS).catch(() => null);
  const t = await chrome.tabs.get(tabId);
  return { tab: serializeTab(t) };
}
async function pageForward(tabId) {
  requireTabId(tabId);
  await chrome.tabs.goForward(tabId);
  await waitForLoad(tabId, NAV_TIMEOUT_MS).catch(() => null);
  const t = await chrome.tabs.get(tabId);
  return { tab: serializeTab(t) };
}
async function pageFocus(tabId) {
  requireTabId(tabId);
  await tabsActivate(tabId);
  return { ok: true, tabId };
}

// 把活动标签页还给用户（收工/提前归还用；不等到闲置计时器到期）。
async function pageRestoreActive(tabId) {
  requireTabId(tabId);
  const restored = await restoreBorrowed(tabId, "explicit");
  return { ok: true, tabId, restoredTo: restored };
}

// ---------- 导航等待 ----------
const navWaiters = new Map();
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  const w = navWaiters.get(details.tabId);
  if (w && w.pending) {
    w.pending = false;
    clearTimeout(w.timer);
    navWaiters.delete(details.tabId);
    w.resolve();
  }
});

function waitForLoad(tabId, timeoutMs = NAV_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let done = false;
    let poll = null;
    const finish = (fn, ...args) => {
      if (done) return;
      done = true;
      const w = navWaiters.get(tabId);
      if (w) { clearTimeout(w.timer); navWaiters.delete(tabId); }
      if (poll) clearInterval(poll);
      fn(...args);
    };
    const timer = setTimeout(() => finish(reject, { code: "NAV_TIMEOUT", message: "页面加载等待超时" }), timeoutMs);
    navWaiters.set(tabId, { resolve: () => finish(resolve), pending: true, timer });
    poll = setInterval(async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "complete") {
          const w = navWaiters.get(tabId);
          if (w && w.pending) finish(resolve);
        }
      } catch (e) {
        finish(reject, { code: "TAB_GONE", message: "标签页不存在或已关闭" });
      }
    }, 400);
  });
}

// ---------- 增强等待 API（BOSS 重型 SPA，不依赖固定 sleep） ----------
// 等 URL 包含/匹配指定片段（SPA 跳转后 URL 变化）
function waitForUrl(tabId, params) {
  requireTabId(tabId);
  const timeout = (params && params.timeoutMs) || 30000;
  const interval = (params && params.intervalMs) || 300;
  const match = params && params.match;            // 字符串 includes；字符串(解析成)正则 test
  const equals = params && params.equals;          // 严格 ===
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        const url = t.url || "";
        let ok = false;
        if (equals) ok = url === equals;
        else if (match) ok = typeof match === "string" ? url.includes(match) : new RegExp(match).test(url);
        else ok = true;
        if (ok) return resolve({ ok: true, url, waitedMs: Date.now() - start });
        if (Date.now() - start > timeout) return reject({ code: "NAV_TIMEOUT", message: `waitForUrl 超时(${timeout}ms): 期望 ${match || equals || "?"}, 实际 ${url}` });
        setTimeout(tick, interval);
      } catch (e) {
        reject({ code: "TAB_GONE", message: "标签页不存在或已关闭" });
      }
    };
    tick();
  });
}
// 等 document.readyState 达到指定状态
function waitForReady(tabId, timeoutMs) {
  requireTabId(tabId);
  const timeout = timeoutMs || 30000;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "complete") return resolve({ ok: true, status: t.status, waitedMs: Date.now() - start });
        if (Date.now() - start > timeout) return reject({ code: "NAV_TIMEOUT", message: `waitForReady 超时(${timeout}ms)` });
        setTimeout(tick, 300);
      } catch (e) {
        reject({ code: "TAB_GONE", message: "标签页不存在或已关闭" });
      }
    };
    tick();
  });
}
// 等 selector 出现（用 contentCall 的 waitFor，统一超时）
async function waitForSelector(tabId, params) {
  requireTabId(tabId);
  return contentCall(tabId, "waitFor", {
    selector: params.selector, by: params.by || "css",
    timeoutMs: params.timeoutMs || 30000, intervalMs: params.intervalMs || 300,
  });
}

// ---------- 滚动推进检测 ----------
// 为什么单立一条：后台标签页 rAF 被暂停时，`window.scrollBy` 这类直接 DOM 操作**仍然生效**
// （实测滚动位置会变），但依赖 rAF / IntersectionObserver 回调的**懒加载不会触发**，
// 页面高度不增长。调用方看到 `{ok:true}` 就接着往下走，于是拿到空列表还以为是站点改版。
// 所以校验要分两层：
//   - 视口没动（moved=false）—— 明确异常，报 SCROLL_STALLED；
//   - 高度没长（grew=false）—— 语义模糊（可能是到底了，也可能是懒加载没触发），
//     默认只作为字段返回，调用方声明 `expectGrowth:true` 时才报 SCROLL_NO_GROWTH。
function scrollSignature(tabId) {
  return pageEvaluate(tabId, {
    expression: `({
      y: window.scrollY, h: document.documentElement.scrollHeight,
      ih: window.innerHeight, hidden: document.hidden,
      canScroll: document.documentElement.scrollHeight > window.innerHeight + 4
    })`,
  }).then((r) => (r && r.result) || null).catch(() => null);
}

const RENDER_HINT =
  "若需继续加载，先调 page.ensureActive { tabId } 临时激活以保证渲染" +
  "（只切标签页不聚焦窗口，用完自动还原），或确认已到底后停止。";

async function pageScrollChecked(tabId, params) {
  requireTabId(tabId);
  const before = await scrollSignature(tabId);
  const res = await pageAction(tabId, "scroll", params);
  // 让滚动 / 懒加载真正落地后再采样
  await sleepMs(params && params.settleMs != null ? params.settleMs : 600);
  const after = await scrollSignature(tabId);
  if (!before || !after) {
    return { ...(res || {}), checked: false, note: "无法采样页面状态，已跳过校验" };
  }

  const grew = after.h > before.h + 2;
  const moved = Math.abs(after.y - before.y) > 2;
  const atBottom = after.y + after.ih >= after.h - 4;
  const out = {
    ...(res || {}), checked: true, grew, moved, atBottom,
    heightBefore: before.h, heightAfter: after.h, yBefore: before.y, yAfter: after.y,
    wasHidden: before.hidden,
  };

  if (params && params.allowNoProgress) return { ...out, note: "已允许无推进（allowNoProgress）" };
  // 内容不满一屏：不能滚是正常的，不是失败
  if (!before.canScroll) return { ...out, note: "页面内容不满一屏，无需滚动" };

  // 视口完全没动：明确异常（真到底了也会 moved，因为到底前的最后一滚仍改变位置）
  if (!moved) {
    throw {
      code: "SCROLL_STALLED",
      message: `滚动未生效（位置始终 ${after.y}，页面高 ${after.h}）${before.hidden ? "；当前为后台标签页" : ""}。` +
        `可能原因：选择器/容器不可滚、页面接管了滚动。${RENDER_HINT}`,
      atBottom, wasHidden: before.hidden,
      // 后台才可能是渲染被暂停；前台还没动就是选择器/容器问题，激活也没用。
      recoverable: !!before.hidden,
    };
  }

  // 调用方声明了「这一滚应该加载出新内容」但高度没长。
  // 注意：**不能因为 atBottom 就放过**——懒加载的哨兵元素本来就在列表末尾，
  // 「到底部」正是应该触发加载的位置；用 atBottom 做例外等于把这个信号关掉。
  // 但 atBottom 仍会随错误返回，供调用方区分「真的到底了」与「卡住了」。
  if (params && params.expectGrowth && !grew) {
    // 后台标签页里 atBottom 不可信：同一位置在激活后会加载出更多内容（实测），
    // 所以后台场景一律归因为渲染被暂停。
    const msg = before.hidden
      ? `滚动生效了（${before.y}→${after.y}）但页面没有加载出新内容（高 ${before.h} 未变）；` +
        `当前是后台标签页，懒加载靠 rAF/IntersectionObserver 触发而 Chrome 已暂停渲染。${RENDER_HINT}`
      : `滚动生效了（${before.y}→${after.y}）但页面没有加载出新内容（高 ${before.h} 未变，atBottom=${atBottom}）。` +
        `若 atBottom=true 说明可能真的到底了，可改用 allowNoProgress 收尾；否则${RENDER_HINT}`;
    throw {
      code: "SCROLL_NO_GROWTH", message: msg, atBottom, wasHidden: before.hidden,
      // 关键信号：后台 → 激活能解决；前台且 atBottom → 大概率真到底了，激活无用。
      recoverable: !!before.hidden || !atBottom,
    };
  }

  return out;
}

// ---------- Content Script 消息 ----------
// 渲染器被冻结（Chrome Memory Saver / 高能效模式）时，chrome.scripting 的所有调用都会
// 挂满超时才失败，而 CDP 通道完好。实测复现：
//   冻结后 scripting executeScript = 13s 后 PAGE_CONTEXT_TIMEOUT；CDP Runtime.evaluate = 32ms 正常。
// 这曾是最主要的失败源（host.log 433 次 PAGE_CONTEXT_TIMEOUT，tabs.prepare 失败率 34%，
// 耗时整齐卡在 13s / 26s = ping 3s + 注入 10s 的整数倍）。
// 对策：scripting 失败时先用 CDP 把渲染器解冻（Page.setWebLifecycleState: active），再重试一次。
// 解冻成功后脚本层立刻恢复毫秒级响应（实测 5/5 成功）。
async function ensureInjected(tabId, opts) {
  try {
    return await ensureInjectedOnce(tabId);
  } catch (e) {
    if (e && e.code !== "PAGE_CONTEXT_TIMEOUT") throw e;
    if (opts && opts.noRecover) throw e;
    // 疑似渲染器被冻结：解冻后重试一次。
    // 冷却中 / CDP 不可用（用户 DevTools 占用等）则原样抛出，调用方拿到快速失败。
    if (!(await recoverFrozenTab(tabId))) throw e;
    clearBroken(tabId);
    await sleepMs(120);
    return await ensureInjectedOnce(tabId);
  }
}

async function ensureInjectedOnce(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (!/^(https?|file):/.test(t.url || "")) {
      throw { code: "UNSUPPORTED_URL", message: `该页面不支持注入（${t.url || "未知"}）` };
    }
  } catch (e) {
    if (e && e.code === "UNSUPPORTED_URL") throw e;
    throw { code: "TAB_GONE", message: "标签页不存在" };
  }
  // ⚠️ chrome.tabs.sendMessage 对「content script 不存在」不会 reject，会一直挂起。
  // 旧标签页（扩展 reload 前打开、实例被销毁）就会命中：ping 永不返回，
  // 外层 RPC 只能等满 CONTENT_CALL_TIMEOUT_MS（实测一个坏 tab 连累后续每个调用各挂 60s）。
  // 这里统一加超时，把「挂起」变成「快速可判定」。
  const pingOnce = () => withTimeout(
    chrome.tabs.sendMessage(tabId, { type: "bridge.ping" }),
    PING_TIMEOUT_MS,
    "PING_TIMEOUT",
    `content script 无响应(${PING_TIMEOUT_MS}ms)`
  );
  try {
    await pingOnce();
    clearBroken(tabId);
    return;
  } catch (e) { /* 未注入或超时：走注入流程 */ }
  try {
    await withTimeout(
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }),
      INJECT_TIMEOUT_MS,
      "PAGE_CONTEXT_TIMEOUT",
      `注入 content script 超时(${INJECT_TIMEOUT_MS}ms)`
    );
  } catch (e2) {
    markBroken(tabId);
    if (e2 && e2.code === "PAGE_CONTEXT_TIMEOUT") throw e2;
    throw { code: "PAGE_CONTEXT_TIMEOUT", message: `注入 content script 失败: ${e2 && e2.message || e2}` };
  }
  await sleepMs(50);
  try {
    await pingOnce();
    clearBroken(tabId);
  } catch (e2) {
    markBroken(tabId);
    throw { code: "PAGE_CONTEXT_TIMEOUT", message: `content script 注入后仍无响应: ${e2 && e2.message || e2}` };
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// 内部超时：包裹 sendMessage，避免 BOSS SPA 上下文销毁后卡死
function withTimeout(promise, timeoutMs, code, message) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject({ code, message });
    }, timeoutMs);
    Promise.resolve(promise).then(
      (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
      (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); }
    );
  });
}

const CONTENT_CALL_TIMEOUT_MS = 30000;

async function contentCall(tabId, action, args) {
  requireTabId(tabId);
  if (isBroken(tabId)) {
    throw { code: "PAGE_CONTEXT_TIMEOUT", message: `页面上下文失效（tab ${tabId}）；请重新 page.navigate 或 tabs.prepare 后再试` };
  }
  await ensureInjected(tabId);
  let resp;
  try {
    resp = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: "bridge.action", action, args: args || {} }),
      CONTENT_CALL_TIMEOUT_MS,
      "CONTENT_TIMEOUT",
      `content 调用超时(${CONTENT_CALL_TIMEOUT_MS}ms): ${action}`
    );
  } catch (e) {
    if (e && e.code === "CONTENT_TIMEOUT") throw e;
    throw { code: "PAGE_CONTEXT_TIMEOUT", message: `content 通道异常: ${e && e.message || e}` };
  }
  if (!resp) throw { code: "NO_RESPONSE", message: "content script 无响应" };
  if (resp.ok === false) {
    const err = new Error(resp.error && resp.error.message ? resp.error.message : "content 执行失败");
    err.code = (resp.error && resp.error.code) || "CONTENT_ERROR";
    // details 必须带上：errorPayload() 靠它把 AGENT_STOPPED 的 resumeWith/stoppedAt
    // 以及 SCROLL_* 的 recoverable 透到 host 与客户端。
    if (resp.error && resp.error.details) err.details = resp.error.details;
    throw err;
  }
  return resp.result;
}

async function indicatorCall(tabId, payload) {
  requireTabId(tabId);
  // sendMessage 对「页面没有 content script」会挂起而非 reject；这里加超时，
  // 让 indicator（每个 page.* 的前置步骤）不会成为整条 RPC 的卡点。
  const send = () => withTimeout(
    chrome.tabs.sendMessage(tabId, { type: "bridge.indicator", ...payload }),
    PING_TIMEOUT_MS,
    "PING_TIMEOUT",
    `indicator 无响应(${PING_TIMEOUT_MS}ms)`
  );
  try {
    const resp = await send();
    return resp || { ok: true };
  } catch (e) {
    // 页面没有 indicator 实例（扩展 reload 前的旧标签页 / 实例被销毁）：按需补注入再重发。
    // indicator.js 自带幂等守卫（__AGENT_BRIDGE_INDICATOR__），重复注入无害；
    // chrome:// 等受保护页注入会失败，静默忽略。
    try {
      await withTimeout(
        chrome.scripting.executeScript({ target: { tabId }, files: ["indicator.js"] }),
        INJECT_TIMEOUT_MS,
        "PAGE_CONTEXT_TIMEOUT",
        `indicator 注入超时(${INJECT_TIMEOUT_MS}ms)`
      );
      const resp = await send();
      return resp || { ok: true };
    } catch (e2) {
      return { ok: true, skipped: true };
    }
  }
}

// 自愈清扫：扩展启动/更新后，旧标签页里被销毁的 indicator 实例可能留下
// 「● [Agent] 接管中 | 原标题」的标题残影（reload 或页面冻结场景，页面端计时器已不存在）。
// 对这类 tab 补注入 indicator 并发送 released——released 分支会剥掉「● …接管中 |」前缀恢复原标题。
function sweepStaleControlTitles() {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id || !tab.title) continue;
      if (!/^●\s*\[[^\]]+\]\s*接管中\s*\|/.test(tab.title)) continue;
      indicatorCall(tab.id, { action: "setControl", state: "released" }).catch(() => {});
    }
  });
  clearAllTabControlBadges();
}

// ---------- 页面操作 ----------
async function pageSnapshot(tabId, params) {
  return contentCall(tabId, "snapshot", {
    mode: (params && params.mode) || "a11y",
    maxDepth: params && params.maxDepth,
    maxNodes: params && params.maxNodes,
    includeText: params && params.includeText,
  });
}

async function pageEvaluate(tabId, params) {
  requireTabId(tabId);
  if (!params || !params.expression) throw { code: "BAD_PARAMS", message: "缺少 expression" };
  // 该 tab 刚经历过导航超时/上下文失效：立即快速失败，避免每个调用空等 60s。
  if (isBroken(tabId)) {
    throw { code: "PAGE_CONTEXT_TIMEOUT", message: `页面上下文失效（tab ${tabId} 上一次导航超时）；请重新 page.navigate 或 tabs.prepare 后再试` };
  }
  await ensureInjected(tabId);
  let resp;
  try {
    resp = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        // 默认 MAIN world；只在显式 ISOLATED 时切换。BOSS 读 DOM 用 ISOLATED 也安全可控。
        world: params.world === "ISOLATED" ? "ISOLATED" : "MAIN",
        func: (expression, awaitPromise) => {
      const wrap = (v) => {
        if (v === undefined) return { __type: "undefined" };
        if (v === null) return null;
        if (typeof v === "function") return { __type: "function" };
        if (typeof v === "bigint") return { __type: "bigint", value: v.toString() };
        if (v instanceof Node) {
          if (v instanceof Element) return { __type: "element", tag: v.tagName, id: v.id || null, text: (v.textContent || "").slice(0, 500), href: v.href || null, value: v.value !== undefined ? v.value : null };
          return { __type: "node", nodeType: v.nodeType, name: v.nodeName };
        }
        if (typeof v === "object") {
          try {
            return JSON.parse(JSON.stringify(v, (k, val) => {
              if (typeof val === "bigint") return { __type: "bigint", value: val.toString() };
              if (typeof val === "function") return { __type: "function" };
              return val;
            }));
          } catch (e) {
            return { __type: "unserializable", error: String(e), str: String(v).slice(0, 500) };
          }
        }
        return v;
      };
      if (awaitPromise) {
        return new Promise((resolve) => {
          Promise.resolve().then(() => eval(expression)).then((v) => resolve(wrap(v))).catch((e) => resolve({ __type: "error", message: String(e && e.stack || e) }));
        });
      }
      try {
        return wrap(eval(expression));
      } catch (e) {
        return { __type: "error", message: String(e && e.stack || e) };
      }
    },
      args: [params.expression, !!params.awaitPromise],
      }),
      EVAL_TIMEOUT_MS,
      "PAGE_CONTEXT_TIMEOUT",
      `page.evaluate 超时(${EVAL_TIMEOUT_MS}ms): 页面可能已导航/上下文销毁`
    );
  } catch (e) {
    // 超时/失败都标记上下文失效：后续调用立即快速失败，不再逐个空等。
    markBroken(tabId);
    if (e && (e.code === "PAGE_CONTEXT_TIMEOUT")) throw e;
    // executeScript 在页面导航/上下文销毁时报 "Cannot access contents of the page"
    throw { code: "PAGE_CONTEXT_TIMEOUT", message: `executeScript 失败: ${e && e.message || e}` };
  }
  clearBroken(tabId);
  const out = resp && resp[0] && resp[0].result;
  if (out && out.__type === "error") {
    // 严格 CSP（缺 unsafe-eval，如 github.com）/ Trusted Types 站点会让注入的 `eval(expression)`
    // 直接抛 EvalError。CDP Runtime.evaluate 走 DevTools 通道，不受页面 CSP 与 Trusted Types 约束，
    // 因此这里自动兜底重试一次，而不是把 EVAL_ERROR 抛给调用方。
    const msg = String(out.message || "");
    const cspBlocked = /Content Security Policy|unsafe-eval|Trusted Type/i.test(msg);
    if (cspBlocked) {
      const viaCdp = await cdpEvaluate(tabId, params);
      if (viaCdp) return viaCdp;
    }
    throw { code: "EVAL_ERROR", message: out.message };
  }
  return { result: out };
}

async function pageAction(tabId, action, params) {
  return contentCall(tabId, action, params);
}

// ---------- page.inspect：内置页面探查（Agent 无需写 JS，一次调用拿页面结构与状态） ----------
// 用法: page.inspect { tabId, focus: "overview"|"links"|"media"|"scroll"|"modal"|"sel", selector?, limit?, world? }
// 设计要点:
//   - 探查函数以【函数引用】传给 chrome.scripting.executeScript，函数体是普通 JS 源码，
//     正则直接写 \d/\s 即可，完全避开模板字符串转义坑（单反斜杠被丢弃成 d 的静默失败）。
//   - 只读操作，不点任何元素、不滚动页面、不产生副作用。
const INSPECT_FUNCS = {
  // 页面概览：URL/标题/弹窗/滚动/卡片/搜索框/可滚动容器
  overview: function (p) {
    const mask = document.querySelector(".note-detail-mask") || document.querySelector('[class*="modal"][class*="mask"]');
    const mr = mask ? mask.getBoundingClientRect() : null;
    const cards = document.querySelectorAll('section[class*="item"], article, [class*="card"]');
    const scrollables = [];
    const all = document.querySelectorAll("*");
    for (let i = 0; i < all.length && scrollables.length < 8; i++) {
      const el = all[i];
      if (el.scrollHeight > el.clientHeight + 50) {
        scrollables.push({ tag: el.tagName, cls: String(el.className || "").slice(0, 50), client: el.clientHeight, scroll: el.scrollHeight, top: el.scrollTop });
      }
    }
    const searchBoxes = [];
    document.querySelectorAll('input[type="search"], input[placeholder*="搜索"], [class*="search"] input, [class*="search-input"]').forEach((el) => {
      if (searchBoxes.length < 3) searchBoxes.push({ placeholder: el.getAttribute("placeholder") || "", cls: String(el.className || "").slice(0, 40) });
    });
    return {
      url: location.href.slice(0, 200),
      title: (document.title || "").slice(0, 80),
      readyState: document.readyState,
      hasModal: !!mask,
      modalVisible: mr ? (mr.width > 0 && mr.height > 0) : false,
      scrollY: window.scrollY,
      docScrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      cardCount: cards.length,
      scrollables,
      searchBoxes,
      iframes: document.querySelectorAll("iframe").length,
      bodyTextLen: (document.body.innerText || "").length
    };
  },

  // 列表卡片链接 + 可见性（防点 display:none 隐藏链接触发风控/404）
  links: function (p) {
    const n = (p && p.limit) || 6;
    const sel = (p && p.selector) || 'section[class*="item"], article, [class*="card"]';
    const cards = Array.from(document.querySelectorAll(sel)).slice(0, n);
    return cards.map((c, i) => {
      const links = [];
      c.querySelectorAll("a").forEach((a) => {
        const r = a.getBoundingClientRect();
        links.push({
          href: (a.href || "").slice(0, 120),
          visible: r.width > 0 && r.height > 0 && getComputedStyle(a).display !== "none",
          cls: String(a.className || "").slice(0, 40)
        });
      });
      return { index: i, text: (c.innerText || "").replace(/\s+/g, " ").slice(0, 80), links };
    });
  },

  // 图片/视频/live photo/blob
  media: function () {
    const imgs = [];
    document.querySelectorAll("img").forEach((img) => {
      if (imgs.length >= 20) return;
      const r = img.getBoundingClientRect();
      imgs.push({
        src: (img.currentSrc || img.src || "").slice(0, 140),
        dataSrc: img.getAttribute("data-src") ? img.getAttribute("data-src").slice(0, 140) : null,
        nw: img.naturalWidth,
        visible: r.width > 0 && r.height > 0 && getComputedStyle(img).display !== "none",
        cls: String(img.className || "").slice(0, 30)
      });
    });
    const vids = [];
    document.querySelectorAll("video").forEach((v) => {
      vids.push({ src: (v.src || "").slice(0, 100), poster: (v.poster || "").slice(0, 140), hasBlob: (v.src || "").startsWith("blob:") });
    });
    const blobs = [];
    document.querySelectorAll('[src*="blob:"], [poster*="blob:"]').forEach((el) => {
      blobs.push({ tag: el.tagName, v: (el.src || el.poster || "").slice(0, 100) });
    });
    return { imgCount: document.querySelectorAll("img").length, imgs, vids, blobs };
  },

  // 可滚动容器（找"该滚哪个"）
  scroll: function (p) {
    const n = (p && p.limit) || 15;
    const out = [];
    const all = document.querySelectorAll("*");
    for (let i = 0; i < all.length && out.length < n; i++) {
      const el = all[i];
      if (el.scrollHeight > el.clientHeight + 50) {
        out.push({ tag: el.tagName, cls: String(el.className || "").slice(0, 60), id: el.id || "", clientH: el.clientHeight, scrollH: el.scrollHeight, top: Math.round(el.scrollTop), overflowY: getComputedStyle(el).overflowY });
      }
    }
    return out;
  },

  // 弹窗详情（存在/尺寸/内部滚动区/评论数/互动）
  modal: function () {
    const mask = document.querySelector(".note-detail-mask") || document.querySelector('[class*="modal"][class*="mask"]');
    if (!mask) return { hasModal: false };
    const r = mask.getBoundingClientRect();
    const scrollers = [];
    mask.querySelectorAll("*").forEach((el) => {
      if (scrollers.length < 6 && el.scrollHeight > el.clientHeight + 50) {
        scrollers.push({ tag: el.tagName, cls: String(el.className || "").slice(0, 50), client: el.clientHeight, scroll: el.scrollHeight });
      }
    });
    const comments = mask.querySelectorAll('[class*="comment-item"]').length;
    const titleEl = mask.querySelector(".title");
    const bar = mask.querySelector(".engage-bar");
    return {
      hasModal: true,
      w: Math.round(r.width), h: Math.round(r.height),
      title: titleEl ? (titleEl.innerText || "").slice(0, 60) : "",
      commentCount: comments,
      engageText: bar ? (bar.innerText || "").replace(/\s+/g, " ").slice(0, 60) : "",
      scrollers
    };
  },

  // 任意选择器 dump
  sel: function (p) {
    const sel = (p && p.selector) || "";
    if (!sel) return { error: "缺少 selector 参数" };
    const n = (p && p.limit) || 8;
    const els = Array.from(document.querySelectorAll(sel)).slice(0, n);
    return {
      count: document.querySelectorAll(sel).length,
      sample: els.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          cls: String(el.className || "").slice(0, 50),
          id: el.id || "",
          text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 100),
          visible: r.width > 0 && r.height > 0,
          html: el.outerHTML.slice(0, 200)
        };
      })
    };
  },
};

async function pageInspect(tabId, params) {
  requireTabId(tabId);
  const focus = (params && params.focus) || "overview";
  const func = INSPECT_FUNCS[focus];
  if (!func) throw { code: "BAD_PARAMS", message: `focus 仅支持: ${Object.keys(INSPECT_FUNCS).join("/")}` };
  await ensureInjected(tabId);
  let resp;
  try {
    resp = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        // 默认 MAIN world；只在显式 ISOLATED 时切换
        world: params && params.world === "ISOLATED" ? "ISOLATED" : "MAIN",
        func,
        args: [params || {}],
      }),
      EVAL_TIMEOUT_MS,
      "PAGE_CONTEXT_TIMEOUT",
      `page.inspect 超时(${EVAL_TIMEOUT_MS}ms): 页面可能已导航/上下文销毁`
    );
  } catch (e) {
    markBroken(tabId);
    if (e && (e.code === "PAGE_CONTEXT_TIMEOUT")) throw e;
    throw { code: "PAGE_CONTEXT_TIMEOUT", message: `executeScript 失败: ${e && e.message || e}` };
  }
  const out = resp && resp[0] && resp[0].result;
  return { result: out, focus };
}

// ---------- 会话记录（Clarity 式轻量版：记录页面变化过程时间线，供 Agent 事后分析） ----------
// content script 的 recorder 监听页面变化，事件经 bridge.recordEvent 上报到这里，
// 按 tabId 存环形缓冲（上限 RECORD_LIMIT 条）。Agent 用 page.record.get 拉取时间线分析。
const RECORD_LIMIT = 1000;
const recordStore = new Map(); // tabId -> { running, events: [{t,type,data}], startedAt }

function recordState(tabId) {
  const st = recordStore.get(tabId);
  return st || { running: false, events: [], startedAt: 0 };
}

function recordPush(tabId, event) {
  if (!event || !event.type) return;
  let st = recordStore.get(tabId);
  if (!st) { st = { running: false, events: [], startedAt: 0 }; recordStore.set(tabId, st); }
  st.events.push({ t: event.t || Date.now(), type: event.type, data: event.data || {} });
  if (st.events.length > RECORD_LIMIT) st.events.splice(0, st.events.length - RECORD_LIMIT);
}

function recordSetRunning(tabId, running) {
  let st = recordStore.get(tabId);
  if (!st) { st = { running: false, events: [], startedAt: 0 }; recordStore.set(tabId, st); }
  st.running = running;
  if (running && !st.startedAt) st.startedAt = Date.now();
}

async function notifyRecorder(tabId, running) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "bridge.recorder.control", running });
  } catch (e) { /* content 未注入或已销毁：状态仍记录，注入后 wantState 会自动恢复 */ }
}

async function pageRecordStart(tabId) {
  requireTabId(tabId);
  await ensureInjected(tabId);
  recordSetRunning(tabId, true);
  await notifyRecorder(tabId, true);
  return { running: true, tabId };
}

async function pageRecordStop(tabId) {
  requireTabId(tabId);
  recordSetRunning(tabId, false);
  await notifyRecorder(tabId, false);
  return { running: false, tabId };
}

function pageRecordStatus(tabId) {
  requireTabId(tabId);
  const st = recordState(tabId);
  const last = st.events.length ? st.events[st.events.length - 1] : null;
  const byType = {};
  for (const e of st.events) byType[e.type] = (byType[e.type] || 0) + 1;
  return { running: st.running, count: st.events.length, startedAt: st.startedAt, lastAt: last ? last.t : 0, byType };
}

function pageRecordGet(tabId, params) {
  requireTabId(tabId);
  const st = recordState(tabId);
  const since = params && params.since || 0;
  const types = params && params.types;
  const limit = params && params.limit || 500;
  let events = st.events.filter((e) => e.t >= since);
  if (types && types.length) {
    const set = new Set(Array.isArray(types) ? types : [types]);
    events = events.filter((e) => set.has(e.type));
  }
  events = events.slice(-limit);
  return { running: st.running, count: events.length, total: st.events.length, events };
}

function pageRecordClear(tabId) {
  requireTabId(tabId);
  const st = recordState(tabId);
  st.events = [];
  return { cleared: true };
}

// ---------- 截图 ----------
// 默认静默：优先 CDP 截图（后台 tab 也可用，不抢焦点）。
// CDP 失败时不再偷偷激活 tab / 聚焦窗口；只有显式 allowActivate:true 才降级到
// captureVisibleTab（该 API 要求目标 tab 是窗口内激活 tab）。显式激活请用 page.activateAndShot。
async function pageScreenshot(tabId, params) {
  requireTabId(tabId);
  const format = (params && params.format) || "png";
  if (!["png", "jpeg"].includes(format)) throw { code: "BAD_PARAMS", message: "format 仅支持 png/jpeg" };
  const quality = params.quality || 90;
  // 默认视口截图（快、稳定）；captureBeyondViewport=true 时才做整页截图（长页面可能较慢）
  const captureBeyondViewport = params.captureBeyondViewport === true;
  const allowActivate = params.allowActivate === true;
  try {
    const shot = await cdpScreenshot(tabId, format, quality, captureBeyondViewport);
    return { format, image: shot.data, type: "dataURL", captureMode: "cdp" };
  } catch (e) {
    if (!allowActivate) {
      throw { code: "SCREENSHOT_FAILED", message: `截图失败: ${e && e.message || e}（静默模式不激活窗口；若可接受浏览器跳到前台，用 page.activateAndShot 或传 allowActivate:true）` };
    }
    console.warn("[bridge] cdp screenshot failed, fallback to visible tab", e && e.message);
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e2) { /* noop */ }
    await new Promise((r) => setTimeout(r, 300));
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format, quality });
    return { format, image: dataUrl, type: "dataURL", captureMode: "visibleTab" };
  } catch (e) {
    throw { code: "SCREENSHOT_FAILED", message: `截图失败: ${e && e.message || e}（若提示 activeTab 权限，请先点击一次扩展图标授予权限）` };
  }
}
async function pageActivateAndShot(tabId, params) {
  requireTabId(tabId);
  await tabsActivate(tabId);
  await new Promise((r) => setTimeout(r, 400));
  return pageScreenshot(tabId, { ...(params || {}), allowActivate: true });
}
function cdpScreenshot(tabId, format, quality, captureBeyondViewport) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { chrome.debugger.detach({ tabId }, () => { /* noop */ }); } catch (e) { /* noop */ }
      reject(new Error("CDP 截图超时（页面可能过大或忙碌）"));
    }, 20000);
    chrome.debugger.attach({ tabId }, "1.3", async () => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        reject(new Error(chrome.runtime.lastError.message || "debugger attach failed"));
        return;
      }
      try {
        const result = await new Promise((res2, rej2) => {
          chrome.debugger.sendCommand(
            { tabId }, "Page.captureScreenshot",
            { format, quality: format === "jpeg" ? quality : undefined, captureBeyondViewport },
            (resp) => {
              if (chrome.runtime.lastError) rej2(new Error(chrome.runtime.lastError.message));
              else res2(resp);
            }
          );
        });
        clearTimeout(timer);
        resolve({ data: "data:image/" + format + ";base64," + result.data });
      } catch (e) {
        clearTimeout(timer);
        throw e;
      } finally {
        try { chrome.debugger.detach({ tabId }, () => { /* noop */ }); } catch (e) { /* noop */ }
      }
    });
  });
}

// 我们自己附加的 CDP 会话（tabId 集合）。与「用户手动打开的 DevTools」区分开：
// 只有集合内的 tab 才允许 session.send，且 session.detach / 调试目标卸载时移除。
const cdpSessions = new Set();

// ---------- CDP 兜底求值（严格 CSP / Trusted Types 站点） ----------
// 页面 CSP 缺 'unsafe-eval' 或有 Trusted Types 时，chrome.scripting 注入的 eval() 会被拦。
// CDP Runtime.evaluate 经 DevTools 通道执行，不受二者限制。
// 注意：attach 期间 Chrome 会在该 tab 顶部显示「正在调试此浏览器」条，故用完立即 detach。
function cdpEvaluate(tabId, params) {
  const expr = params.expression;
  const awaitPromise = !!params.awaitPromise;
  // CDP 不共享页面的 wrap() 序列化逻辑，包一层等价实现：结果统一走 JSON 安全化。
  const wrapped = `(function(){
    var __wrap = function(v){
      if (v === undefined) return { __type: "undefined" };
      if (v === null) return null;
      if (typeof v === "function") return { __type: "function" };
      if (typeof v === "bigint") return { __type: "bigint", value: String(v) };
      if (typeof Node !== "undefined" && v instanceof Node) {
        if (v instanceof Element) return { __type: "element", tag: v.tagName, id: v.id || null, text: String(v.textContent || "").slice(0, 500), href: v.href || null, value: v.value !== undefined ? v.value : null };
        return { __type: "node", nodeType: v.nodeType, name: v.nodeName };
      }
      if (typeof v === "object") {
        try { return JSON.parse(JSON.stringify(v, function(k, val){
          if (typeof val === "bigint") return { __type: "bigint", value: String(val) };
          if (typeof val === "function") return { __type: "function" };
          return val;
        })); } catch (e) { return { __type: "unserializable", error: String(e), str: String(v).slice(0, 500) }; }
      }
      return v;
    };
    var __run = function(){ return __wrap(eval(${JSON.stringify(expr)})); };
    return ${awaitPromise ? "Promise.resolve().then(__run)" : "__run()"};
  })()`;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; try { chrome.debugger.detach({ tabId }, () => {}); } catch (e) { /* noop */ } resolve(v); };
    const timer = setTimeout(() => done(null), Math.min(CONTENT_CALL_TIMEOUT_MS, 20000));
    let attached = false;
    try {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) { clearTimeout(timer); return done(null); }
        attached = true;
        chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
          expression: wrapped,
          awaitPromise,
          returnByValue: true,
          userGesture: true,
        }, (resp) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError || !resp) return done(null);
          if (resp.exceptionDetails) {
            // 表达式本身报错：仍然返回，但标成 error，让调用方看到真实原因
            return done(null);
          }
          const v = resp.result && resp.result.value;
          done({ result: v, via: "cdp" });
        });
      });
    } catch (e) {
      clearTimeout(timer);
      if (attached) { try { chrome.debugger.detach({ tabId }, () => {}); } catch (e2) { /* noop */ } }
      done(null);
    }
  });
}

// ---------- CDP Session ----------
async function sessionAttach(tabId) {
  requireTabId(tabId);
  if (cdpSessions.has(tabId)) return { attached: true, tabId, already: true };
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (!err) { cdpSessions.add(tabId); return resolve(); }
      const m = String(err.message || "");
      // 我们自己已附加过（上一次 detach 漏掉 / 并发重复 attach）：视作已就绪，不报错。
      if (/already attached/i.test(m)) { cdpSessions.add(tabId); return resolve(); }
      // 真正的占用者是用户手动打开的 DevTools：不能抢，明确告知。
      if (/Another debugger|already has/i.test(m)) {
        return reject({ code: "DEBUGGER_BUSY", message: `该标签页已被其他调试器占用（通常是用户打开的 DevTools）：${m}` });
      }
      reject({ code: "SESSION_ATTACH_FAILED", message: m });
    });
  });
  return { attached: true, tabId };
}
async function sessionDetach(tabId) {
  requireTabId(tabId);
  cdpSessions.delete(tabId);
  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
  return { detached: true, tabId };
}
function sessionSend(tabId, params) {
  requireTabId(tabId);
  if (!params || !params.method) throw { code: "BAD_PARAMS", message: "缺少 CDP method" };
  if (!cdpSessions.has(tabId)) {
    throw { code: "SESSION_NOT_ATTACHED", message: `未附加调试器（tab ${tabId}），请先调用 session.attach` };
  }
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, params.method, params.params || {}, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        const m = String(err.message || "");
        // 页面导航导致调试目标被卸载：清理本地记录，避免后续调用连环失败
        if (/Detached while handling|not attached|Detached/i.test(m)) cdpSessions.delete(tabId);
        return reject({ code: /Detached/i.test(m) ? "SESSION_DETACHED" : "SESSION_SEND_FAILED", message: m });
      }
      resolve({ result: resp });
    });
  });
}

// 调试目标被卸载（页面导航 / tab 关闭 / 用户关闭 DevTools）时同步清理本地记录，
// 否则 session.send 会一直对已失效的会话发命令，产生「Detached while handling command」连环报错。
if (chrome.debugger && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId !== undefined) cdpSessions.delete(source.tabId);
  });
}

// ---------- 渲染器解冻（Chrome Memory Saver / 高能效模式） ----------
// 背景：Chrome 冻结后台标签页的渲染器后，chrome.scripting.*（executeScript / 注入）
// 会一直挂起到超时（实测 13s 后 PAGE_CONTEXT_TIMEOUT），而 CDP 通道仍然完好
// （实测同一 tab 被 Page.setWebLifecycleState 冻结后，CDP Runtime.evaluate 仍 32ms 返回）。
// 这是 host.log 里最大的失败源：433 次 PAGE_CONTEXT_TIMEOUT、tabs.prepare 失败率 34%。
//
// 注意：这是「冻结」不是「丢弃」。discarded tab 已卸载渲染器，CDP 也救不回来，
// 仍走 TAB_DISCARDED 报错让调用方决定是否 tabs.activate。
//
// 限流策略（为什么不是「成功后冷却 60s」）：Chrome 可能刚解冻就又把 tab 冻回去，
// 成功后长时间冷却会让这种情况下退化成「13s 报错且不自愈」。改用滑动窗口：
// 60s 内最多解冻 MAX 次，既能让反复被冻结的正常 tab 自愈，又不会给真坏的 tab 反复挂调试器。
const FREEZE_WINDOW_MS = 60000;
const FREEZE_MAX_PER_WINDOW = 5;
const FREEZE_FAIL_BACKOFF_MS = 5000;  // 解冻失败（CDP 不可用等）后的退避窗口
const freezeState = new Map();        // tabId -> { attempts: number[], lastFailedAt }

// 返回还需要等待的毫秒数；0 表示现在可以尝试解冻。
function freezeBackoff(tabId) {
  const st = freezeState.get(tabId);
  if (!st) return 0;
  if (st.lastFailedAt) {
    const left = FREEZE_FAIL_BACKOFF_MS - (Date.now() - st.lastFailedAt);
    if (left > 0) return left;
  }
  const recent = (st.attempts || []).filter((ts) => Date.now() - ts < FREEZE_WINDOW_MS);
  if (recent.length >= FREEZE_MAX_PER_WINDOW) {
    return FREEZE_WINDOW_MS - (Date.now() - recent[0]);
  }
  return 0;
}

// 经 CDP 让渲染器回到 active。成功返回 { ok:true }；CDP 不可用（无 debugger 权限、
// 用户 DevTools 占用、tab 已关闭）返回 { ok:false, reason }，调用方原样抛出原错误。
function tryUnfreezeTab(tabId) {
  return new Promise((resolve) => {
    const finish = (v) => { try { chrome.debugger.detach({ tabId }, () => {}); } catch (e) { /* noop */ } resolve(v); };
    const timer = setTimeout(() => finish({ ok: false, reason: "UNFREEZE_TIMEOUT" }), 5000);
    const done = (v) => { clearTimeout(timer); finish(v); };
    try {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) {
          const m = String(chrome.runtime.lastError.message || "");
          // 用户手动开着 DevTools：不抢，直接放弃自愈。
          return done({ ok: false, reason: /Another debugger|already has/i.test(m) ? "DEBUGGER_BUSY" : "ATTACH_FAILED" });
        }
        chrome.debugger.sendCommand({ tabId }, "Page.setWebLifecycleState", { state: "active" }, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) return done({ ok: false, reason: "UNFREEZE_COMMAND_FAILED" });
          done({ ok: true, resp });
        });
      });
    } catch (e) {
      done({ ok: false, reason: "ATTACH_THREW" });
    }
  });
}

// 带限流与状态记录的解冻尝试。返回 true 表示已解冻，调用方可以重试 scripting。
async function recoverFrozenTab(tabId) {
  if (freezeBackoff(tabId) > 0) return false;   // 限流中：不重复挂调试器，让调用方拿到原错误
  const st = freezeState.get(tabId) || { attempts: [], lastFailedAt: 0 };
  st.attempts = (st.attempts || []).filter((ts) => Date.now() - ts < FREEZE_WINDOW_MS);
  st.attempts.push(Date.now());
  freezeState.set(tabId, st);

  const r = await tryUnfreezeTab(tabId);
  const cur = freezeState.get(tabId) || { attempts: [] };
  if (r.ok) {
    cur.lastFailedAt = 0;
    console.warn("[bridge] renderer was frozen, unfroze tab", tabId);
  } else {
    cur.lastFailedAt = Date.now();
    console.warn("[bridge] unfreeze skipped", tabId, r.reason);
  }
  freezeState.set(tabId, cur);
  return r.ok;
}

// ---------- 工具 ----------
function requireTabId(tabId) {
  if (tabId === undefined || tabId === null) throw { code: "BAD_PARAMS", message: "缺少 tabId" };
}

// ---------- 扩展内部消息（popup / options / indicator） ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === "bridge.status") {
    bridgeStatus().then(sendResponse).catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === "bridge.action") {
    Promise.resolve()
      .then(() => dispatch(msg.action, msg.args || {}))
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({
        ok: false,
        error: errorPayload(e),
      }));
    return true;
  }
  if (msg.type === "bridge.config:get") { sendResponse({ config }); return false; }
  if (msg.type === "bridge.config:set") {
    saveConfig(msg.config || {}).then(() => sendResponse({ ok: true, config }));
    return true;
  }
  // 页面 indicator 上报（如 agent.stop 按钮被点击）
  if (msg.type === "bridge.indicatorEvent") {
    // 范围判定：payload.tabId 显式指定优先；否则用 sender.tab.id。
    // 「在这个页面上按停止」只应停这个标签页，而不是把整台机器上所有 Agent 一起停掉
    // ——那是过大的副作用。全局停止留给显式 API 调用（POST /agent/stop 不带 tabId）。
    // 取不到 tabId（如扩展页面自己发的）时退回全局，宁可多停也不要停不住。
    const senderTabId = sender && sender.tab && sender.tab.id !== undefined ? sender.tab.id : null;
    const tabId = msg.payload && msg.payload.tabId !== undefined && msg.payload.tabId !== null
      ? msg.payload.tabId
      : senderTabId;
    const forwardedPayload = { ...(msg.payload || {}), tabId };

    // 先本地生效再转发：按钮点击是用户直接意图，不应等一个 host 往返才生效。
    // （若 host 不可达，本地闸门仍然拦得住后续写操作。）
    if (msg.event === "agent.stop") {
      setStopped(tabId, forwardedPayload.reason || "user");
      broadcastToTabs({ type: "bridge.stopState", stopped: true, reason: forwardedPayload.reason || "user", tabId });
    } else if (msg.event === "agent.resume") {
      clearStopped(tabId);
      broadcastToTabs({ type: "bridge.stopState", stopped: false, tabId });
    }
    sendToHost({ type: "event", event: msg.event, payload: forwardedPayload });
    sendResponse({ ok: true, tabId, stopped: msg.event === "agent.stop" ? !!isStopped(tabId) : !isStopped(tabId) });
    return false;
  }
  // 会话记录器：content 上报页面变化事件 → 每 tab 环形缓冲
  if (msg.type === "bridge.recordEvent") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) recordPush(tabId, msg.event);
    sendResponse({ ok: true });
    return false;
  }
  // content 注入后询问是否处于录制中（导航重载后自动恢复）
  if (msg.type === "bridge.recorder.wantState") {
    const tabId = sender.tab && sender.tab.id;
    sendResponse({ ok: true, running: tabId != null ? recordState(tabId).running : false });
    return false;
  }
  // indicator 的闲置倒计时也会回报，确保 toolbar badge 不会滞留。
  if (msg.type === "bridge.tabControl") {
    const tabId = sender.tab && sender.tab.id;
    if (msg.state === "active") {
      recordTabAgent(tabId, msg.agentName, msg.agentId, msg.agentDisplay);
    } else {
      clearTabAgent(tabId);
    }
    setTabControlBadge(tabId, msg.state === "active", msg.agentDisplay);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// ---------- 启动 ----------
// 兜底：任何漏网的 promise rejection 会变成 chrome://extensions errors 面板里的
// 「Uncaught (in promise)」，掩盖真实问题。这里统一记录并标记来源。
self.addEventListener("unhandledrejection", (ev) => {
  const e = ev && ev.reason;
  console.warn("[bridge] unhandled rejection", e && (e.message || e));
  ev.preventDefault();
});

chrome.runtime.onInstalled.addListener(() => {
  loadConfig().then(() => { ensureKeepAlive(); connect(); sweepStaleControlTitles(); });
});
chrome.runtime.onStartup.addListener(() => {
  loadConfig().then(() => { ensureKeepAlive(); connect(); sweepStaleControlTitles(); });
});
loadConfig().then(() => {
  ensureKeepAlive();
  connect();
  sweepStaleControlTitles();
});
