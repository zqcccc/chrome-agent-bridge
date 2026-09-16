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
 * - 自包含：只依赖 Node 内置模块 + 本目录可选的 client.mjs（不存在则走 HTTP），
 *   这样 skill 被单独拷贝/链接时依然可用（见仓库 AGENTS.md「Skill 必须自包含」）。
 * - 不吞错：解包失败抛错并带上原始响应片段，便于定位，而不是静默返回 undefined。
 *   （历史教训：`pos` 变 undefined 连查三轮才发现是层数不对。）
 * - 每个会话操作都保证 finally detach（历史教训：异常路径漏 detach 拖死整个 host）。
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_PORT = Number(process.env.BRIDGE_PORT || 8778);

export function readToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  const p = path.join(os.homedir(), ".chrome-agent-bridge", "token");
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    throw new Error(`读不到 token：${p}（先运行 relay/install-host.sh）`);
  }
}

/** 三层解包自适应：把任意调用路径的响应收敛成最终值。 */
export function unwrap(resp) {
  if (resp == null) return resp;
  let v = resp;
  // 逐层剥：{result:{result:{value}}} / {result:{value}} / {result:...}
  for (let i = 0; i < 4; i++) {
    if (v && typeof v === "object" && "result" in v) {
      const inner = v.result;
      if (inner && typeof inner === "object" && "value" in inner) {
        v = inner.value;
        break;
      }
      v = inner;
      continue;
    }
    if (v && typeof v === "object" && "value" in v && Object.keys(v).every((k) => ["type", "value", "description", "subtype"].includes(k))) {
      v = v.value;
      break;
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
    this.agentId = agentId || `agent-${process.pid}`;
    this.agentName = agentName || this.agentId;
    this._attached = new Set();
    // 每个 tab 的连续失败计数：同一个 tab 上反复出现「上下文类」错误说明它已经废了。
    // 真实案例：某个永远 status:"loading" 的 SPA 上，agent 盲试了 155 次
    // PAGE_CONTEXT_TIMEOUT（evaluate 失败 → prepare 失败 → 再 evaluate），
    // 每次都只多花几秒，但累积起来把一个简单任务拖成了事故。
    this._strikes = new Map();
    this.maxStrikes = 3;
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
    const TAB_LEVEL = new Set(["PAGE_CONTEXT_TIMEOUT", "TAB_GONE", "TAB_DISCARDED", "SESSION_ATTACH_FAILED", "UNSUPPORTED_URL", "DEBUGGER_BUSY"]);
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

  /** 原始 RPC。返回已解包的值；失败抛 BridgeRpcError。 */
  call(method, params = {}, timeoutMs = 20000) {
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
              return reject(new BridgeRpcError(code, e.message || "未知错误", method));
            }
            resolve(unwrap(json));
          });
        }
      );
      req.on("error", (e) =>
        reject(new BridgeRpcError("CONNECTION_REFUSED", `无法连接本地桥 127.0.0.1:${this.port}（${e.message}）`, method))
      );
      req.setTimeout(timeoutMs, () => req.destroy(new BridgeRpcError("TIMEOUT", `请求超时 ${timeoutMs}ms`, method)));
      req.write(body);
      req.end();
    });
  }

  /** 版本与连通性一次拿全。版本号是统一的（host 与扩展同源，见 relay/host.js）。 */
  async preflight() {
    const st = await new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: this.port, path: "/status" }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      });
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(new Error("status 超时")));
    });
    const semver = (v) => String(v || "0").split(".").map((n) => parseInt(n, 10) || 0);
    const gte = (a, b) => {
      const x = semver(a), y = semver(b);
      for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
      return true;
    };
    // 统一版本：优先用扩展自报值（它才是实际在跑的代码），
    // 没自报（如刚重连）则用 host 读 manifest 得到的值。
    const version = st.reportedExtensionVersion || st.version || null;
    const versionKnown = !!version && version !== "unknown";
    return {
      ok: !!st.ok,
      version,
      versionKnown,
      extConnected: !!st.extConnected,
      channel: st.channel,
      mode: st.mode,
      pending: st.pending,
      // 常用能力的版本门槛（见 CHANGELOG「版本不匹配的典型症状」）
      capabilities: {
        tabsResolve: versionKnown ? gte(version, "0.3.9") : null,
        pageWaitForReady: versionKnown ? gte(version, "0.3.3") : null,
        cspFallback: versionKnown ? gte(version, "0.3.3") : null,
        fastFailContext: versionKnown ? gte(version, "0.3.6") : null,
      },
    };
  }

  // ---------- 页面求值（CDP，绕过 CSP） ----------

  async attach(tabId) {
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
   * 在页面执行 JS 并取回真实值（走 CDP Runtime.evaluate，不受页面 CSP 限制）。
   * 这是替代 page.evaluate 的默认选择：linkedin.com / github.com / chatgpt.com 都会拦 eval。
   */
  async ev(tabId, expression, { awaitPromise = false, userGesture = true, timeoutMs = 30000 } = {}) {
    // 已判定废掉的 tab 直接快速失败，不再浪费一轮网络往返
    if (this.isUnhealthy(tabId)) {
      throw new BridgeRpcError(
        "TAB_UNHEALTHY",
        `tab #${tabId} 已连续 ${this._strikes.get(tabId)} 次上下文类失败，不再重试。用 tabs.resolve 换一个 tab。`,
        "Runtime.evaluate"
      );
    }
    await this.attach(tabId);
    const r = await this.call(
      "session.send",
      { tabId, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise, userGesture } },
      timeoutMs
    );
    const details = r && r.exceptionDetails;
    if (details) {
      const ex = details.exception || {};
      throw new BridgeRpcError("EVAL_EXCEPTION", ex.description || ex.value || JSON.stringify(details), "Runtime.evaluate");
    }
    // 成功即清零：说明这个 tab 其实还能用
    this.clearStrikes(tabId);
    return unwrap(r);
  }

  /** 把「页面里算好并 JSON.stringify 的对象」安全取回。 */
  async evJson(tabId, expression, opts) {
    const out = await this.ev(tabId, `JSON.stringify((()=>{ ${expression} })())`, opts);
    if (typeof out !== "string") return out;
    try { return JSON.parse(out); } catch { return out; }
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

  // ---------- 点击：两种模式都要有 ----------

  /** 真实鼠标事件（CDP）。React 受控组件、菜单展开通常需要这个。 */
  async clickReal(tabId, x, y) {
    await this.attach(tabId);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.call(
        "session.send",
        {
          tabId,
          method: "Input.dispatchMouseEvent",
          params: { type, x: Math.round(x), y: Math.round(y), button: type === "mouseMoved" ? "none" : "left", clickCount: 1 },
        },
        10000
      );
      await sleep(120);
    }
  }

  /** DOM el.click()。某些按钮（如 LinkedIn「删除项目」）只认这个。 */
  async clickEl(tabId, expression) {
    return this.ev(
      tabId,
      `(()=>{const el=${expression}; if(!el) return {ok:false,err:'element not found'}; el.click(); return {ok:true};})()`
    );
  }

  /** 先算坐标再真实点击。selector 用 CSS；找不到返回 false 而不抛。 */
  async clickBySelector(tabId, selector) {
    const pos = await this.evJson(
      tabId,
      `const el=document.querySelector(${JSON.stringify(selector)});
       if(!el) return {ok:false};
       el.scrollIntoView({block:'center'});
       const r=el.getBoundingClientRect();
       return {ok:true, x:r.left+r.width/2, y:r.top+r.height/2};`
    );
    if (!pos || !pos.ok) return false;
    await this.clickReal(tabId, pos.x, pos.y);
    return true;
  }

  // ---------- 变更后验证 ----------

  /**
   * 在指定 url 上开工：复用/新开 tab → 等就绪 → 自检可注入 → 跑 fn。
   * 这是「不要自己挑 tab」的推荐入口：避免了选到 discarded / chrome:// / 永远 loading 的页。
   *
   * 历史教训：agent 自己从 tabs.list 里挑 tab，挑中一个 status:"loading" 的 SPA，
   * 于是在上面盲试了 155 次 PAGE_CONTEXT_TIMEOUT。这里把「选 tab + 验可用」合并成一步。
   */
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
          "withPage"
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

  /**
   * 执行变更并强制回读验证。
   * 历史教训：脚本打印 ✓ 但记录其实没删掉 —— 变更类操作不能以「点了按钮」为成功依据。
   * @param {() => Promise<any>} mutate  触发变更
   * @param {() => Promise<boolean>} verify 回读校验（应重新加载页面/列表后判断）
   */
  async mutateAndVerify(mutate, verify, { retries = 1, label = "mutation" } = {}) {
    let last;
    for (let i = 0; i <= retries; i++) {
      await mutate();
      await sleep(2000);
      last = await verify();
      if (last) return { ok: true, attempts: i + 1, label };
    }
    return { ok: false, attempts: retries + 1, label };
  }
}

