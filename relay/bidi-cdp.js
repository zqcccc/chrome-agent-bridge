// CDP → WebDriver BiDi 翻译层（Firefox 版的 chrome.debugger 替身）
//
// Firefox 扩展没有 chrome.debugger。扩展把原本要发给 chrome.debugger 的三类调用
// （attach / detach / sendCommand）经 native 通道反向发给 host，由这里翻译成 BiDi 命令。
// 目标是让 Agent 侧 `session.send` 的 CDP 方法在两种浏览器上返回同样形状的结果。
//
// 只翻译 Agent 与扩展实际用到的方法子集（SUPPORTED_CDP_METHODS）；其余一律报
// CDP_UNSUPPORTED，不返回空结果冒充成功。
//
// tabId → BiDi context 的对应：两套编号互不相关，BiDi 也不暴露扩展 tabId。
// 首次 attach 时由扩展往页面 <html> 写一个一次性标记属性，这里遍历顶层 context
// 在 sandbox 里读这个属性来配对；配对结果缓存到该 context 销毁为止（导航不改变 context id）。
"use strict";

const { EventEmitter } = require("events");
const { BidiClient, BidiError } = require("./bidi-client");

const MARKER_ATTR = "data-abb-bidi";
const SANDBOX = "agent-browser-bridge";
const MOUSE_SOURCE = "abb-mouse";
const KEY_SOURCE = "abb-keyboard";
const WHEEL_SOURCE = "abb-wheel";
const MOUSE_BUTTONS = { left: 0, middle: 1, right: 2, back: 3, forward: 4 };
// CDP modifiers 位掩码 → WebDriver 键码（Alt=1 Ctrl=2 Meta=4 Shift=8）
const MODIFIER_KEYS = [[1, ""], [2, ""], [4, ""], [8, ""]];
const WEBDRIVER_KEYS = {
  Enter: "", Tab: "", Backspace: "", Escape: "", Delete: "", Insert: "",
  ArrowLeft: "", ArrowUp: "", ArrowRight: "", ArrowDown: "",
  Home: "", End: "", PageUp: "", PageDown: "",
  Shift: "", Control: "", Alt: "", Meta: "",
};
for (let i = 1; i <= 12; i++) WEBDRIVER_KEYS[`F${i}`] = String.fromCharCode(0xe030 + i);

const SUPPORTED_CDP_METHODS = [
  "Runtime.evaluate",
  "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText",
  "DOM.getDocument", "DOM.querySelector", "DOM.querySelectorAll", "DOM.setFileInputFiles",
  "Page.captureScreenshot", "Page.navigate", "Page.reload", "Page.bringToFront",
  "Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride",
];

// 活动元素探针：判断焦点停在本 frame 的元素上，还是在某个子 iframe 里
const FOCUS_PROBE = `(() => {
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return "none";
  return a.tagName === "IFRAME" || a.tagName === "FRAME" ? "frame" : "element";
})()`;

function cdpError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ---------- BiDi RemoteValue → CDP RemoteObject ----------
// 按 CDP returnByValue 的语义还原：只有普通对象/数组带出结构，其余对象（Map/Set/Date/Node…）
// 在 CDP 里按值返回是 {}，这里保持一致，避免两种浏览器拿到不同形状的值。
function deserialize(rv) {
  if (!rv || typeof rv !== "object") return null;
  switch (rv.type) {
    case "undefined": return undefined;
    case "null": return null;
    case "string": case "boolean": return rv.value;
    case "number": return typeof rv.value === "number" ? rv.value : null;
    case "bigint": return null;
    case "array": return (rv.value || []).map((v) => {
      const d = deserialize(v);
      return d === undefined ? null : d;
    });
    case "object": {
      const out = {};
      for (const [k, v] of rv.value || []) {
        if (v && (v.type === "undefined" || v.type === "function")) continue;
        out[typeof k === "string" ? k : String(deserialize(k))] = deserialize(v);
      }
      return out;
    }
    default: return {};
  }
}

