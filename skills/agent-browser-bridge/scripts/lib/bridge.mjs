#!/usr/bin/env node
/**
 * 桥调用统一封装 —— 解决「返回值解包层数随调用路径变化」这个反复踩的坑。
 *
 * 背景（实测）：同一个 Runtime.evaluate 结果，三条调用路径的取值位置各不相同：
 *   1. 裸 HTTP POST /rpc          → json.result.result.value      （三层）
 *   2. client.mjs bridge.rpc()    → r.result.value                （两层）
 *   3. client.mjs bridge.evaluate → 返回 {type, value}，还要 .value
 * 历史上只在裸 HTTP 场景写过一句「在 result.result 里」，于是只有走 client 封装的人会踩。
 * 本模块把差异收敛到 unwrap() 一处，其余代码只拿最终值。
 *
 * 设计约束：
 * - 自包含：只依赖 Node 内置模块，直连 host 的 HTTP 接口，
 *   这样 skill 被单独拷贝/链接时依然可用（见仓库 AGENTS.md「Skill 必须自包含」）。
 * - 不吞错：解包失败抛错并带上原始响应片段，便于定位，而不是静默返回 undefined。
 *   （历史教训：`pos` 变 undefined 连查三轮才发现是层数不对。）
 * - 每个会话操作都保证 finally detach（历史教训：异常路径漏 detach 拖死整个 host）。
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Chrome 与 Firefox 各有一个 host：RPC 方法与返回结构相同，只是端口不同。
// 选浏览器用 BRIDGE_BROWSER=chrome|firefox；BRIDGE_PORT 显式指定时优先。
export const BROWSER_PORTS = { chrome: 8778, firefox: 8779 };
export function defaultPort(env = process.env) {
  if (env.BRIDGE_PORT || env.AGENT_BRIDGE_PORT) return Number(env.BRIDGE_PORT || env.AGENT_BRIDGE_PORT);
  const browser = env.BRIDGE_BROWSER || "chrome";
  if (!BROWSER_PORTS[browser]) throw new Error(`BRIDGE_BROWSER 仅支持 ${Object.keys(BROWSER_PORTS).join(" / ")}，收到 ${browser}`);
  return BROWSER_PORTS[browser];
}
const DEFAULT_PORT = defaultPort();
// 裸 fetch 的脚本用它拼 URL：`${BRIDGE_ORIGIN}/rpc`
export const BRIDGE_ORIGIN = `http://127.0.0.1:${DEFAULT_PORT}`;

// 本库依赖的最低桥版本：page.read / page.evalCdp / page.clickReal / page.typeReal / page.uploadFile 在 0.3.13 引入
export const MIN_BRIDGE_VERSION = "0.3.13";
const CLIENT_TIMEOUT_MARGIN_MS = 3000;
export function versionGte(a, b) {
  const x = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const y = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return true;
}

export function readToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN.trim();
  if (process.env.AGENT_BRIDGE_TOKEN) return process.env.AGENT_BRIDGE_TOKEN.trim();
  const p = path.join(os.homedir(), ".chrome-agent-bridge", "token");
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    throw new Error(`读不到 token：${p}（桥可能从未安装，按 skill 目录下 INSTALL.md 安装）`);
  }
}

const activeRpcInstances = new Set();
let processHooksInstalled = false;

async function cleanupAllRpcInstances() {
  const tasks = [];
  for (const inst of activeRpcInstances) {
    tasks.push(inst.cleanup());
  }
  await Promise.allSettled(tasks);
}

function installProcessHooks() {
  if (processHooksInstalled) return;
  processHooksInstalled = true;

  process.once("beforeExit", () => {
    cleanupAllRpcInstances();
  });

  // node:test 运行器自己管理异常；仅在独立脚本执行时安装顶层守护
  if (process.env.NODE_TEST_CONTEXT) return;

  const onFatal = async (err, origin) => {
    // 若外部脚本自己额外注册了监听器，先清理资源后交由外部监听器处理
    const listenerCount = process.listenerCount(origin);
    await cleanupAllRpcInstances();
    if (listenerCount > 1) return;
    if (err && err.code === "AGENT_STOPPED") {
      console.error(`\n⏹ [AGENT_STOPPED] ${err.message || "用户已停止 Agent"}`);
      process.exit(3);
    }
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  };

  process.on("unhandledRejection", (reason) => { onFatal(reason, "unhandledRejection"); });
  process.on("uncaughtException", (err) => { onFatal(err, "uncaughtException"); });
}

// CDP RemoteObject 的字段全集：只有形状完全符合时才取其 value。
// 曾用「含 value 键」判定，于是 page.typeReal 的返回 {ok, value, verified, delta} 被剥成了 value 字符串，
// verified / delta 全部丢失。
const REMOTE_OBJECT_KEYS = new Set(["type", "subtype", "className", "value", "unserializableValue", "description", "objectId", "preview"]);
function isRemoteObject(o) {
  return !!o && typeof o === "object" && !Array.isArray(o) && typeof o.type === "string" && Object.keys(o).every((k) => REMOTE_OBJECT_KEYS.has(k));
}

/** 三层解包自适应：把任意调用路径的响应收敛成最终值。 */
export function unwrap(resp) {
  if (resp == null) return resp;
  let v = resp;
  // 逐层剥：{result:{result:RemoteObject}} / {result:RemoteObject} / {result:...}
  for (let i = 0; i < 4; i++) {
    if (isRemoteObject(v)) {
      v = v.value;
      break;
    }
    if (v && typeof v === "object" && "result" in v) {
      v = v.result;
      continue;
    }
    break;
  }
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

export class Rpc {
  constructor({ port = DEFAULT_PORT, token = readToken(), agentId, agentName } = {}) {
    this.port = port;
    this.token = token;
    this.agentId = agentId || process.env.AGENT_ID || `agent-${process.pid}`;
    this.agentName = agentName || process.env.AGENT_NAME || this.agentId;
    this._attached = new Set();
    this._claimed = new Set();
    // 每个 tab 的连续失败计数：同一个 tab 上反复出现「上下文类」错误说明它已经废了。
    // 真实案例：某个永远 status:"loading" 的 SPA 上，agent 盲试了 155 次
    // PAGE_CONTEXT_TIMEOUT（evaluate 失败 → prepare 失败 → 再 evaluate），
    // 每次都只多花几秒，但累积起来把一个简单任务拖成了事故。
    this._strikes = new Map();
    this.maxStrikes = 3;
    activeRpcInstances.add(this);
    installProcessHooks();
  }

  /** 释放当前实例持有的全部 CDP 会话与 Tab 租约。 */
  async cleanup() {
    for (const tabId of [...this._attached]) {
      await this.detach(tabId);
    }
    for (const tabId of [...this._claimed]) {
      await this.releaseTab(tabId).catch(() => {});
    }
  }

  /** 申请 Tab 互斥租约（退出时自动释放）。 */
  async claimTab(tabId, ttlMs = 120000) {
    const r = await this._post("/tabs/claim", JSON.stringify({ tabId, agentId: this.agentId, ttlMs }));
    this._claimed.add(tabId);
    return r;
  }

  /** 释放 Tab 互斥租约。 */
  async releaseTab(tabId) {
    this._claimed.delete(tabId);
    return this._post("/tabs/release", JSON.stringify({ tabId, agentId: this.agentId }));
  }

  /** 查询 host 内存记录的近期错误（免去 grep host.log）。 */
  async recentErrors(opts = {}) {
    return this.call("bridge.recentErrors", opts, 10000);
  }

  /** 这个 tab 是否已被判定为「废了」。 */
  isUnhealthy(tabId) {
    return (this._strikes.get(tabId) || 0) >= this.maxStrikes;
  }

  /** 清零某 tab 的失败计数（换页/重建上下文后调用）。 */
  clearStrikes(tabId) {
    this._strikes.delete(tabId);
  }

  _noteFailure(tabId, code) {
    // 只有「tab 本身坏了」才算 strike；业务错误（如元素不存在）不算。
    const TAB_LEVEL = new Set(["PAGE_CONTEXT_TIMEOUT", "TAB_GONE", "TAB_DISCARDED", "SESSION_ATTACH_FAILED", "ATTACH_FAILED", "UNSUPPORTED_URL", "DEBUGGER_BUSY"]);
    if (!TAB_LEVEL.has(code)) return;
    const n = (this._strikes.get(tabId) || 0) + 1;
    this._strikes.set(tabId, n);
    if (n === this.maxStrikes) {
      // 只喊一次，避免刷屏
      console.error(
        `\n⚠ tab #${tabId} 已连续 ${n} 次出现「上下文/标签页级」错误（最近 ${code}）。\n` +
        `  这通常意味着该 tab 不可注入（受保护页 / 被丢弃 / 永远 loading 的 SPA）。\n` +
        `  继续在这个 tab 上重试是无效的 —— 请改用 tabs.resolve 打开目标页，或换一个 tab。\n` +
        `  （想继续硬试可调 rpc.maxStrikes，或用 rpc.clearStrikes(tabId) 清零）\n`
      );
    }
  }

  /**
   * 停止 / 恢复（用户可能在页面上随时按下「停止 Agent」）。
   *
   * 不带 tabId = 全局停止；带 tabId = 只停那个标签页（页面按钮就是这个语义）。
   * 停止只拦**写**操作（click/type/navigate/…、CDP 的 Input.*），只读不受影响；
   * 被拦时错误码为 AGENT_STOPPED，`details.resumeWith` 是 "agent.resume"。
   * 已经落到页面上的动作无法撤销，只有尚未派发的排队请求会被取消。
   */
  async stop(tabId, { reason = "api", ttlMs } = {}) {
    const body = JSON.stringify({ tabId: tabId === undefined ? null : tabId, reason, ttlMs });
    return this._post("/agent/stop", body);
  }

  /** 解除停止。省略 tabId = 解除全局。 */
  async resume(tabId) {
    const body = JSON.stringify({ tabId: tabId === undefined ? null : tabId });
    return this._post("/agent/resume", body);
  }

  /** 查询停止状态（不依赖事件订阅，HTTP-only 客户端也能用）。 */
  async stopStatus(tabId) {
    return this.call("agent.stopStatus", tabId === undefined ? {} : { tabId });
  }

  /** POST 一个 JSON 路由（非 RPC，但同样需要 token）。 */
  _post(pathname, bodyStr) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1", port: this.port, path: pathname, method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.token}`,
            "X-Agent-Id": this.agentId,
            "X-Agent-Name": encodeURIComponent(this.agentName),
            "Content-Length": Buffer.byteLength(bodyStr),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            let json;
            try { json = JSON.parse(data); } catch {
              return reject(new BridgeRpcError("BAD_RESPONSE", `host 返回非 JSON: ${data.slice(0, 200)}`, pathname));
            }
            if (!json.ok) {
              const e = json.error || {};
              return reject(new BridgeRpcError(e.code || "RPC_ERROR", e.message || "未知错误", pathname, e.details));
            }
            resolve(json.result === undefined ? json : json.result);
          });
        }
      );
      req.on("error", (e) =>
        e instanceof BridgeRpcError
          ? reject(e)
          : reject(new BridgeRpcError("CONNECTION_REFUSED", `无法连接本地桥 127.0.0.1:${this.port}（${e.message}）`, pathname))
      );
      req.setTimeout(this.timeoutMs || 20000, () => req.destroy(new BridgeRpcError("TIMEOUT", "请求超时", pathname)));
      req.write(bodyStr);
      req.end();
    });
  }

  /** 原始 RPC。返回已解包的值；失败抛 BridgeRpcError。 */
  async call(method, params = {}, timeoutMs = 20000) {
    return unwrap({ result: await this.callRaw(method, params, timeoutMs) });
  }

  /**
   * 原始 RPC，返回 host 响应里的 result 原样（不解包）。
   * session.send 需要先持有会话：本实例还没 attach 该 tab 时先自动 attach，进程退出时由 cleanup() 释放。
   * （ev() 改走 page.evalCdp 之前，调用方习惯「ev 之后直接 session.send」，靠的是 ev 顺带建立的会话。）
   */
  async callRaw(method, params = {}, timeoutMs = 20000) {
    if (method === "session.send" && params && params.tabId != null && !this._attached.has(params.tabId)) {
      await this.attach(params.tabId);
    }
    return this._send(method, params, timeoutMs);
  }

  _send(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ method, params, timeoutMs });
      const req = http.request(
        {
          host: "127.0.0.1",
          port: this.port,
          path: "/rpc",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.token}`,
            "X-Agent-Id": this.agentId,
            "X-Agent-Name": encodeURIComponent(this.agentName),
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            let json;
            try { json = JSON.parse(data); } catch {
              return reject(new BridgeRpcError("BAD_RESPONSE", `host 返回非 JSON: ${data.slice(0, 200)}`, method));
            }
            if (!json.ok) {
              const e = json.error || {};
              const code = e.code || "RPC_ERROR";
              if (params && params.tabId) this._noteFailure(params.tabId, code);
              return reject(new BridgeRpcError(code, e.message || "未知错误", method, e.details));
            }
            resolve(json.result);
          });
        }
      );
      req.on("error", (e) =>
        // req.destroy(err)（超时/主动中断）会把我们自己的 BridgeRpcError 也走 error 事件，
        // 无差别包装会把它伪装成 CONNECTION_REFUSED——调用方于是去排查本地桥是否挂了，
        // 而真实原因是「页面上下文超时」。原样透传，保持错误码可编程判断。
        e instanceof BridgeRpcError
          ? reject(e)
          : reject(new BridgeRpcError("CONNECTION_REFUSED", `无法连接本地桥 127.0.0.1:${this.port}（${e.message}）`, method))
      );
      // 比 host 侧预算多等一点：host 到点会回带具体错误码的响应（如 PAGE_CONTEXT_TIMEOUT），
      // 客户端同时到点会把它抢先盖成笼统的 TIMEOUT。
      req.setTimeout(timeoutMs + CLIENT_TIMEOUT_MARGIN_MS, () => req.destroy(new BridgeRpcError("TIMEOUT", `请求超时 ${timeoutMs}ms`, method)));
      req.write(body);
      req.end();
    });
  }

  /** host 的 /status 原样返回（无需 token）：版本、通道、扩展是否连接、停止状态、在途请求。 */
  status() {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: this.port, path: "/status" }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try { resolve(JSON.parse(d)); } catch {
            reject(new BridgeRpcError("BAD_RESPONSE", `host /status 返回非 JSON: ${d.slice(0, 200)}`, "status"));
          }
        });
      });
      req.on("error", (e) => reject(new BridgeRpcError("CONNECTION_REFUSED", `无法连接本地桥 127.0.0.1:${this.port}（${e.message}）`, "status")));
      req.setTimeout(5000, () => req.destroy(new BridgeRpcError("TIMEOUT", "status 超时", "status")));
    });
  }

  /** 静默截图并写到 outPath（按扩展名选 png / jpeg），返回 { path, format, bytes }。 */
  async screenshot(tabId, outPath, { quality, captureBeyondViewport } = {}) {
    const format = /\.jpe?g$/i.test(outPath) ? "jpeg" : "png";
    const r = await this.call("page.screenshot", { tabId, format, quality, captureBeyondViewport }, 30000);
    const buf = Buffer.from(String(r.image).split(",")[1], "base64");
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, buf);
    return { path: path.resolve(outPath), format, bytes: buf.length };
  }

  /**
   * 版本与连通性一次拿全。版本号是统一的（host 与扩展同源）。
   * 低于 MIN_BRIDGE_VERSION 直接抛 BRIDGE_TOO_OLD：本库的封装不再为旧扩展做降级。
   */
  async preflight() {
    const st = await this.status();
    // 统一版本：优先用扩展自报值（它才是实际在跑的代码），
    // 没自报（如刚重连）则用 host 读 manifest 得到的值。
    const version = st.reportedExtensionVersion || st.version || null;
    const versionKnown = !!version && version !== "unknown";
    if (versionKnown && !versionGte(version, MIN_BRIDGE_VERSION)) {
      throw new BridgeRpcError(
        "BRIDGE_TOO_OLD",
        `桥版本 ${version} 低于本库要求的 ${MIN_BRIDGE_VERSION}，按 INSTALL.md 更新仓库并重载扩展`,
        "preflight"
      );
    }
    return {
      ok: !!st.ok,
      version,
      versionKnown,
      extConnected: !!st.extConnected,
      channel: st.channel,
      mode: st.mode,
      pending: st.pending,
    };
  }

  // ---------- 页面求值（CDP，绕过 CSP） ----------

  /**
   * 显式持有 CDP 会话。只有需要连续发 session.send（如 Emulation.* 覆盖要跨多次调用生效）时才用；
   * 普通求值用 ev()，它每次借用调试器、用完归还。用 withSession 包裹可保证异常路径也 detach。
   */
  async attach(tabId, { force = false } = {}) {
    if (!force && this._attached.has(tabId)) {
      return { attached: true, tabId, already: true, cached: true };
    }
    const r = await this.call("session.attach", { tabId }, 15000);
    this._attached.add(tabId);
    return r;
  }

  async detach(tabId) {
    if (!this._attached.has(tabId)) return;
    try { await this.call("session.detach", { tabId }, 10000); } catch { /* 收工失败不影响主流程 */ }
    this._attached.delete(tabId);
  }

  /**
   * 在页面执行 JS 并取回值（page.evalCdp → CDP Runtime.evaluate，不受页面 CSP / Trusted Types 限制）。
   * 每次调用借用调试器、用完立即归还，不留调试提示条；本实例已 attach 时扩展会复用该会话。
   * 返回字符串时尝试 JSON.parse（页面里 JSON.stringify 的结果直接拿到对象）。
   * 页面抛异常时报 EVAL_ERROR。
   */
  async ev(tabId, expression, { awaitPromise = false, userGesture = true, timeoutMs = 30000 } = {}) {
    // 已判定废掉的 tab 直接快速失败，不再浪费一轮网络往返
    if (this.isUnhealthy(tabId)) {
      throw new BridgeRpcError(
        "TAB_UNHEALTHY",
        `tab #${tabId} 已连续 ${this._strikes.get(tabId)} 次上下文类失败，不再重试。用 tabs.resolve 换一个 tab。`,
        "page.evalCdp"
      );
    }
    const r = await this.callRaw("page.evalCdp", { tabId, expression, awaitPromise, userGesture, timeoutMs }, timeoutMs);
    // 成功即清零：说明这个 tab 其实还能用
    this.clearStrikes(tabId);
    // 只取 result 字段，不走 unwrap：页面返回的对象恰好带 value 键时 unwrap 会误剥一层
    const v = r ? r.result : r;
    if (typeof v === "string") {
      try { return JSON.parse(v); } catch { return v; }
    }
    return v;
  }

  /** 一键读取网页正文、标题、主链接与阻断状态（自动打开/复用、处理后台未渲染并关闭临时 tab）。 */
  async readPage(urlOrOpts, opts = {}) {
    const params = typeof urlOrOpts === "string" ? { url: urlOrOpts, ...opts } : { ...(urlOrOpts || {}) };
    return this.call("page.read", params, (params.timeoutMs || 45000) + 10000);
  }

  /** 获取带 [e1] 持久化引用的紧凑页面快照。 */
  async snapshotCompact(tabId, opts = {}) {
    return this.call("page.snapshot", { tabId, mode: "compact", ...opts }, opts.timeoutMs || 20000);
  }

  /** 页面里执行一段函数体（可含 return），结果 JSON 往返后取回。 */
  async evJson(tabId, body, opts) {
    return this.ev(tabId, `JSON.stringify((()=>{ ${body} })())`, opts);
  }

  /** 保证 detach 的会话作用域：异常路径也不会把 host 拖死。 */
  async withSession(tabId, fn) {
    await this.attach(tabId);
    try {
      return await fn((expr, opts) => this.ev(tabId, expr, opts));
    } finally {
      await this.detach(tabId);
    }
  }

  // ---------- 点击与输入：扩展侧单次原子 RPC ----------

  /**
   * 真实鼠标点击（CDP Input.dispatchMouseEvent），返回带 delta。
   *   clickReal(tabId, x, y[, opts])        —— 视口坐标
   *   clickReal(tabId, "@e3" | css[, opts]) —— 元素（自动滚动居中算坐标）
   *   clickReal(tabId, { ref, by, ... })    —— 完整参数
   * 后台标签页不处理 CDP 鼠标事件（扩展报 TAB_HIDDEN）：这里临时 ensureActive 后重试一次，
   * 借走的活动页空闲后由扩展自动归还。坐标点击时激活不改变坐标（只切标签页，不改窗口）。
   */
  async clickReal(tabId, target, y, opts = {}) {
    let params;
    if (typeof target === "number") params = { tabId, x: Math.round(target), y: Math.round(y), ...opts };
    else if (target && typeof target === "object") params = { tabId, ...target };
    else params = { tabId, selector: String(target), ...(y && typeof y === "object" ? y : {}) };
    try {
      return await this.call("page.clickReal", params, 20000);
    } catch (e) {
      if (!(e instanceof BridgeRpcError) || e.code !== "TAB_HIDDEN") throw e;
      await this.ensureActive(tabId);
      return { ...(await this.call("page.clickReal", params, 20000)), activated: true };
    }
  }

  /**
   * 受控组件真实输入（聚焦 + 清空 + CDP Input.insertText + 回读校验 verified），返回带 delta。
   * pressEnter 在后台标签页无效（扩展报 TAB_HIDDEN，此时尚未改动输入框）：临时 ensureActive 后重试一次。
   */
  async typeReal(tabId, selector, text, opts = {}) {
    const params = { tabId, selector, text, ...opts };
    try {
      return await this.call("page.typeReal", params, 20000);
    } catch (e) {
      if (!(e instanceof BridgeRpcError) || e.code !== "TAB_HIDDEN") throw e;
      await this.ensureActive(tabId);
      return { ...(await this.call("page.typeReal", params, 20000)), activated: true };
    }
  }

  /** 给 input[type=file] 注入本地文件（绝对路径）。 */
  async uploadFile(tabId, selector, files) {
    const fileList = Array.isArray(files) ? files : [files];
    return this.call("page.uploadFile", { tabId, selector: selector || 'input[type="file"]', files: fileList }, 30000);
  }

  /** DOM el.click()。某些按钮（如 LinkedIn「删除项目」）只认这个。expression 是返回元素的 JS 表达式。 */
  async clickEl(tabId, expression) {
    return this.ev(
      tabId,
      `(()=>{const el=${expression}; if(!el) return {ok:false,err:'element not found'}; el.click(); return {ok:true};})()`
    );
  }

  // ---------- 前台渲染保障（rAF 被暂停时） ----------

  /**
   * 确保目标页真的在渲染。**只在必要时才激活**（`document.hidden` 为真时），
   * 且只切标签页、**不聚焦窗口**——实测 `chrome.tabs.update({active:true})` 单独就能把
   * requestAnimationFrame 拉起来（Chrome 不在前台时也有效），不会把用户从别的应用里弹出来。
   *
   * 为什么需要它：Chrome 对后台标签页把 rAF **完全暂停**（实测 2s 内 0 帧，活动页 60 帧），
   * 依赖 rAF 的懒加载 / 瀑布流 / 无限滚动永不推进，加长超时没用（是暂停不是节流）。
   * 注：CDP `Emulation.setFocusEmulationEnabled` 也能恢复 rAF，但它 **detach 或页面导航后
   * 立即失效**，而 detach 是每次 RPC 收尾都会做的事——所以只能真激活。
   *
   * 用完会空闲 `restoreAfterMs`（默认 20s）后自动把活动标签页还给用户原来那个；
   * 长流程中每次 page.* 调用都会续期，不会中途抢走前台。提前归还可调 `restoreActive`。
   *
   * @returns {Promise<{activated:boolean, alreadyRendering:boolean, willRestoreTo?:number}>}
   */
  async ensureActive(tabId, { restoreAfterMs } = {}) {
    const params = { tabId };
    if (restoreAfterMs != null) params.restoreAfterMs = restoreAfterMs;
    return this.call("page.ensureActive", params, 20000);
  }

  /** 立刻把活动标签页还给用户（不等空闲计时器）。 */
  async restoreActive(tabId) {
    return this.call("page.restoreActive", { tabId }, 15000);
  }

  /**
   * 滚动并验证真的推进了。后台页 rAF 被暂停时，滚动指令会「成功」但页面不动——
   * 那种假成功会让人拿着空列表继续往下走。这个封装会回读页面高度与滚动位置，
   * 没推进就抛 `SCROLL_STALLED` / `SCROLL_NO_GROWTH`（错误里带 `atBottom` / `wasHidden` /
   * `recoverable` 结构化字段，不用解析 message）。
   *
   * @param {object} opts 透传给 page.scroll（direction/amount/selector/y/behavior...）
   * @param {boolean} [opts.allowNoProgress] 到底了就设 true，避免在最后一屏报错
   */
  async scrollChecked(tabId, opts = {}) {
    return this.call("page.scroll", { tabId, ...opts, checked: true }, 30000);
  }

  /**
   * 滚动加载：**先直接滚，真的卡住了才临时激活并重试**。
   *
   * 这是给「滚动加载列表」场景的推荐入口——把「要不要激活」的判断收敛在一处，
   * 不需要每个 Agent 自己写 try/catch 去读 `recoverable`：
   *
   *  1. 先直接 `scrollChecked`（不打扰用户前台）；
   *  2. 只有错误里 `recoverable === true`（后台渲染被暂停，且不是真的到底了）才 `ensureActive`；
   *  3. 激活后重试一次；仍不推进就**原样抛出**，让调用方自己决定收尾；
   *  4. 激活过的（`borrowed:true`）会在流程末尾自动归还前台（或由调用方显式 `restoreActive`）。
   *
   * 不自动激活的场景：`recoverable === false`（前台也没动 → 选择器/容器问题）、
   * 或错误里 `atBottom === true`（大概率真到底了，激活没用）。
   *
   * @returns {Promise<object>} 最后一次成功的结果，额外带 `borrowed` / `activated` / `attempts`
   */
  async scrollLoad(tabId, opts = {}) {
    const attempt = async () => {
      try {
        const r = await this.scrollChecked(tabId, opts);
        return { ok: true, r };
      } catch (e) {
        return { ok: false, e };
      }
    };

    let first = await attempt();
    if (first.ok) return { ...first.r, borrowed: false, activated: false, attempts: 1 };

    const e = first.e;
    const canRecover = e.detail("recoverable") === true;
    if (!canRecover) throw e;                     // 激活也解决不了：原样抛出

    await this.ensureActive(tabId);
    const second = await attempt();
    if (second.ok) {
      return { ...second.r, borrowed: true, activated: true, attempts: 2, firstError: { code: e.code, details: e.details } };
    }
    // 激活后仍不推进：把第二次的错误抛出（信息更新），但保留第一次的错误码便于归因
    second.e.details = { ...(second.e.details || {}), firstCode: e.code, activatedButStillStalled: true };
    throw second.e;
  }

  // ---------- 选 tab 与收尾 ----------

  /**
   * 在指定 url 上开工：复用/新开 tab → 等就绪 → 自检可注入 → 跑 fn → **默认关掉自己开的 tab**。
   * 这是「不要自己挑 tab」的推荐入口：避免了选到 discarded / chrome:// / 永远 loading 的页。
   *
   * 历史教训 1：agent 自己从 tabs.list 里挑 tab，挑中一个 status:"loading" 的 SPA，
   * 于是在上面盲试了 155 次 PAGE_CONTEXT_TIMEOUT。这里把「选 tab + 验可用」合并成一步。
   * 历史教训 2：跑完不关 tab，反复跑测试会攒下一堆垃圾页（实测攒了 21 个 example.com）。
   * 所以默认 cleanup:true —— 只关**本次新建**的 tab，复用用户已有的 tab 绝不关。
   *
   * @param {object} opts
   * @param {boolean} [opts.cleanup=true] 结束时是否关闭本次新建的 tab
   * @param {boolean} [opts.keepOpen] 等价于 cleanup:false（保留页面供人工查看）
   */
  async withPage(url, fn, { match = "host", timeoutMs = 45000, probe = true, cleanup = true, keepOpen = false } = {}) {
    const opened = await openUrl(this, url, { match, waitLoad: true, timeoutMs });
    const tabId = opened.tabId || (opened.tab && opened.tab.id);
    if (!tabId) throw new BridgeRpcError("NO_TAB", `无法为目标 url 拿到 tab: ${url}`);

    // 只有「不是复用来的」才归我们关。复用用户已有的 tab 时关掉会破坏他的工作区。
    const shouldClose = (cleanup && !keepOpen) && opened.reused === false;

    if (probe) {
      // 探一下能否注入；失败就报清楚原因，而不是让后续每步各超时一次
      try {
        await this.call("tabs.prepare", { tabId }, 15000);
        await this.ev(tabId, "1");
      } catch (e) {
        if (shouldClose) await this.closeQuietly(tabId);
        throw new BridgeRpcError(
          "TAB_NOT_INJECTABLE",
          `tab #${tabId} 无法注入（${e.code}）。该页可能是受保护协议 / 已被丢弃 / 永远 loading。`,
          "withPage",
          { tabId, cause: e.code }
        );
      }
    }
    try {
      return await fn(tabId, opened);
    } finally {
      await this.detach(tabId);
      if (shouldClose) await this.closeQuietly(tabId);
    }
  }

  /** 关 tab，失败不抛（收尾步骤不应影响主流程结果）。 */
  async closeQuietly(tabId) {
    try {
      await this.call("tabs.close", { tabId }, 10000);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------- 变更后验证 ----------

  /**
   * 执行一次变更，然后轮询回读直到确认生效或超时。
   * 历史教训：脚本打印 ✓ 但记录其实没删掉 —— 变更类操作不能以「点了按钮」为成功依据。
   * 变更只执行一次：重复提交 / 删除 / 发送的代价远大于多等几秒。
   * @param {() => Promise<any>} mutate  触发变更
   * @param {() => Promise<boolean>} verify 回读校验（应重新加载页面/列表后判断）
   */
  async mutateAndVerify(mutate, verify, { timeoutMs = 10000, intervalMs = 1000, label = "mutation" } = {}) {
    const started = Date.now();
    await mutate();
    let polls = 0;
    while (true) {
      polls++;
      if (await verify()) return { ok: true, polls, elapsedMs: Date.now() - started, label };
      if (Date.now() - started + intervalMs > timeoutMs) return { ok: false, polls, elapsedMs: Date.now() - started, label };
      await sleep(intervalMs);
    }
  }
}

export class BridgeRpcError extends Error {
  constructor(code, message, method, details) {
    super(`[${code}] ${message}${method ? ` (${method})` : ""}`);
    this.code = code;
    this.method = method;
    // 结构化细节（如 SCROLL_NO_GROWTH 的 atBottom / wasHidden）。
    // 让调用方**可编程判断**要不要激活 / 重试，而不必去解析 message 文本。
    this.details = details;
  }

  /** 便捷读取：从 details 里取字段（无 details 时返回 undefined）。 */
  detail(key) {
    return this.details ? this.details[key] : undefined;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等待页面 readyState 为 interactive / complete。 */
export async function waitReady(rpc, tabId, timeoutMs = 30000) {
  return rpc.call("page.waitForReady", { tabId, timeoutMs }, timeoutMs + 5000);
}

/** 打开网址的首选入口：复用「用户没在看」的同类 tab，没有才静默新开后台 tab。 */
export async function openUrl(rpc, url, opts = {}) {
  return rpc.call("tabs.resolve", { url, ...opts }, 45000);
}