export class BridgeRpcError extends Error {
  constructor(code, message, method) {
    super(`[${code}] ${message}${method ? ` (${method})` : ""}`);
    this.code = code;
    this.method = method;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等待页面 readyState 完成（优先用扩展能力，不可用则退化为轮询）。 */
export async function waitReady(rpc, tabId, timeoutMs = 30000) {
  try {
    return await rpc.call("page.waitForReady", { tabId, timeoutMs }, timeoutMs + 5000);
  } catch (e) {
    if (e.code !== "UNKNOWN_METHOD") throw e;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await rpc.ev(tabId, "document.readyState");
      if (s === "complete" || s === "interactive") return s;
      await sleep(500);
    }
    throw new Error("waitReady 超时");
  }
}

/** 打开网址的首选入口：复用「用户没在看」的同类 tab，没有才静默新开（需扩展 0.3.9+）。 */
export async function openUrl(rpc, url, opts = {}) {
  try {
    return await rpc.call("tabs.resolve", { url, ...opts }, 45000);
  } catch (e) {
    if (e.code !== "UNKNOWN_METHOD") throw e;
    // 降级：宁可多开一个后台 tab，也不要去动用户当前页
    const tab = await rpc.call("tabs.create", { url, active: false }, 30000);
    return { tabId: tab.id, tab, reused: false, navigated: true, reason: "fallback-tabs.create" };
  }
}