const OBJECT_SUBTYPES = new Set(["array", "node", "regexp", "date", "map", "set", "error", "promise", "weakmap", "weakset", "proxy", "typedarray", "arraybuffer"]);

function toRemoteObject(rv, byValue) {
  const t = rv && rv.type;
  if (t === "undefined") return { type: "undefined" };
  if (t === "null") return { type: "object", subtype: "null", value: null };
  if (t === "string" || t === "boolean") return { type: t, value: rv.value };
  if (t === "number") {
    return typeof rv.value === "number"
      ? { type: "number", value: rv.value, description: String(rv.value) }
      : { type: "number", unserializableValue: rv.value, description: rv.value };
  }
  if (t === "bigint") return { type: "bigint", unserializableValue: `${rv.value}n`, description: `${rv.value}n` };
  if (t === "symbol") return { type: "symbol", description: "Symbol()" };
  if (t === "function") return byValue ? { type: "function", value: {} } : { type: "function", className: "Function", description: "function" };
  const o = { type: "object" };
  if (OBJECT_SUBTYPES.has(t)) o.subtype = t;
  if (byValue) o.value = deserialize(rv);
  else o.description = t;
  return o;
}

function toExceptionDetails(ed) {
  const frames = (ed.stackTrace && ed.stackTrace.callFrames) || [];
  const stack = frames.map((f) => `    at ${f.functionName || "<anonymous>"} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`).join("\n");
  const exception = toRemoteObject(ed.exception, ed.exception && ed.exception.type !== "object" && ed.exception.type !== "error");
  if (exception.type === "object") {
    exception.className = "Error";
    exception.description = stack ? `${ed.text}\n${stack}` : ed.text;
  }
  return {
    exceptionId: 1,
    text: "Uncaught",
    lineNumber: ed.lineNumber,
    columnNumber: ed.columnNumber,
    exception,
  };
}

// ---------- 按键映射 ----------
function webdriverKey(params) {
  const key = params.key;
  if (key && WEBDRIVER_KEYS[key]) return WEBDRIVER_KEYS[key];
  if (key && [...key].length === 1) return key;
  if (params.text && [...params.text].length === 1) return params.text === "\r" ? WEBDRIVER_KEYS.Enter : params.text;
  throw cdpError("BAD_PARAMS", `Input.dispatchKeyEvent: 无法映射按键 key=${JSON.stringify(key)} text=${JSON.stringify(params.text)}`);
}

function modifierValues(mask) {
  return MODIFIER_KEYS.filter(([bit]) => (Number(mask) || 0) & bit).map(([, v]) => v);
}

class CdpOverBidi extends EventEmitter {
  constructor({ port }) {
    super();
    this.port = port;
    this.client = null;
    this.connecting = null;
    this.tabContexts = new Map();   // tabId -> BiDi top-level context id
    this.attached = new Set();      // tabId（与 chrome.debugger 的 attach 状态对应）
    this.nodes = new Map();         // tabId -> { next, ids: Map<nodeId, sharedId> }
    this.pressedKeys = new Map();   // tabId -> Set<webdriver key value>
    // CDP 的 Emulation 覆盖随调试会话 detach 自动失效；BiDi 的 setViewport 会一直保留，
    // 所以记下改过视口的 tab，detach 时还原
    this.viewportOverrides = new Set();
  }

  status() {
    return { port: this.port, connected: !!(this.client && !this.client.closed), attachedTabs: [...this.attached] };
  }

