// WebDriver BiDi 客户端（Firefox Remote Agent）
// 用 Node 内置 WebSocket（Node ≥ 22）连接 ws://127.0.0.1:<port>/session，零依赖。
//
// Firefox 同一时间只允许一个 BiDi 会话：host 持有它，别的工具（Playwright / Selenium）
// 再连同一个 Firefox 会拿到 `session not created`。这里把它归一成 BIDI_UNAVAILABLE。
"use strict";

const { EventEmitter } = require("events");

const CONNECT_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 30000;

class BidiError extends Error {
  constructor(code, message, bidiError) {
    super(message);
    this.code = code;
    if (bidiError) this.bidiError = bidiError;
  }
}

class BidiClient extends EventEmitter {
  constructor({ port, host = "127.0.0.1" }) {
    super();
    this.url = `ws://${host}:${port}/session`;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    this.closed = true;
  }

  async connect() {
    if (typeof WebSocket !== "function") {
      throw new BidiError("BIDI_UNAVAILABLE", `当前 Node ${process.version} 没有内置 WebSocket（需要 Node ≥ 22）`);
    }
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => {
        try { ws.close(); } catch (e) { /* noop */ }
        reject(new BidiError("BIDI_UNAVAILABLE", `连接 ${this.url} 超时（Firefox 需带 --remote-debugging-port 启动）`));
      }, CONNECT_TIMEOUT_MS);
      ws.onopen = () => { clearTimeout(timer); this.ws = ws; this.closed = false; resolve(); };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new BidiError("BIDI_UNAVAILABLE", `无法连接 ${this.url}（Firefox 需带 --remote-debugging-port 启动）`));
      };
      ws.onmessage = (ev) => this._onMessage(ev.data);
      ws.onclose = () => this._onClose();
    });
    let r;
    try {
      // unhandledPromptBehavior=ignore：不替用户处理 alert/confirm，保持日常浏览行为不变
      r = await this.send("session.new", { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: "ignore" } } } });
    } catch (e) {
      this.close();
      throw new BidiError("BIDI_UNAVAILABLE", `BiDi 会话创建失败（可能已有其他自动化工具占用该 Firefox）：${e.message}`, e.bidiError);
    }
    this.sessionId = r.sessionId;
    return r;
  }

  send(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    if (!this.ws || this.closed) return Promise.reject(new BidiError("BIDI_DISCONNECTED", "BiDi 连接未建立"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BidiError("TIMEOUT", `BiDi 命令超时(${timeoutMs}ms): ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.type === "error") {
        p.reject(new BidiError("BIDI_ERROR", `${p.method}: ${msg.error}: ${msg.message}`, msg.error));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.type === "event") this.emit("event", msg.method, msg.params);
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    this.ws = null;
    this.sessionId = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BidiError("BIDI_DISCONNECTED", `BiDi 连接已断开: ${p.method}`));
      this.pending.delete(id);
    }
    this.emit("close");
  }

  // 先 session.end 再断开：Firefox 不会因 WebSocket 关闭而立即释放会话，
  // 不结束就断开，下一个连接会拿到 `Maximum number of active sessions`。
  async end() {
    if (this.sessionId && !this.closed) {
      await this.send("session.end", {}, 5000);
    }
    this.close();
  }

  close() {
    if (this.ws) { try { this.ws.close(); } catch (e) { /* noop */ } }
    this._onClose();
  }
}

module.exports = { BidiClient, BidiError };
