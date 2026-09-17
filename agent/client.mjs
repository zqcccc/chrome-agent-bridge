// Agent Browser Bridge - Agent 客户端库 (Node)
// 用法：
//   import { Bridge } from "./client.mjs";
//   const bridge = new Bridge();            // 自动读取 ~/.chrome-agent-bridge/token
//   await bridge.rpc("tabs.list");
//   await bridge.screenshot(tabId, "/tmp/a.png");
"use strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const TOKEN_FILE = path.join(os.homedir(), ".chrome-agent-bridge", "token");

function loadToken() {
  if (process.env.AGENT_BRIDGE_TOKEN) return process.env.AGENT_BRIDGE_TOKEN;
  try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch (e) { return ""; }
}

export class BridgeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    // 结构化细节（如 SCROLL_NO_GROWTH 的 atBottom/wasHidden/recoverable）。
    // 历史 bug：这里只保留 code/message，于是 Agent 拿不到 recoverable，
    // 无法判断「该重试、换 tab，还是停」，只能去猜。
    if (details !== undefined) this.details = details;
  }
  /** 便捷读取：从 details 里取字段（无 details 时返回 undefined）。 */
  detail(key) { return this.details ? this.details[key] : undefined; }
}

// 超时专用子类：让调用方可以 `e instanceof BridgeTimeoutError` 或看 code。
// 存在的意义：Node 的 req.setTimeout 回调与 req.destroy(err) 都会走 'error' 事件，
// 早期实现把自造的 TIMEOUT 又包成了 CONNECTION_REFUSED，把「请求超时」
// 谎报成「请先启动桥」——排查方向被彻底带偏。
export class BridgeTimeoutError extends BridgeError {
  constructor(message, timeoutMs) {
    super("TIMEOUT", message);
    this.name = "BridgeTimeoutError";
    this.timeoutMs = timeoutMs;
    this.details = { phase: "client-timeout", timeoutMs };
  }
}

export class Bridge {
  constructor(opts = {}) {
    this.host = opts.host || process.env.AGENT_BRIDGE_HOST || "127.0.0.1";
    this.port = opts.port || Number(process.env.AGENT_BRIDGE_PORT) || 8778;
    this.token = opts.token || loadToken();
    this.timeoutMs = opts.timeoutMs || 60000;
    this.agentId = opts.agentId || process.env.AGENT_ID || `agent-${process.pid}`;
    this.agentName = opts.agentName || process.env.AGENT_NAME || this.agentId;
  }

  base() { return `http://${this.host}:${this.port}`; }

