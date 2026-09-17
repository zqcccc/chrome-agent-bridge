// 回归测试：页面侧（content script / indicator）的停止闸门与分片/停止契约
//
// 为什么单独测这一层：`relay/test-hardening.mjs` 覆盖的是 host 侧（拦「还没派发的」），
// 而真正「已派发、正在页面里跑」的动作由 content.js / indicator.js 拦。这层跑在 Chrome 的
// isolated world 里，无法用 page.evaluate 直接探测（CSP 禁止字符串 eval），
// 所以这里用**桩化的 chrome + 极简 DOM** 在 Node 里直接驱动它们。
//
// 覆盖：
//   1. content.js：停止后写动作抛 AGENT_STOPPED，且带 details.resumeWith
//   2. content.js：bridge.stopState 推送后立即生效（不依赖 host 往返）
//   3. content.js：恢复后放行
//   4. indicator.js：停止按钮点击 → 本地先进入停止态 → 再上报 background
//   5. indicator.js：bridge.stopState 推送更新只读标记
//   6. 页面侧错误 details 会透传（不再被吞掉）
//
// 用法: node relay/test-content-stop.mjs
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(__dirname, "..", "extension");

/** 极简 DOM 桩：只提供这两个脚本加载与闸门路径真正用到的东西。 */
function makeDom() {
  const listeners = new Map();
  const makeEl = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(), id: "", style: { cssText: "" }, children: [],
      dataset: {}, classList: { add() {}, remove() {} },
      setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
      _handlers: new Map(),
      addEventListener(type, fn) { if (!this._handlers.has(type)) this._handlers.set(type, []); this._handlers.get(type).push(fn); },
      fire(type, ev) { for (const fn of this._handlers.get(type) || []) fn(ev || {}); },
      appendChild(c) { this.children.push(c); return c; },
      remove() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 }; },
      animate() { return { onfinish: null }; },
      cloneNode() { return makeEl(tag); },
    };
    return el;
  };
  const documentElement = makeEl("html");
  const body = makeEl("body");
  const doc = {
    documentElement, body,
    title: "Test Page",
    readyState: "complete",
    hidden: false,
    visibilityState: "visible",
    createElement: makeEl,
    createElementNS: (_ns, tag) => makeEl(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener() {},
    dispatch(type, ev) { for (const fn of listeners.get(type) || []) fn(ev); },
  };
  return { doc, documentElement, body, makeEl, listeners };
}

/**
 * 在受控沙箱里加载一个 content script。
 * 返回 { listeners, sendMessageCalls, window }。
 * onMessage 注册的监听器会被收集，测试可直接调用它们。
 */
function loadScript(file, { url = "https://example.com/" } = {}) {
  const { doc, makeEl } = makeDom();
  const onMessageListeners = [];
  const sendMessageCalls = [];
  const sendMessageResponses = [];

  const win = {
    innerHeight: 800, innerWidth: 1200,
    scrollX: 0, scrollY: 0,
    location: { href: url },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout, clearTimeout, setInterval, clearInterval,
    console,
    MutationObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
    getSelection: () => ({ toString: () => "" }),
    addEventListener() {}, removeEventListener() {},
  };
  win.window = win;
  win.self = win;
  win.top = win;          // isTop = true
  win.parent = win;
  win.document = doc;
  win.navigator = { userAgent: "node-test" };
  win.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
      sendMessage: (msg, cb) => { sendMessageCalls.push(msg); if (typeof cb === "function") cb({ ok: true }); return Promise.resolve({ ok: true }); },
      lastError: null,
      id: "test-extension-id",
      getManifest: () => ({ version: "0.0.0-test" }),
    },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
    tabs: { query: (_q, cb) => cb && cb([]), sendMessage: () => Promise.resolve({ ok: true }), get: async () => ({}) },
    scripting: { executeScript: async () => [{ result: null }] },
  };

  const ctx = vm.createContext(win);
  ctx.globalThis = win;
  const code = fs.readFileSync(file, "utf8");
  vm.runInContext(code, ctx, { filename: file });

  /** 调用一个已注册的 onMessage 监听器，返回 sendResponse 收到的值。 */
  function dispatch(msg, sender = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const sendResponse = (v) => { if (!settled) { settled = true; resolve(v); } };
      let async_ = false;
      for (const fn of onMessageListeners) {
        const r = fn(msg, sender, sendResponse);
        if (r === true) async_ = true;
      }
      // 同步路径：让微任务跑完后再兜底 resolve
      setTimeout(() => { if (!settled) resolve(async_ ? undefined : null); }, 300);
    });
  }

  return { window: win, document: doc, listeners: onMessageListeners, sendMessageCalls, dispatch, sendMessageResponses };
}

