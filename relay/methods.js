// RPC 方法注册表：bridge.methods 的数据源，也是 host 判定 UNKNOWN_METHOD 的依据。
// 扩展 background.js 的 switch 与 host 本地处理的方法都必须登记在这里，
// test-methods.mjs 会对照源码检查两边是否一致（漏登记 / 多登记都会红）。
// skill 文档的方法索引（skills/agent-browser-bridge/reference/rpc.md）由 gen-rpc-doc.js 从本表生成。
"use strict";

// 元素定位参数：page.click / clickReal / type / typeReal / hover / focusEl / select / press 共用
const TARGET = {
  selector: "string — CSS 选择器；也可写 `@e3` 引用快照元素",
  ref: "string — page.snapshot 返回的元素引用（如 `e3`），与 selector 二选一",
  by: "string — selector 的解释方式：css（默认）| xpath | text | aria",
};

const METHODS = {
  // ---------- 桥自身 ----------
  "bridge.methods": {
    desc: "列出全部 RPC 方法及参数说明（本表）。传 name 只看一个方法",
    params: { name: "string — 方法名，可选" },
    host: true,
  },
  help: { aliasOf: "bridge.methods" },
  "bridge.status": { desc: "扩展侧状态：版本、通道、活动标签页、被接管的 tab" },
  "bridge.ping": { desc: "连通性探测，返回 pong 时间戳", params: { t: "number — 调用方时间戳，原样返回" } },
  "bridge.connect": { desc: "让扩展连接 WS 通道（通常无需手动调用）" },
  "bridge.disconnect": { desc: "断开扩展的 WS 通道" },
  "bridge.recentErrors": {
    desc: "host 内存里最近 100 条失败请求与按错误码统计",
    params: { tabId: "number — 只看该 tab，可选", limit: "number — 返回条数，默认 20" },
    host: true,
  },
  "extension.reload": {
    desc: "扩展自重载（先回响应再重载，该次响应可能丢失，属正常）",
    params: { delayMs: "number — 延迟毫秒，默认 300" },
  },

  // ---------- 停止 / 恢复 ----------
  "agent.stop": {
    desc: "停止 Agent 写操作（只拦写，读放行）。省略 tabId 为全局停止",
    params: { tabId: "number — 只停该 tab，可选", reason: "string — 原因，可选", ttlMs: "number — 自动解除时间，可选" },
    host: true,
  },
  "agent.resume": { desc: "解除停止。省略 tabId 为解除全局", params: { tabId: "number — 可选" }, host: true },
  "agent.stopStatus": { desc: "查询停止状态", params: { tabId: "number — 可选" }, host: true },

  // ---------- 标签页 ----------
  "tabs.list": {
    desc: "列出标签页",
    params: { windowId: "number — 只看该窗口，可选", active: "boolean — 只看活动页，可选" },
  },
  "tabs.get": { desc: "读取单个标签页", params: { tabId: "number" }, required: ["tabId"] },
  "tabs.active": { desc: "当前聚焦窗口的活动标签页" },
  "tabs.resolve": {
    desc: "打开网址的首选入口：复用非活动的同类 tab，否则静默新开后台 tab（不抢用户正在看的页）",
    params: {
      url: "string",
      match: "string — host（默认）| origin | exact",
      waitLoad: "boolean — 等待加载完成，默认 true",
      reuseActive: "boolean — 允许复用活动页，默认 false",
      includePinned: "boolean — 允许复用固定 tab，默认 false",
      windowId: "number — 限定窗口，可选",
      timeoutMs: "number",
    },
    required: ["url"],
  },
  "tabs.openUrl": { aliasOf: "tabs.resolve" },
  "page.open": { aliasOf: "tabs.resolve" },
  "tabs.create": {
    desc: "无条件新开 tab（打开网址请用 tabs.resolve）",
    params: { url: "string", active: "boolean — 是否切到前台", index: "number — 位置，可选" },
  },
  "tabs.open": { aliasOf: "tabs.create" },
  "tabs.new": { aliasOf: "tabs.create" },
  "tabs.activate": { desc: "切到该 tab（会聚焦窗口；唤醒被丢弃的 tab）", params: { tabId: "number" }, required: ["tabId"] },
  "tabs.prepare": {
    desc: "保证 content script 已注入并关闭自动丢弃；渲染器被冻结时自动 CDP 解冻",
    params: { tabId: "number" },
    required: ["tabId"],
  },
  "tabs.close": { desc: "关闭 tab", params: { tabId: "number" }, required: ["tabId"] },
  "tabs.reload": {
    desc: "刷新 tab",
    params: { tabId: "number", bypassCache: "boolean", timeoutMs: "number" },
    required: ["tabId"],
  },
  "page.reload": { aliasOf: "tabs.reload" },
  "tabs.claim": {
    desc: "申请 tab 互斥租约（多 Agent 并行时用；其他 Agent 的请求会报 TAB_LEASED）",
    params: { tabId: "number", ttlMs: "number — 租约时长，默认 120000，上限 3600000" },
    required: ["tabId"],
    host: true,
  },
  "tabs.release": { desc: "释放自己持有的 tab 租约", params: { tabId: "number" }, required: ["tabId"], host: true },

  // ---------- 导航与等待 ----------
  "page.info": { desc: "tab 的 url / title / status", params: { tabId: "number" }, required: ["tabId"] },
  "page.navigate": {
    desc: "在该 tab 内跳转",
    params: { tabId: "number", url: "string", waitLoad: "boolean — 默认 true", timeoutMs: "number" },
    required: ["tabId", "url"],
  },
  "page.back": { desc: "后退", params: { tabId: "number" }, required: ["tabId"] },
  "page.forward": { desc: "前进", params: { tabId: "number" }, required: ["tabId"] },
  "page.focus": { desc: "切到该 tab 并聚焦窗口（会打断用户，慎用）", params: { tabId: "number" }, required: ["tabId"] },
  "page.ensureActive": {
    desc: "后台 tab 渲染暂停（rAF=0、懒加载不推进）时临时切为活动页，不聚焦窗口，空闲后自动归还",
    params: { tabId: "number", restoreAfterMs: "number — 空闲多久后归还，默认 20000" },
    required: ["tabId"],
  },
  "page.restoreActive": { desc: "立即归还 ensureActive 借走的活动页", params: { tabId: "number" }, required: ["tabId"] },
  "page.waitLoad": { desc: "等待 tab 加载完成", params: { tabId: "number", timeoutMs: "number" }, required: ["tabId"] },
  "page.waitForReady": {
    desc: "等待 document.readyState 为 interactive / complete",
    params: { tabId: "number", timeoutMs: "number" },
    required: ["tabId"],
  },
  "page.waitForUrl": {
    desc: "等待 URL 满足条件",
    params: {
      tabId: "number",
      match: "string — URL 包含该子串",
      equals: "string — URL 完全相等",
      timeoutMs: "number — 默认 30000",
      intervalMs: "number — 默认 300",
    },
    required: ["tabId"],
  },
  "page.waitForSelector": {
    desc: "等待元素出现",
    params: { tabId: "number", selector: "string", by: TARGET.by, timeoutMs: "number", intervalMs: "number" },
    required: ["tabId", "selector"],
  },
  "page.waitFor": {
    desc: "等待元素出现或表达式为真（content script 内轮询）",
    params: { tabId: "number", selector: "string — 与 expression 二选一", expression: "string", timeoutMs: "number — 默认 10000", intervalMs: "number — 默认 200" },
    required: ["tabId"],
  },

  // ---------- 读取 ----------
  "page.read": {
    desc: "一键读网页：打开/复用 tab → 等就绪 → 提取正文、标题、主链接与阻断诊断 → 关闭本次新建的 tab",
    params: {
      url: "string — 与 tabId 二选一",
      tabId: "number — 读已有 tab；同时传 url 则先跳转",
      match: "string — tabs.resolve 的匹配方式",
      maxLength: "number — 正文最大字符数，默认 20000",
      includeLinks: "boolean — 默认 true",
      maxLinks: "number — 默认 30",
      keepOpen: "boolean — 保留新建的 tab，默认 false",
      waitMs: "number — 就绪后额外等待，上限 10000",
      timeoutMs: "number — 默认 45000",
    },
  },
  "page.snapshot": {
    desc: "页面快照。compact 模式输出 `[e1] button \"搜索\"` 形式的元素清单，元素编号可直接用于 click/type",
    params: {
      tabId: "number",
      mode: "string — compact（推荐）| elements | a11y | text | full",
      includeText: "boolean — 附带正文",
      maxElements: "number — compact 最多元素数，默认 200",
      maxDepth: "number — a11y 深度",
      maxNodes: "number — a11y 节点上限",
    },
    required: ["tabId"],
  },
  "page.inspect": {
    desc: "只读探查：overview（阻断诊断 blocker、弹窗、可滚动容器）| links | media | scroll | modal | sel",
    params: { tabId: "number", focus: "string — 默认 overview", selector: "string — focus=sel 时必填", limit: "number", world: "string — MAIN | ISOLATED" },
    required: ["tabId"],
  },
  "page.evaluate": {
    desc: "在页面执行 JS 表达式并取回值（MAIN world；遇 CSP 拦截自动改走 CDP）",
    params: { tabId: "number", expression: "string", awaitPromise: "boolean", world: "string — MAIN（默认）| ISOLATED" },
    required: ["tabId", "expression"],
  },
  "page.evalCdp": {
    desc: "经 CDP Runtime.evaluate 单次求值，不受页面 CSP / Trusted Types 限制，用完立即归还调试器",
    params: { tabId: "number", expression: "string", awaitPromise: "boolean", userGesture: "boolean", timeoutMs: "number" },
    required: ["tabId", "expression"],
  },
  "page.screenshot": {
    desc: "静默截图，返回 base64 dataURL",
    params: {
      tabId: "number",
      format: "string — png（默认）| jpeg",
      quality: "number — jpeg 质量，默认 90",
      captureBeyondViewport: "boolean — 整页截图",
      allowActivate: "boolean — CDP 截图失败时允许切前台再截",
    },
    required: ["tabId"],
  },
  "page.activateAndShot": { desc: "切前台后截可见区域（会打断用户）", params: { tabId: "number" }, required: ["tabId"] },
  "page.record.start": { desc: "开始记录会话时间线（导航/弹窗/报错/DOM/console）", params: { tabId: "number" }, required: ["tabId"] },
  "page.record.stop": { desc: "停止记录", params: { tabId: "number" }, required: ["tabId"] },
  "page.record.status": { desc: "记录状态", params: { tabId: "number" }, required: ["tabId"] },
  "page.record.get": {
    desc: "读取时间线",
    params: { tabId: "number", since: "number — 时间戳", types: "string[] — nav | modal | err | dom | console", limit: "number" },
    required: ["tabId"],
  },
  "page.record.clear": { desc: "清空时间线", params: { tabId: "number" }, required: ["tabId"] },

  // ---------- 交互（返回值带 delta：urlChanged / modalOpened / mutationCount 等） ----------
  "page.click": { desc: "DOM 原生 el.click()", params: { tabId: "number", ...TARGET }, required: ["tabId"] },
  "page.clickReal": {
    desc: "CDP 真实鼠标点击（React/Vue 等只认真实事件的组件）。传元素时自动滚动居中算坐标",
    params: {
      tabId: "number",
      ...TARGET,
      x: "number — 视口坐标，与元素二选一",
      y: "number",
      button: "string — left（默认）| right | middle",
      clickCount: "number — 默认 1",
      delayMs: "number — 按下/松开间隔，默认 50",
    },
    required: ["tabId"],
  },
  "page.type": {
    desc: "DOM 方式输入（设置 value 并派发 input 事件）",
    params: { tabId: "number", ...TARGET, text: "string", clear: "boolean — 先清空，默认 true" },
    required: ["tabId", "text"],
  },
  "page.typeReal": {
    desc: "CDP 受控输入：聚焦 → 清空 → Input.insertText → 回读校验（verified）",
    params: { tabId: "number", ...TARGET, text: "string", clear: "boolean — 默认 true", pressEnter: "boolean — 输入后回车" },
    required: ["tabId", "text"],
  },
  "page.press": {
    desc: "派发按键（Enter / Escape / Tab / ArrowDown …），可带 ctrl/meta/alt/shift",
    params: { tabId: "number", key: "string", ...TARGET, ctrl: "boolean", meta: "boolean", alt: "boolean", shift: "boolean" },
    required: ["tabId", "key"],
  },
  "page.select": {
    desc: "设置 <select> 的选项",
    params: { tabId: "number", ...TARGET, value: "string", values: "string[]", label: "string", labels: "string[]" },
    required: ["tabId"],
  },
  "page.hover": { desc: "派发悬停事件", params: { tabId: "number", ...TARGET }, required: ["tabId"] },
  "page.focusEl": { desc: "聚焦元素", params: { tabId: "number", ...TARGET }, required: ["tabId"] },
  "page.scroll": {
    desc: "滚动。checked=true 时回读是否推进，未推进报 SCROLL_NO_GROWTH / SCROLL_STALLED（details.recoverable）",
    params: {
      tabId: "number",
      direction: "string — up | down | left | right",
      amount: "number — 像素，默认 0.8 屏",
      selector: "string — 滚动到该元素",
      x: "number",
      y: "number",
      checked: "boolean — 回读推进检测",
      expectGrowth: "boolean — checked 时要求页面变高（懒加载）",
      allowNoProgress: "boolean — checked 时到底不报错",
    },
    required: ["tabId"],
  },
  "page.uploadFile": {
    desc: "给 <input type=file> 注入本地文件（绝对路径）",
    params: { tabId: "number", selector: "string — 默认 input[type=\"file\"]", files: "string[]" },
    required: ["tabId", "files"],
  },

  // ---------- 视觉指示器 ----------
  "page.indicator.move": { desc: "移动虚拟光标", params: { tabId: "number", x: "number", y: "number", instant: "boolean" }, required: ["tabId"] },
  "page.indicator.click": { desc: "虚拟光标点击动画", params: { tabId: "number", x: "number", y: "number" }, required: ["tabId"] },
  "page.indicator.highlight": { desc: "高亮元素", params: { tabId: "number", selector: "string" }, required: ["tabId"] },
  "page.indicator.hide": { desc: "隐藏虚拟光标", params: { tabId: "number" }, required: ["tabId"] },
  "page.indicator.stop": { desc: "显示/隐藏「停止 Agent」按钮", params: { tabId: "number", show: "boolean", label: "string" }, required: ["tabId"] },
  "page.indicator.hideAll": { desc: "隐藏所有 tab 的指示器" },

  // ---------- CDP 直通 ----------
  "session.attach": { desc: "附加调试器（幂等）。用完必须 session.detach", params: { tabId: "number" }, required: ["tabId"] },
  "session.detach": { desc: "解除调试器", params: { tabId: "number" }, required: ["tabId"] },
  "session.send": {
    desc: "发送任意 CDP 命令（Firefox 只支持子集，其余报 CDP_UNSUPPORTED）",
    params: { tabId: "number", method: "string — 如 Emulation.setDeviceMetricsOverride", params: "object" },
    required: ["tabId", "method"],
  },
};

function resolveMethod(name) {
  const m = METHODS[name];
  if (!m) return null;
  if (m.aliasOf) return { name, ...METHODS[m.aliasOf], aliasOf: m.aliasOf };
  return { name, ...m };
}

function listMethods() {
  return Object.keys(METHODS).map(resolveMethod);
}

// 编辑距离：UNKNOWN_METHOD 时给出最接近的方法名（Agent 常见误写：page.eval / tabs.openTab / page.getText）
function distance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function suggestMethods(name, limit = 3) {
  const lower = String(name || "").toLowerCase();
  const tail = lower.split(".").pop();
  return Object.keys(METHODS)
    .map((k) => {
      const kl = k.toLowerCase();
      // 方法名尾段包含关系（page.eval → page.evaluate / page.evalCdp）优先于纯编辑距离
      const contains = tail && kl.split(".").pop().includes(tail) ? -2 : 0;
      return { k, score: distance(lower, kl) + contains };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((x) => x.k);
}

module.exports = { METHODS, resolveMethod, listMethods, suggestMethods };