  async ensureConnected() {
    if (this.client && !this.client.closed) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new BidiClient({ port: this.port });
      await client.connect();
      await client.send("session.subscribe", { events: ["browsingContext.contextDestroyed"] });
      client.on("event", (method, params) => this._onEvent(method, params));
      client.on("close", () => this._onClose());
      this.client = client;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  _onEvent(method, params) {
    if (method !== "browsingContext.contextDestroyed" || !params || params.parent) return;
    for (const [tabId, ctx] of this.tabContexts) {
      if (ctx !== params.context) continue;
      this.tabContexts.delete(tabId);
      this._dropTab(tabId, "target_closed");
    }
  }

  _onClose() {
    this.client = null;
    for (const tabId of [...this.attached]) this._dropTab(tabId, "bidi_disconnected");
    this.tabContexts.clear();
  }

  _dropTab(tabId, reason) {
    this.viewportOverrides.delete(tabId);
    this.nodes.delete(tabId);
    this.pressedKeys.delete(tabId);
    if (this.attached.delete(tabId)) this.emit("detached", { tabId, reason });
  }

  // 结束 BiDi 会话。Firefox 只允许一个会话且断开连接不会释放它，
  // host 退出前不调用这里，下一个 host 要等 Firefox 重启才能再连上。
  async shutdown() {
    if (!this.client || this.client.closed) return;
    await this.client.end();
  }

  // ---------- attach / detach ----------
  async attach(tabId, marker) {
    const key = Number(tabId);
    if (this.attached.has(key)) throw cdpError(null, `Debugger is already attached to the tab with id: ${key}.`);
    const client = await this.ensureConnected();
    let ctx = this.tabContexts.get(key);
    if (!ctx) {
      if (!marker) return { attached: false, needMarker: true, markerAttr: MARKER_ATTR };
      ctx = await this._findContextByMarker(client, marker);
      if (!ctx) throw cdpError("ATTACH_FAILED", `未能在 BiDi 中定位 tab ${key}（页面标记未找到）`);
      this.tabContexts.set(key, ctx);
    }
    this.attached.add(key);
    return { attached: true, context: ctx };
  }

  async _findContextByMarker(client, marker) {
    const tree = await client.send("browsingContext.getTree", { maxDepth: 0 });
    const probe = `document.documentElement ? document.documentElement.getAttribute(${JSON.stringify(MARKER_ATTR)}) : null`;
    const hits = await Promise.all(tree.contexts.map(async (c) => {
      try {
        const r = await client.send("script.evaluate", {
          expression: probe, target: { context: c.context, sandbox: SANDBOX }, awaitPromise: false, resultOwnership: "none",
        }, 5000);
        return r.type === "success" && r.result.value === marker ? c.context : null;
      } catch (e) {
        return null;   // 该 context 正在导航 / 已销毁：不是目标
      }
    }));
    return hits.find(Boolean) || null;
  }

  async detach(tabId) {
    const key = Number(tabId);
    this.nodes.delete(key);
    this.pressedKeys.delete(key);
    this.attached.delete(key);
    if (this.viewportOverrides.delete(key) && this.client && !this.client.closed) {
      await this.client.send("browsingContext.setViewport", { context: this.tabContexts.get(key), viewport: null, devicePixelRatio: null });
    }
    return {};
  }

  // ---------- sendCommand ----------
  async send(tabId, method, params = {}) {
    const key = Number(tabId);
    if (!this.attached.has(key)) throw cdpError(null, `Debugger is not attached to the tab with id: ${key}.`);
    const handler = HANDLERS[method];
    if (!handler) {
      throw cdpError("CDP_UNSUPPORTED", `Firefox 版不支持 CDP 方法 ${method}；支持的方法: ${SUPPORTED_CDP_METHODS.join(", ")}`);
    }
    const client = await this.ensureConnected();
    const ctx = this.tabContexts.get(key);
    try {
      return await handler.call(this, client, ctx, params || {}, key);
    } catch (e) {
      if (e instanceof BidiError && /no such frame/.test(e.message)) {
        this.tabContexts.delete(key);
        this._dropTab(key, "target_closed");
        throw cdpError(null, `Detached while handling command: ${method}`);
      }
      throw e;
    }
  }

  // ---------- 内部工具 ----------
  async _evaluate(client, ctx, expression, { sandbox, awaitPromise = false, userActivation = false } = {}) {
    const target = sandbox ? { context: ctx, sandbox } : { context: ctx };
    return client.send("script.evaluate", { expression, target, awaitPromise, userActivation, resultOwnership: "none" });
  }

  _registerNode(tabId, rv) {
    if (!rv || rv.type !== "node" || !rv.sharedId) return 0;
    let reg = this.nodes.get(tabId);
    if (!reg) { reg = { next: 1, ids: new Map() }; this.nodes.set(tabId, reg); }
    for (const [id, sid] of reg.ids) if (sid === rv.sharedId) return id;
    const id = reg.next++;
    reg.ids.set(id, rv.sharedId);
    return id;
  }

  _sharedId(tabId, params) {
    const id = params.nodeId || params.backendNodeId;
    if (params.objectId) throw cdpError("CDP_UNSUPPORTED", "Firefox 版不支持 objectId 引用节点，请改用 DOM.querySelector 返回的 nodeId");
    const reg = this.nodes.get(tabId);
    const sid = reg && reg.ids.get(Number(id));
    if (!sid) throw cdpError(null, `Could not find node with given id: ${id}`);
    return sid;
  }

  async _queryAll(client, ctx, tabId, params, all) {
    const rootSid = this._sharedId(tabId, params);
    const fn = all
      ? "(root, sel) => Array.from(root.querySelectorAll(sel))"
      : "(root, sel) => root.querySelector(sel)";
    const r = await client.send("script.callFunction", {
      functionDeclaration: fn,
      target: { context: ctx },
      arguments: [{ sharedId: rootSid }, { type: "string", value: String(params.selector) }],
      awaitPromise: false,
      resultOwnership: "none",
    });
    if (r.type === "exception") throw cdpError(null, `DOM Error while querying: ${r.exceptionDetails.text}`);
    if (all) return (r.result.value || []).map((rv) => this._registerNode(tabId, rv));
    return this._registerNode(tabId, r.result);
  }

  async _keyActions(client, ctx, actions) {
    if (!actions.length) return;
    await client.send("input.performActions", { context: ctx, actions: [{ type: "key", id: KEY_SOURCE, actions }] });
  }

  async _pressModifiers(client, ctx, tabId, mask) {
    const pressed = this._pressed(tabId);
    const downs = modifierValues(mask).filter((v) => !pressed.has(v));
    await this._keyActions(client, ctx, downs.map((value) => ({ type: "keyDown", value })));
    downs.forEach((v) => pressed.add(v));
    return downs;
  }

  async _releaseKeys(client, ctx, tabId, values) {
    const pressed = this._pressed(tabId);
    await this._keyActions(client, ctx, values.map((value) => ({ type: "keyUp", value })));
    values.forEach((v) => pressed.delete(v));
  }

  _pressed(tabId) {
    let s = this.pressedKeys.get(tabId);
    if (!s) { s = new Set(); this.pressedKeys.set(tabId, s); }
    return s;
  }

  // 焦点所在的 frame：沿 activeElement 进入 iframe，直到焦点停在具体元素上。
  // 不用 document.hasFocus()：窗口不在前台或标签页在后台时它恒为 false，而 CDP insertText 照样生效。
  async _focusedContext(client, ctx) {
    const tree = await client.send("browsingContext.getTree", { root: ctx });
    let node = tree.contexts[0];
    for (;;) {
      const r = await this._evaluate(client, node.context, FOCUS_PROBE, { sandbox: SANDBOX });
      if (r.result.value !== "frame" || !node.children || !node.children.length) return node.context;
      let next = null;
      for (const child of node.children) {
        const cr = await this._evaluate(client, child.context, FOCUS_PROBE, { sandbox: SANDBOX });
        if (cr.result.value !== "none") { next = child; break; }
      }
      if (!next) return node.context;
      node = next;
    }
  }
}

// ---------- 各 CDP 方法的翻译 ----------
const HANDLERS = {
  async "Runtime.evaluate"(client, ctx, p) {
    if (typeof p.expression !== "string") throw cdpError("BAD_PARAMS", "Runtime.evaluate 缺少 expression");
    const r = await this._evaluate(client, ctx, p.expression, { awaitPromise: !!p.awaitPromise, userActivation: !!p.userGesture });
    if (r.type === "exception") {
      // CDP 在异常时 result 与 exceptionDetails.exception 是同一个对象（带 description）
      const exceptionDetails = toExceptionDetails(r.exceptionDetails);
      return { result: exceptionDetails.exception, exceptionDetails };
    }
    return { result: toRemoteObject(r.result, !!p.returnByValue) };
  },

  async "Input.dispatchMouseEvent"(client, ctx, p, tabId) {
    const x = Math.round(Number(p.x));
    const y = Math.round(Number(p.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw cdpError("BAD_PARAMS", "Input.dispatchMouseEvent 缺少 x/y");
    const mods = await this._pressModifiers(client, ctx, tabId, p.modifiers);
    try {
      if (p.type === "mouseWheel") {
        await client.send("input.performActions", {
          context: ctx,
          actions: [{ type: "wheel", id: WHEEL_SOURCE, actions: [{ type: "scroll", x, y, deltaX: Math.round(p.deltaX || 0), deltaY: Math.round(p.deltaY || 0), origin: "viewport" }] }],
        });
        return {};
      }
      const move = { type: "pointerMove", x, y, origin: "viewport", duration: 0 };
      let seq;
      if (p.type === "mouseMoved") seq = [move];
      else if (p.type === "mousePressed" || p.type === "mouseReleased") {
        const button = MOUSE_BUTTONS[p.button];
        if (button === undefined) throw cdpError("BAD_PARAMS", `Input.dispatchMouseEvent: ${p.type} 需要 button（left/middle/right/back/forward）`);
        seq = [move, { type: p.type === "mousePressed" ? "pointerDown" : "pointerUp", button }];
      } else {
        throw cdpError("BAD_PARAMS", `Input.dispatchMouseEvent: 不支持的 type ${p.type}`);
      }
      await client.send("input.performActions", {
        context: ctx,
        actions: [{ type: "pointer", id: MOUSE_SOURCE, parameters: { pointerType: "mouse" }, actions: seq }],
      });
      return {};
    } finally {
      await this._releaseKeys(client, ctx, tabId, mods);
    }
  },

  async "Input.dispatchKeyEvent"(client, ctx, p, tabId) {
    const pressed = this._pressed(tabId);
    if (p.type === "char") {
      // keyDown 已经产生过字符（WebDriver 按键会连带 keypress/input），char 不能再输入一次
      if (pressed.size > 0) return {};
      const value = webdriverKey(p);
      await this._keyActions(client, ctx, [{ type: "keyDown", value }, { type: "keyUp", value }]);
      return {};
    }
    const value = webdriverKey(p);
    if (p.type === "keyDown" || p.type === "rawKeyDown") {
      await this._pressModifiers(client, ctx, tabId, p.modifiers);
      await this._keyActions(client, ctx, [{ type: "keyDown", value }]);
      pressed.add(value);
      return {};
    }
    if (p.type === "keyUp") {
      await this._releaseKeys(client, ctx, tabId, [value]);
      const held = modifierValues(p.modifiers).filter((v) => pressed.has(v));
      await this._releaseKeys(client, ctx, tabId, held);
      return {};
    }
    throw cdpError("BAD_PARAMS", `Input.dispatchKeyEvent: 不支持的 type ${p.type}`);
  },

  // CDP insertText 相当于输入法提交：只触发 beforeinput/input，不产生按键事件（"\n" 不会变成回车提交表单）。
  // 等价实现是在焦点所在 frame 里 execCommand("insertText")，事件同样是 isTrusted。
  async "Input.insertText"(client, ctx, p) {
    const text = String(p.text == null ? "" : p.text);
    if (!text) return {};
    const target = await this._focusedContext(client, ctx);
    // Firefox 对 contenteditable 调 focus() 不放置光标（Chrome 会放），没有选区时 execCommand 无落点。
    // 选区不在焦点元素内时，把光标放到元素末尾，行为与 Chrome 一致。
    const expr = `(() => {
      const a = document.activeElement;
      if (a && a.isContentEditable) {
        const sel = getSelection();
        if (!sel.rangeCount || !a.contains(sel.anchorNode)) {
          const range = document.createRange();
          range.selectNodeContents(a);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      return document.execCommand("insertText", false, ${JSON.stringify(text)});
    })()`;
    const r = await this._evaluate(client, target, expr, { userActivation: true });
    if (r.type === "exception") throw cdpError(null, `Input.insertText 失败: ${r.exceptionDetails.text}`);
    return {};
  },

  async "DOM.getDocument"(client, ctx, p, tabId) {
    const r = await this._evaluate(client, ctx, "document");
    if (r.type === "exception") throw cdpError(null, `DOM.getDocument 失败: ${r.exceptionDetails.text}`);
    const nodeId = this._registerNode(tabId, r.result);
    const v = r.result.value || {};
    return {
      root: { nodeId, backendNodeId: nodeId, nodeType: v.nodeType || 9, nodeName: "#document", localName: "", nodeValue: "", childNodeCount: v.childNodeCount || 0 },
    };
  },

  async "DOM.querySelector"(client, ctx, p, tabId) {
    return { nodeId: await this._queryAll(client, ctx, tabId, p, false) };
  },

  async "DOM.querySelectorAll"(client, ctx, p, tabId) {
    return { nodeIds: await this._queryAll(client, ctx, tabId, p, true) };
  },

  async "DOM.setFileInputFiles"(client, ctx, p, tabId) {
    if (!Array.isArray(p.files)) throw cdpError("BAD_PARAMS", "DOM.setFileInputFiles 缺少 files 数组");
    const sharedId = this._sharedId(tabId, p);
    await client.send("input.setFiles", { context: ctx, element: { sharedId }, files: p.files });
    return {};
  },

  async "Page.captureScreenshot"(client, ctx, p) {
    const format = p.format || "png";
    const params = { context: ctx, origin: p.captureBeyondViewport ? "document" : "viewport", format: { type: `image/${format}` } };
    if (format === "jpeg" && p.quality != null) params.format.quality = Math.max(0, Math.min(100, Number(p.quality))) / 100;
    if (p.clip) params.clip = { type: "box", x: p.clip.x, y: p.clip.y, width: p.clip.width, height: p.clip.height };
    const r = await client.send("browsingContext.captureScreenshot", params, 60000);
    return { data: r.data };
  },

  async "Page.navigate"(client, ctx, p) {
    if (!p.url) throw cdpError("BAD_PARAMS", "Page.navigate 缺少 url");
    const r = await client.send("browsingContext.navigate", { context: ctx, url: p.url, wait: "none" });
    return { frameId: ctx, loaderId: r.navigation || "" };
  },

  async "Page.reload"(client, ctx, p) {
    await client.send("browsingContext.reload", { context: ctx, ignoreCache: !!p.ignoreCache, wait: "none" });
    return {};
  },

  async "Page.bringToFront"(client, ctx) {
    await client.send("browsingContext.activate", { context: ctx });
    return {};
  },

  async "Emulation.setDeviceMetricsOverride"(client, ctx, p, tabId) {
    const viewport = p.width && p.height ? { width: Math.round(p.width), height: Math.round(p.height) } : null;
    await client.send("browsingContext.setViewport", { context: ctx, viewport, devicePixelRatio: p.deviceScaleFactor || null });
    if (viewport || p.deviceScaleFactor) this.viewportOverrides.add(tabId);
    else this.viewportOverrides.delete(tabId);
    return {};
  },

  async "Emulation.clearDeviceMetricsOverride"(client, ctx, p, tabId) {
    await client.send("browsingContext.setViewport", { context: ctx, viewport: null, devicePixelRatio: null });
    this.viewportOverrides.delete(tabId);
    return {};
  },
};

module.exports = {
  CdpOverBidi,
  SUPPORTED_CDP_METHODS,
  MARKER_ATTR,
  // 供离线单测
  deserialize, toRemoteObject, toExceptionDetails, webdriverKey, modifierValues,
};