// =====================================================================
// content.js：动作级停止闸门
// =====================================================================

test("content.js: 停止后写动作被拒（AGENT_STOPPED + details.resumeWith）", async () => {
  const s = loadScript(path.join(EXT, "content.js"));
  // 先确认正常情况下动作会被执行到「元素找不到」这一层（证明闸门不是唯一拦路石）
  const before = await s.dispatch({ type: "bridge.action", action: "click", args: { selector: "#x" } });
  assert.equal(before.ok, false);
  assert.notEqual(before.error.code, "AGENT_STOPPED", "未停止时不应报 AGENT_STOPPED");

  // background 下发停止
  await s.dispatch({ type: "bridge.stopState", stopped: true, reason: "user" });

  const after = await s.dispatch({ type: "bridge.action", action: "click", args: { selector: "#pay-now" } });
  assert.equal(after.ok, false, "停止后写动作必须被拒");
  assert.equal(after.error.code, "AGENT_STOPPED");
  assert.equal(after.error.details.resumeWith, "agent.resume", "details 必须透传，否则上层只能解析文本");
  assert.equal(after.error.details.action, "click");
});

test("content.js: 停止拦的是写动作，snapshot 等只读动作仍可用", async () => {
  const s = loadScript(path.join(EXT, "content.js"));
  await s.dispatch({ type: "bridge.stopState", stopped: true, reason: "user" });
  const snap = await s.dispatch({ type: "bridge.action", action: "snapshot", args: {} });
  // 桩 DOM 不完整时 snapshot 可能因其他原因失败——关键断言是「不是被停止闸门拦的」。
  assert.notEqual(snap.error && snap.error.code, "AGENT_STOPPED",
    `只读动作不应被停止拦住（Agent 需要能观察状态）；实际: ${JSON.stringify(snap)}`);
});

test("content.js: 恢复后写动作重新放行", async () => {
  const s = loadScript(path.join(EXT, "content.js"));
  await s.dispatch({ type: "bridge.stopState", stopped: true });
  const blocked = await s.dispatch({ type: "bridge.action", action: "type", args: { selector: "#a", text: "x" } });
  assert.equal(blocked.error.code, "AGENT_STOPPED");

  await s.dispatch({ type: "bridge.stopState", stopped: false });
  const ok = await s.dispatch({ type: "bridge.action", action: "type", args: { selector: "#a", text: "x" } });
  assert.notEqual(ok.error && ok.error.code, "AGENT_STOPPED", "恢复后必须放行");
});

test("content.js: 每个写动作都过闸门（不只 click）", async () => {
  const s = loadScript(path.join(EXT, "content.js"));
  await s.dispatch({ type: "bridge.stopState", stopped: true });
  for (const action of ["click", "type", "press", "scroll", "hover", "focusEl", "select", "waitFor"]) {
    const r = await s.dispatch({ type: "bridge.action", action, args: { selector: "#x" } });
    assert.equal(r.ok, false, `${action} 在停止后必须被拒`);
    assert.equal(r.error.code, "AGENT_STOPPED", `${action} 应报 AGENT_STOPPED，实际 ${r.error.code}`);
  }
});

// =====================================================================
// indicator.js：停止按钮与页面标记
// =====================================================================