  _request(method, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const url = this.base() + method;
      // POST 用于所有写操作（/rpc、/agents/register、/tabs/claim|release、/agent/stop|resume）；
      // /status 是唯一的只读 GET。
      // 历史 bug：这里写成 `method === "/rpc" ? "POST" : "GET"`，于是 register/claim/release
      // 全部以 GET 发出，而 host 只注册了 POST —— 调用方拿到 404 NOT_FOUND。
      const httpMethod = method === "/status" ? "GET" : "POST";
      const req = http.request(url, {
        method: httpMethod,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.token}`,
          "X-Agent-Id": this.agentId,
          "X-Agent-Name": encodeURIComponent(this.agentName),
        },
      }, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch (e) {
            return reject(new BridgeError("BAD_RESPONSE", `host 返回非 JSON: ${data.slice(0, 200)}`));
          }
          if (res.statusCode === 401) {
            return reject(new BridgeError("UNAUTHORIZED", "token 无效，请检查 ~/.chrome-agent-bridge/token"));
          }
          if (res.statusCode === 404) {
            return reject(new BridgeError("NOT_FOUND", `host 没有这个路由: ${method}`));
          }
          if (!parsed.ok) {
            // details 必须透传（与 lib/bridge.mjs 的 BridgeRpcError 保持一致）——
            // 它是「可编程判断」的载体，丢了就只剩下解析 message 文本这条路。
            return reject(new BridgeError(parsed.error?.code || "RPC_ERROR", parsed.error?.message || "未知错误", parsed.error?.details));
          }
          // /status 等非 RPC 接口返回整个 body（无 result 字段）；/rpc 返回 result
          resolve(method === "/rpc" ? (parsed.result === undefined ? null : parsed.result) : parsed);
        });
      });
      // 错误分类：只有真正的连接层失败才算 CONNECTION_REFUSED。
      // 超时（我们自己 destroy 的）、主动中断、以及已经成型的 BridgeError 都原样透传。
      req.on("error", (e) => {
        if (e instanceof BridgeError) return reject(e);          // 自造的超时/中断，不要二次包装
        if (e && e.name === "AbortError") return reject(new BridgeError("ABORTED", "请求已被取消"));
        const code = e && e.code;
        if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
          return reject(new BridgeTimeoutError(`请求超时（${e.message}）`, timeoutMs || this.timeoutMs));
        }
        return reject(new BridgeError(
          "CONNECTION_REFUSED",
          `无法连接本地桥 ${this.base()}（${e.message}），请先启动: node relay/host.js --standalone`,
          { cause: code || null }
        ));
      });
      req.setTimeout(timeoutMs || this.timeoutMs, () => {
        // 用专属错误实例：destroy(err) 会把它交给上面的 'error' 处理器，
        // 那里凭 instanceof 判定并原样透传，不再降级为 CONNECTION_REFUSED。
        req.destroy(new BridgeTimeoutError(`请求超时 ${timeoutMs || this.timeoutMs}ms: ${method}`, timeoutMs || this.timeoutMs));
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // 通用 RPC
  rpc(method, params = {}, opts = {}) {
    return this._request("/rpc", { method, params, timeoutMs: opts.timeoutMs }, opts.timeoutMs);
  }
  register(name = this.agentName) { return this._request("/agents/register", { agentId: this.agentId, name }); }
  claimTab(tabId, ttlMs) { return this._request("/tabs/claim", { tabId, agentId: this.agentId, ttlMs }); }
  releaseTab(tabId) { return this._request("/tabs/release", { tabId, agentId: this.agentId }); }

  // ---------- 停止 / 恢复 ----------
  // 注意：这两个走 host 的独立路由，**不是** RPC。原因：停止必须能在扩展未连接、
  // RPC 通道不可用时也生效（否则「停止」就变成「等桥好了再说」）。
  // tabId 省略 = 全局停止。
  stop(tabId, opts = {}) { return this._request("/agent/stop", { tabId, reason: opts.reason, ttlMs: opts.ttlMs, agentId: this.agentId }); }
  resume(tabId) { return this._request("/agent/resume", { tabId, agentId: this.agentId }); }

  // ---------- 状态 ----------
  status() { return this._request("/status"); }
  // ---------- 标签页 ----------
  async list() { const r = await this.rpc("tabs.list"); return r.tabs; }
  async active() { const r = await this.rpc("tabs.active"); return r.tab; }
  async get(tabId) { const r = await this.rpc("tabs.get", { tabId }); return r.tab; }
  async create(url, opts = {}) { const r = await this.rpc("tabs.create", { url, ...opts }); return r.tab; }
  // 打开 URL 的首选入口：复用「用户没在看」的同类 tab，否则静默新开后台 tab。
  // 返回 { tab, tabId, reused, navigated, reason }（不是裸 tab，注意取 .tabId）
  async open(url, opts = {}) { return this.rpc("tabs.resolve", { url, ...opts }); }
  async activate(tabId) { const r = await this.rpc("tabs.activate", { tabId }); return r.tab; }
  // 静默准备：注入 content script + 防后台冻结，不切激活 tab / 不聚焦窗口
  async prepare(tabId) { return this.rpc("tabs.prepare", { tabId }); }
  async close(tabId) { return this.rpc("tabs.close", { tabId }); }
  async reload(tabId, opts = {}) { const r = await this.rpc("tabs.reload", { tabId, ...opts }); return r.tab; }

  // ---------- 页面 ----------
  async info(tabId) { const r = await this.rpc("page.info", { tabId }); return r.tab; }
  async navigate(tabId, url, opts = {}) { const r = await this.rpc("page.navigate", { tabId, url, ...opts }); return r.tab; }
  async back(tabId) { const r = await this.rpc("page.back", { tabId }); return r.tab; }
  async forward(tabId) { const r = await this.rpc("page.forward", { tabId }); return r.tab; }
  async focus(tabId) { return this.rpc("page.focus", { tabId }); }
  async waitLoad(tabId, timeoutMs) { return this.rpc("page.waitLoad", { tabId, timeoutMs }); }
  async waitForReady(tabId, timeoutMs) { return this.rpc("page.waitForReady", { tabId, timeoutMs }); }
  async waitForUrl(tabId, opts = {}) { return this.rpc("page.waitForUrl", { tabId, ...opts }); }
  async waitForSelector(tabId, selector, opts = {}) { return this.rpc("page.waitForSelector", { tabId, selector, ...opts }); }

  async snapshot(tabId, opts = {}) {
    return this.rpc("page.snapshot", { tabId, mode: opts.mode || "a11y", maxDepth: opts.maxDepth, maxNodes: opts.maxNodes, includeText: opts.includeText });
  }
  async evaluate(tabId, expression, opts = {}) {
    const r = await this.rpc("page.evaluate", { tabId, expression, world: opts.world, awaitPromise: opts.awaitPromise });
    return r.result;
  }
  async click(tabId, selector, opts = {}) { return this.rpc("page.click", { tabId, selector, by: opts.by || "css" }); }
  async type(tabId, selector, text, opts = {}) { return this.rpc("page.type", { tabId, selector, text, by: opts.by || "css", clear: opts.clear }); }
  async press(tabId, key, opts = {}) { return this.rpc("page.press", { tabId, key, ...opts }); }
  async scroll(tabId, opts = {}) { return this.rpc("page.scroll", { tabId, ...opts }); }
  async hover(tabId, selector, opts = {}) { return this.rpc("page.hover", { tabId, selector, by: opts.by || "css" }); }
  async select(tabId, selector, value, opts = {}) { return this.rpc("page.select", { tabId, selector, value, by: opts.by || "css", multiple: opts.multiple }); }
  async waitFor(tabId, opts = {}) { return this.rpc("page.waitFor", { tabId, ...opts }); }

  // 截图：默认存到本地文件，返回 { path, format, captureMode, image }
  async screenshot(tabId, outPath, opts = {}) {
    const format = opts.format || (outPath ? (outPath.endsWith(".jpg") || outPath.endsWith(".jpeg") ? "jpeg" : "png") : "png");
    const r = await this.rpc("page.screenshot", { tabId, format, quality: opts.quality, captureBeyondViewport: opts.captureBeyondViewport });
    if (outPath) {
      const b64 = r.image.split(",")[1];
      fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
      return { ...r, path: outPath };
    }
    return r;
  }

  // ---------- 视觉指示器 ----------
  indicatorMove(tabId, x, y) { return this.rpc("page.indicator.move", { tabId, x, y }); }
  indicatorClick(tabId, x, y) { return this.rpc("page.indicator.click", { tabId, x, y }); }
  indicatorHighlight(tabId, selector) { return this.rpc("page.indicator.highlight", { tabId, selector }); }
  indicatorHide(tabId) { return this.rpc("page.indicator.hide", { tabId }); }
  indicatorStop(tabId, show = true, label) { return this.rpc("page.indicator.stop", { tabId, show, label }); }

  // ---------- CDP ----------
  sessionAttach(tabId) { return this.rpc("session.attach", { tabId }); }
  sessionDetach(tabId) { return this.rpc("session.detach", { tabId }); }
  sessionSend(tabId, method, params = {}) { return this.rpc("session.send", { tabId, method, params }); }

  // ---------- 事件订阅（WS） ----------
  // 返回 AsyncIterable<{event, payload}>；通过 AbortController 停止
  subscribe(signal) {
    const url = `ws://${this.host}:${this.port}/bridge?token=${encodeURIComponent(this.token)}&agentId=${encodeURIComponent(this.agentId)}&name=${encodeURIComponent(this.agentName)}`;
    const ws = new WebSocket(url);
    const queue = [];
    const waiters = [];
    let closed = false;

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === "event") {
        if (waiters.length) waiters.shift()(msg);
        else queue.push(msg);
      }
    };
    ws.onclose = () => {
      closed = true;
      while (waiters.length) waiters.shift()({ type: "event", event: "closed", payload: null });
    };
    ws.onerror = () => { /* handled by close */ };

    if (signal) {
      signal.addEventListener("abort", () => { try { ws.close(); } catch (e) { /* noop */ } });
    }

    const iterator = {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (closed) return Promise.resolve({ value: { type: "event", event: "closed", payload: null }, done: true });
        return new Promise((resolve) => waiters.push((msg) => resolve({ value: msg, done: false })));
      },
    };
    return iterator;
  }
}
