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
  return `ws://${config.host || "127.0.0.1"}:${config.port || 8778}/agent?token=${encodeURIComponent(config.token || "")}`;
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

// ---------- 入站：native ----------
function handleNativeMsg(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "hello") {
    console.log("[bridge] host hello:", msg.host, msg.version, "channel=native");
    return;
  }
  if (msg.type === "pong") return;
  if (msg.type === "request" && msg.requestId !== undefined && msg.method) {
    dispatch(msg.method, msg.params || {})
      .then((result) => {
        nativePort.postMessage({ type: "response", responseToRequestId: msg.requestId, payload: result === undefined ? null : result });
      })
      .catch((e) => {
        console.error("[bridge] rpc error", msg.method, e && e.message);
        nativePort.postMessage({
          type: "response",
          responseToRequestId: msg.requestId,
          error: { code: e && e.code || "INTERNAL", message: e && e.message ? String(e.message) : String(e) },
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
    dispatch(msg.method, msg.params || {})
      .then((result) => ws.send(JSON.stringify({ id: msg.id, ok: true, result: result === undefined ? null : result })))
      .catch((e) => ws.send(JSON.stringify({ id: msg.id, ok: false, error: { code: e && e.code || "INTERNAL", message: e && e.message ? String(e.message) : String(e) } })));
  }
}

// host 下发事件
function handleHostEvent(event, payload) {
  switch (event) {
    case "agent.stop":
      // 通知所有页面隐藏指示器
      broadcastToTabs({ type: "bridge.indicator", action: "hide" });
      broadcastToTabs({ type: "bridge.indicator", action: "hideStop" });
      break;
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

// ---------- 命令分发 ----------
// 护栏：只对真实交互操作（click/type/press/scroll/hover/focusEl/select/waitFor）
// 显示「停止 Agent」按钮。只读/导航/evaluate/snapshot/waitLoad 不被 indicator 阻塞，
// 避免给读操作和导航增加竞态。indicator 失败不得影响主 RPC。
const INTERACTIVE_METHODS = new Set([
  "page.click", "page.type", "page.press", "page.scroll",
  "page.hover", "page.focusEl", "page.waitFor", "page.select",
]);
async function dispatch(method, params) {
  if (INTERACTIVE_METHODS.has(method) && params && params.tabId) {
    try { await indicatorCall(params.tabId, { action: "showStop", label: "停止 Agent" }); } catch (e) { /* chrome:// 等受限页忽略 */ }
  }
  switch (method) {
    case "bridge.status": return bridgeStatus();
    case "bridge.connect": return bridgeConnect(params);
    case "bridge.disconnect": return bridgeDisconnect();
    case "bridge.ping": return { pong: Date.now(), relayTime: params.t || null };

    case "tabs.list": return tabsList(params);
    case "tabs.get": return tabsGet(params.tabId);
    case "tabs.active": return tabsActive();
    case "tabs.create": return tabsCreate(params);
    case "tabs.activate": return tabsActivate(params.tabId);
    case "tabs.close": return tabsClose(params.tabId);
    case "tabs.reload": return tabsReload(params.tabId, params);

    case "page.info": return pageInfo(params.tabId);
    case "page.navigate": return pageNavigate(params.tabId, params.url, params);
    case "page.back": return pageBack(params.tabId);
    case "page.forward": return pageForward(params.tabId);
    case "page.focus": return pageFocus(params.tabId);
    case "page.waitLoad": return waitForLoad(params.tabId, params.timeoutMs);

    case "page.snapshot": return pageSnapshot(params.tabId, params);
    case "page.evaluate": return pageEvaluate(params.tabId, params);
    case "page.click": return pageAction(params.tabId, "click", params);
    case "page.type": return pageAction(params.tabId, "type", params);
    case "page.press": return pageAction(params.tabId, "press", params);
    case "page.scroll": return pageAction(params.tabId, "scroll", params);
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

// ---------- bridge 状态 ----------
async function bridgeStatus() {
  const manifest = chrome.runtime.getManifest();
  let active = null;
  try { active = await tabsActive(); } catch (e) { /* noop */ }
  return {
    name: manifest.name,
    version: manifest.version,
    channel: activeChannel,
    connected: isChannelOpen(),
    relayUrl: wsUrl().replace(/token=.*/, "token=***"),
    activeTab: active ? active.tab : null,
  };
}

function bridgeConnect(params) {
  return saveConfig({
    host: params.host || config.host,
    port: params.port || config.port,
    token: params.token !== undefined ? params.token : config.token,
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
    status: t.status, url: t.url, title: t.title, favIconUrl: t.favIconUrl,
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
async function tabsClose(tabId) {
  requireTabId(tabId);
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
  await chrome.tabs.update(tabId, { url });
  if (params.waitLoad !== false) {
    await waitForLoad(tabId, params.timeoutMs || NAV_TIMEOUT_MS).catch(() => null);
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

// ---------- Content Script 消息 ----------
async function ensureInjected(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (!/^(https?|file):/.test(t.url || "")) {
      throw { code: "UNSUPPORTED_URL", message: `该页面不支持注入（${t.url || "未知"}）` };
    }
  } catch (e) {
    if (e && e.code === "UNSUPPORTED_URL") throw e;
    throw { code: "TAB_GONE", message: "标签页不存在" };
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: "bridge.ping" });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch (e2) {
      throw { code: "PAGE_CONTEXT_TIMEOUT", message: `注入 content script 失败: ${e2 && e2.message || e2}` };
    }
    await new Promise((r) => setTimeout(r, 50));
    try {
      await chrome.tabs.sendMessage(tabId, { type: "bridge.ping" });
    } catch (e2) {
      throw { code: "PAGE_CONTEXT_TIMEOUT", message: `content script 注入后仍无响应: ${e2 && e2.message || e2}` };
    }
  }
}

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
    throw err;
  }
  return resp.result;
}

async function indicatorCall(tabId, payload) {
  requireTabId(tabId);
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: "bridge.indicator", ...payload });
    return resp || { ok: true };
  } catch (e) {
    // 页面未注入 indicator（如 chrome:// 页），静默忽略
    return { ok: true, skipped: true };
  }
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
      CONTENT_CALL_TIMEOUT_MS,
      "PAGE_CONTEXT_TIMEOUT",
      `page.evaluate 超时(${CONTENT_CALL_TIMEOUT_MS}ms): 页面可能已导航/上下文销毁`
    );
  } catch (e) {
    if (e && (e.code === "PAGE_CONTEXT_TIMEOUT")) throw e;
    // executeScript 在页面导航/上下文销毁时报 "Cannot access contents of the page"
    throw { code: "PAGE_CONTEXT_TIMEOUT", message: `executeScript 失败: ${e && e.message || e}` };
  }
  const out = resp && resp[0] && resp[0].result;
  if (out && out.__type === "error") throw { code: "EVAL_ERROR", message: out.message };
  return { result: out };
}

async function pageAction(tabId, action, params) {
  return contentCall(tabId, action, params);
}

// ---------- 截图 ----------
async function pageScreenshot(tabId, params) {
  requireTabId(tabId);
  const format = (params && params.format) || "png";
  if (!["png", "jpeg"].includes(format)) throw { code: "BAD_PARAMS", message: "format 仅支持 png/jpeg" };
  const quality = params.quality || 90;
  // 默认视口截图（快、稳定）；captureBeyondViewport=true 时才做整页截图（长页面可能较慢）
  const captureBeyondViewport = params.captureBeyondViewport === true;
  try {
    const shot = await cdpScreenshot(tabId, format, quality, captureBeyondViewport);
    return { format, image: shot.data, type: "dataURL", captureMode: "cdp" };
  } catch (e) {
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
  return pageScreenshot(tabId, params);
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

// ---------- CDP Session ----------
async function sessionAttach(tabId) {
  requireTabId(tabId);
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
  return { attached: true, tabId };
}
async function sessionDetach(tabId) {
  requireTabId(tabId);
  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
  return { detached: true, tabId };
}
function sessionSend(tabId, params) {
  requireTabId(tabId);
  if (!params || !params.method) throw { code: "BAD_PARAMS", message: "缺少 CDP method" };
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, params.method, params.params || {}, (resp) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve({ result: resp });
    });
  });
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
        error: { code: e && e.code || "INTERNAL", message: e && e.message ? String(e.message) : String(e) },
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
    sendToHost({ type: "event", event: msg.event, payload: msg.payload || null });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// ---------- 启动 ----------
chrome.runtime.onInstalled.addListener(() => {
  loadConfig().then(() => { ensureKeepAlive(); connect(); });
});
chrome.runtime.onStartup.addListener(() => {
  loadConfig().then(() => { ensureKeepAlive(); connect(); });
});
loadConfig().then(() => {
  ensureKeepAlive();
  connect();
});