test("indicator.js: 点击停止按钮 → 本地先进入停止态，再上报 background", async () => {
  const s = loadScript(path.join(EXT, "indicator.js"));
  assert.equal(s.window.__AGENT_BRIDGE_STOPPED__, false, "初始应为未停止");

  // 让按钮出现（真实路径：background 下发 showStop）
  await s.dispatch({ type: "bridge.indicator", action: "showStop", label: "停止 Agent" });
  const btn = s.window.document.documentElement.children.find((c) => c.id === "agent-bridge-stop");
  assert.ok(btn, "showStop 后应存在停止按钮");
  assert.ok((btn._handlers.get("click") || []).length > 0, "停止按钮应注册 click 处理器");

  s.sendMessageCalls.length = 0;
  btn.fire("click");

  // 本地立即生效（不等 host 往返）
  assert.equal(s.window.__AGENT_BRIDGE_STOPPED__, true, "点击后页面侧必须立即进入停止态");
  // 并且上报 background
  const reported = s.sendMessageCalls.find((m) => m.type === "bridge.indicatorEvent" && m.event === "agent.stop");
  assert.ok(reported, "必须上报 agent.stop 给 background");
  assert.equal(reported.payload.reason, "user");
});

test("indicator.js: bridge.stopState 推送会更新只读标记与按钮可见性", async () => {
  const s = loadScript(path.join(EXT, "indicator.js"));
  await s.dispatch({ type: "bridge.stopState", stopped: true, reason: "api" });
  assert.equal(s.window.__AGENT_BRIDGE_STOPPED__, true);
  await s.dispatch({ type: "bridge.stopState", stopped: false });
  assert.equal(s.window.__AGENT_BRIDGE_STOPPED__, false);
});

test("indicator.js: 停止按钮点击不带全局 tabId（范围由 background 用 sender 判定）", async () => {
  const s = loadScript(path.join(EXT, "indicator.js"));
  await s.dispatch({ type: "bridge.indicator", action: "showStop", label: "停止 Agent" });
  const btn = s.window.document.documentElement.children.find((c) => c.id === "agent-bridge-stop");
  s.sendMessageCalls.length = 0;
  btn.fire("click");
  const reported = s.sendMessageCalls.find((m) => m.event === "agent.stop");
  assert.ok(reported, "应上报 agent.stop");
  assert.equal(reported.payload.tabId, undefined,
    "页面按钮不应指定全局范围——那会把整台机器上所有 Agent 一起停掉");
});

// =====================================================================
// 源码契约：两处闸门必须存在，且 details 不被吞
// =====================================================================

test("契约: content.js 的停止闸门在动作分发之前", () => {
  const src = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
  const gateIdx = src.indexOf("if (stoppedAt && MUTATING_ACTIONS.has(action)) throw stoppedError(action);");
  const switchIdx = src.indexOf("switch (action) {", gateIdx === -1 ? 0 : gateIdx);
  assert.ok(gateIdx !== -1, "content.js 必须有动作级停止闸门");
  assert.ok(switchIdx > gateIdx, "闸门必须在 switch 之前（否则动作已经执行了）");
});

test("契约: content.js 把 error.details 透传回 background", () => {
  const src = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
  assert.match(src, /details:\s*\(e && e\.details\) \|\| undefined/,
    "content.js 必须透传 details（否则 recoverable / resumeWith 在这一层就丢了）");
});

test("契约: background.js 的 content 调用把 details 带出", () => {
  const src = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  assert.match(src, /if \(resp\.error && resp\.error\.details\) err\.details = resp\.error\.details;/,
    "background.js 从 content 收到错误时必须带上 details");
});

test("契约: background.js 用 sender.tab.id 决定停止范围（按钮只停当前 tab）", () => {
  const src = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  assert.match(src, /sender && sender\.tab && sender\.tab\.id/,
    "必须用 sender.tab.id 判定范围，避免页面按钮触发全局停止");
});
