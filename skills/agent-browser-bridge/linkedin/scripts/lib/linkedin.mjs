// LinkedIn 档案编辑公共层。
//
// 存在的理由：LinkedIn 是「严格 CSP + SDUI 懒渲染 + 表单全是 React 受控组件
// + 富文本 TipTap 编辑器 + URL 无统一规律」五重叠加的站点，每个操作脚本都要重复
// 同一套样板（CDP 求值、激活标签页、等表单、按 aria-label 找字段、受控赋值、
// 两种点击语义、等保存生效、回读验证）。这些样板各写一遍必然写错，
// 且错法很难定位——因为**每个坑的现象都指向错误的方向**：
//   - 用 page.evaluate → 被 CSP 拦（EVAL_ERROR），错误信息指向 CSP，与真实意图无关
//   - 后台标签页 → SDUI 懒渲染不触发，条目读出 0 条，看着像「这个人没填」
//   - 用 querySelector('#r0') 定位字段 → React 每次渲染换 id，选择器时灵时不灵
//   - 直接 el.value = x → React 受控组件不认，值写进去又被打回，保存后是空的
//   - 富文本赋 innerText → ProseMirror 静默忽略，表现为「找到了但写不进去」
//   - 点完「保存」就认为成功 → 实际可能弹了校验错误，或根本没提交
// 本文件把这些一次性收敛掉。所有函数都只依赖 agent-browser-bridge 根 skill 的 RPC。
//
// 自包含：只 import 同仓库 skill 内的 ../scripts/lib/bridge.mjs，不依赖仓库根的 agent/。
//
// 回归测试（不碰浏览器）：relay/test-linkedin-expr.mjs —— 用 mock rpc 抓出真正会发给
// 页面的表达式，用解析器逐个验证语法。模板字符串里写转义符（\\n / \\d）会把生成的 JS
// 静默搞坏，这类错误用解析器断言能在毫秒内定位。

import { Rpc, BridgeRpcError, sleep } from "../../../scripts/lib/bridge.mjs";

export { Rpc, BridgeRpcError, sleep };

/** 换行符。
 * 为什么要有这个常量：不能在模板字符串里直接写 split('\n') —— 模板字符串会把 \n
 * 变成**真实换行**，生成的 JS 表达式当场断成两行、语法错误（本仓库踩过同类坑）。
 * 用 JSON.stringify(NL) 注入则生成的是合法字符串字面量，没有转义层。
 */
const NL = "\n";

/** 档案 URL 由调用方传入（形如 https://www.linkedin.com/in/<slug>），本库不硬编码任何人的档案。 */
export function normalizeSlug(input) {
  // 顺序要紧：先去掉查询串，再去尾部斜杠。反过来的话，
  // `.../abc/?x=1` 尾字符是 `1`、没有斜杠可去，去掉查询串后就留下了 `.../abc/`，
  // 与 `.../abc` 两种输入得到不同结果（调用方随后又拼 "/" 会拼出双斜杠）。
  let s = String(input || "").trim().split("?")[0].replace(/\/+$/, "");
  if (!/^https?:\/\//.test(s)) s = "https://www.linkedin.com/in/" + s.replace(/^\/?(in\/)?/, "");
  return s;
}

/**
 * 语言档案的 URL 后缀。
 * LinkedIn 的语言档案**靠 URL 参数切换**，不是页面内 tab（页面里那对
 * "Chinese (Simplified) (主档案) | English" 链接本身就是带参 URL）。
 * 不带参数 = 主档案（primary），带 = 该语言档案。
 *
 * 注意：返回的是**待合并的参数串**（不带 `?`）。拼接必须用 `withQuery()`——
 * 因为表单路径本身就带查询串（如 About 的 `?profileFormEntryPoint=GUIDANCE_CARD`），
 * 直接再拼一个 `?language=en` 会拼出**双问号**的非法 URL。
 * 实测后果很隐蔽：LinkedIn 会把 `?language=en` 当成前一个参数值的一部分
 * （变成 `...GUIDANCE_CARD%3Flanguage%3Den`），于是**静默回退到主档案内容**——
 * 你以为是英文档案，读到的是中文，而且不报任何错。
 *
 * 正确的英文档案 URL（实测，注意是 `&`）：
 *   .../edit/forms/summary/new/?language=en&country=US&profileFormEntryPoint=GUIDANCE_CARD
 */
export function langParams(lang) {
  if (!lang || lang === "primary" || lang === "zh") return "";
  if (lang === "en") return "language=en&country=US";
  return `language=${lang}`;
}

/** 把路径与查询参数安全合并（自动处理已存在的 `?`）。 */
export function withQuery(pathOrUrl, params) {
  if (!params) return pathOrUrl;
  return pathOrUrl + (pathOrUrl.includes("?") ? "&" : "?") + params;
}

/**
 * 兼容旧名：返回带 `?` 的后缀。
 * @deprecated 用 `langParams()` + `withQuery()`：本函数无法处理「路径自带查询串」的情况，
 * 拼出双问号会让语言参数静默失效（见 langParams 注释）。保留仅为不破坏已有调用方。
 */
export function langSuffix(lang) {
  const p = langParams(lang);
  return p ? "?" + p : "";
}

// ───────────────────────── 求值（绕过 CSP） ─────────────────────────

/**
 * 在页面执行 JS。走 CDP Runtime.evaluate，不受页面 CSP 限制。
 *
 * 为什么必须用它：linkedin.com 的 CSP 无 'unsafe-eval'，`page.evaluate` 注入的
 * eval(expression) 直接抛 EvalError（实测 code=EVAL_ERROR）。扩展 v0.3.3 起
 * page.evaluate 内部会自动兜底到 CDP，但**不要依赖这个兜底**：
 * 显式走 CDP 路径更快，且在 v0.3.12 之前，兜底路径会拆掉 Agent 自己的调试会话
 * （表现为下一次 ev() 报 SESSION_SEND_FAILED「Debugger is not attached」；
 * 现已在扩展侧收敛为 withBorrowedDebugger，谁借的谁还）。
 *
 * @param {Rpc} rpc
 * @param {number} tabId
 * @param {string} expr  JS 表达式（可以是 IIFE；返回对象会被自动 JSON 化）
 */
export async function ev(rpc, tabId, expr, opts = {}) {
  return rpc.ev(tabId, expr, opts);
}

/** 求值并解析 JSON（页面里返回 JSON.stringify 的场景）。解析失败时原样返回。 */
export async function evJson(rpc, tabId, expr, opts = {}) {
  const v = await rpc.ev(tabId, expr, opts);
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

// ───────────────────────── 导航与等就绪 ─────────────────────────

/**
 * 跳到档案下的某个路径，并等到表单/内容真的渲染出来。
 *
 * LinkedIn 是 SPA：page.navigate 返回 ≠ DOM 就绪。固定 sleep 要么不够（表单还没出）
 * 要么浪费（每次多等几秒）。这里轮询「目标选择器出现」或「页面文本出现特征词」。
 *
 * **重要：后台标签页拿不到内容**（实测）。LinkedIn 的档案页是 SDUI（server-driven UI）
 * 懒渲染，而懒渲染靠 rAF/可见性——Chrome 对后台 tab **完全暂停** rAF，于是条目永远不渲染，
 * 表现为「页面打开了、正文有导航与页脚、就是没有条目」，很容易误判成「选择器写错」
 * 或「这个人没有这段经历」。所以这里默认先 `page.ensureActive` 把标签页切到前台
 * （只切标签页、不聚焦窗口，不打扰用户），等渲染完再让桥自动归还。
 *
 * @param {object} o
 * @param {string} o.slug   档案 URL
 * @param {string} o.path   档案下的路径，如 "/edit/forms/summary/new/"
 * @param {string} [o.lang] 语言档案（"en" / "primary"）
 * @param {string} [o.expectText] 等到正文含该文本才返回（用于区分 404 与正常页）
 * @param {boolean} [o.activate=true] 是否先激活标签页保证渲染（后台 tab 必须）
 * @param {number} [o.timeoutMs]
 */
export async function gotoForm(rpc, tabId, { slug, path, lang, expectText, activate = true, timeoutMs = 45000 }) {
  // 用 withQuery 合并语言参数：表单路径自带查询串（About 有 profileFormEntryPoint），
  // 直接拼 langSuffix 会出双问号、语言参数静默失效（见 langParams 注释）
  const url = withQuery(normalizeSlug(slug) + path, langParams(lang));
  // 先激活再导航：LinkedIn 的 SDUI 在后台标签页不渲染（见上方注释）。
  // 失败不阻断——某些情况下（如已在前台）本就不需要。
  if (activate) {
    try { await rpc.call("page.ensureActive", { tabId, restoreAfterMs: 60000 }, 15000); }
    catch (e) { /* 能力不可用（旧版扩展）时不阻断，继续走原路径 */ }
  }
  await rpc.call("page.navigate", { tabId, url }, timeoutMs);

  const deadline = Date.now() + timeoutMs;
  let last = null;
  let sawDialog = false;
  while (Date.now() < deadline) {
    await sleep(400);
    try {
      last = await evJson(rpc, tabId, `(() => {
        const t = document.body ? (document.body.innerText || "") : "";
        const dlg = document.querySelector('dialog');
        // LinkedIn 的表单是懒加载的：dialog 出现后内容区先是一个 data-testid="loader"，
        // 之后才换成真实表单。只看「dialog 存在」会拿到空表单，写字段必然找不到元素。
        const loader = !!(dlg && dlg.querySelector('[data-testid="loader"], [role="progressbar"]'));
        return {
          ready: document.readyState,
          dialog: document.querySelectorAll('dialog').length,
          loader: loader,
          notFound: /此页面不存在|Page not found|页面不存在/.test(t),
          len: t.length,
        };
      })()`);
    } catch (e) {
      last = { err: e.code };
      continue;
    }
    if (last && last.notFound) break;                          // 明确 404，交给调用方判断
    if (last && last.dialog > 0) {
      sawDialog = true;
      // 有表单且不再处于 loader 状态才算真的就绪
      if (!last.loader) break;
    }
    if (last && !sawDialog && expectText) {
      const hit = await ev(rpc, tabId, `(document.body.innerText||"").includes(${JSON.stringify(expectText)})`).catch(() => false);
      if (hit) break;
    }
  }
  // 表单就绪后再给 React 一点挂载时间（字段是异步渲染的）
  if (sawDialog && last && !last.loader) await sleep(600);
  return { url, ...(last || {}) };
}

/** 等对话框出现（表单/确认框），返回它是否出现。 */
export async function waitDialog(rpc, tabId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await ev(rpc, tabId, "document.querySelectorAll('dialog').length").catch(() => 0);
    if (n > 0) return true;
    await sleep(300);
  }
  return false;
}

// ───────────────────────── 表单字段定位 ─────────────────────────

/**
 * 在表单作用域内按「可见标签文本」或 aria-label 找字段。
 *
 * 为什么不按 id：LinkedIn 的字段 id 是 React 生成的（实测形如 `«r0»`、`«Rmscom59j6»`），
 * 每次渲染都可能变，写死 id 的选择器不可靠。而 aria-label / label 文本是稳定的。
 *
 * 为什么不按 name：实测多数字段 **没有 name 属性**（只有少数有），按 name 找会全军覆没。
 *
 * 富文本字段（TipTap/ProseMirror）的 aria-label 在**外层 DIV** 上，真正可写的
 * 是它里面的 `.ProseMirror[contenteditable=true]`——所以命中外层时要下钻一层，
 * 否则赋值到不可编辑的外层上，表现为「找到了但写不进去」。
 *
 * @param {string} labelText 标签文本，支持部分匹配（如 "项目名称"、"描述"、"职位头衔"）
 * @returns {string} 可直接求值的 JS 表达式（返回可写元素或 null）
 */
export function fieldExpr(labelText) {
  return `(function(){
    var want = ${JSON.stringify(labelText)};
    var d = document.querySelector('dialog') || document;
    var els = [].slice.call(d.querySelectorAll('input,textarea,[contenteditable=true]'));
    var hit = els.find(function(e){
      if (e.type === 'hidden') return false;
      var al = e.getAttribute('aria-label') || '';
      if (al.indexOf(want) >= 0) return true;
      // label 元素文本（LinkedIn 用 <label for=...> 或包裹式 label）
      if (e.labels && e.labels.length) {
        for (var i=0;i<e.labels.length;i++) if ((e.labels[i].innerText||'').indexOf(want) >= 0) return true;
      }
      // 相邻文本节点兜底：字段前面的兄弟元素文本
      var p = e.closest('label') || e.parentElement;
      if (p && (p.innerText||'').indexOf(want) >= 0) return true;
      return false;
    });
    if (!hit) return null;
    // 命中外层富文本壳时下钻到真正可写的 ProseMirror 元素
    if (!hit.isContentEditable && hit.getAttribute('contenteditable') !== 'true') {
      var inner = hit.querySelector('.ProseMirror[contenteditable=true]') || hit.querySelector('[contenteditable=true]');
      if (inner) return inner;
    }
    // aria-label 在外层 DIV、可写元素是子节点的情况
    var wrap = hit.closest('[data-testid="ui-core-tiptap-text-editor-wrapper"]');
    if (wrap) {
      var pm = wrap.querySelector('.ProseMirror[contenteditable=true]');
      if (pm) return pm;
    }
    return hit;
  })()`;
}

/**
 * Headline（个人简介标题）字段的定位表达式。
 *
 * 为什么单独一个函数：Intro 表单里的 Headline 是一个 **TipTap/ProseMirror 编辑器，
 * 但它没有 aria-label、也没有 label 元素**（实测：整个 dialog 里唯一的
 * `[contenteditable=true]` 就是它）。所以通用的 `fieldExpr("关于")` 那种按文本找的办法
 * 在这里失效——传任何词都找不到。只能按「dialog 里第一个 contenteditable」定位。
 *
 * 同理，这个字段用 `innerHTML` + `InputEvent` 能写进去（实测有效），
 * 但若页面改版导致失效，退回真实键盘输入（CDP `Input.insertText`）：先真实鼠标点进编辑器
 * 取得焦点，再全选 + `insertText`。两种方式都实测过。
 */
export function headlineExpr() {
  return `(document.querySelector('dialog') || document).querySelector('[contenteditable=true]')`;
}

/**
 * 写 Headline（含「没 aria-label」的兑底路径）。
 *
 * 优先用 `innerHTML` + `InputEvent`（快、不需焦点）；回读发现没写进去时，
 * 退化为真实鼠标点击 + CDP `Input.insertText`（实测这条路也能成功）。
 * 两条路都失败则报 `headline-write-failed`，由调用方决定是否报错。
 */
export async function fillHeadline(rpc, tabId, value) {
  const out = await evJson(rpc, tabId, `(() => {
    var el = ${headlineExpr()};
    if (!el) return { ok: false, reason: 'headline-field-not-found' };
    var before = String(el.innerText || '');
    el.focus();
    var html = String(${JSON.stringify(value)}).split(${JSON.stringify(NL)}).map(function(line){
      return '<p>' + (line === '' ? '<br>' : line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')) + '</p>';
    }).join('');
    el.innerHTML = html;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    return { ok: true, before: before.slice(0, 80), after: String(el.innerText || '').slice(0, 80), len: String(el.innerText || '').length };
  })()`);
  if (out && out.ok && out.len > 0) return { ...out, method: "innerHTML" };

  // 兑底：真实鼠标点进编辑器 → 全选 → CDP insertText
  const box = await evJson(rpc, tabId, `(() => {
    var el = ${headlineExpr()};
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  })()`).catch(() => null);
  if (box) {
    await rpc.clickReal(tabId, box.x, box.y);
    await sleep(400);
    const keys = [
      { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4 },
      { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4 },
    ];
    // session.send 经 rpc 会自动 attach 并持有到进程退出；withSession 让会话在这一步结束时就释放
    await rpc.withSession(tabId, async () => {
      for (const k of keys) await rpc.call("session.send", { tabId, method: "Input.dispatchKeyEvent", params: k }, 10000);
      await sleep(300);
      await rpc.call("session.send", { tabId, method: "Input.insertText", params: { text: String(value) } }, 10000);
    });
    await sleep(1000);
    const after = await ev(rpc, tabId, `(() => { var el=${headlineExpr()}; return el ? String(el.innerText||'').length : -1; })()`);
    if (after > 0) return { ok: true, method: "insertText", len: after };
  }
  return { ok: false, reason: "headline-write-failed", tried: ["innerHTML", "insertText"] };
}

/** dump 当前表单里所有字段（调试用：不确定标签文本时先看这个）。 */
export async function dumpFields(rpc, tabId) {
  return evJson(rpc, tabId, `(() => {
    var d = document.querySelector('dialog') || document;
    return [].slice.call(d.querySelectorAll('input,textarea,[contenteditable=true]')).map(function(e){
      return {
        tag: e.tagName,
        id: e.id || null,
        name: e.name || null,
        aria: e.getAttribute('aria-label') || null,
        label: (e.labels && e.labels[0] && e.labels[0].innerText || '').slice(0,40) || null,
        placeholder: e.placeholder || null,
        value: String(e.value === undefined ? '' : e.value).slice(0,60),
        type: e.type || null,
      };
    });
  })()`);
}

/**
 * 往受控输入框写值。
 *
 * 关键：LinkedIn 的表单是 React 受控组件。直接 `el.value = x` 只改 DOM，
 * React 的 state 没变——提交时值被 state 覆盖回空。必须用原型上的原生 setter
 * 绕开 React 的 value 拦截器，再派发 input/change 事件让 React 同步 state。
 *
 * 富文本字段（About 简介、项目描述等）不是 input/textarea，而是
 * **TipTap / ProseMirror 编辑器**（`.tiptap.ProseMirror[contenteditable=true]`，
 * 外包 `[data-testid="ui-core-tiptap-text-editor-wrapper"]`）。这类字段必须写
 * `innerHTML` 并派发 InputEvent —— 实测赋 `innerText` 会被 ProseMirror 忽略。
 *
 * @returns {{ok:boolean, reason?:string, before?:string, after?:string, kind?:string}}
 */
export async function fillField(rpc, tabId, labelText, value) {
  const out = await evJson(rpc, tabId, `(() => {
    var el = ${fieldExpr(labelText)};
    if (!el) return { ok: false, reason: 'field-not-found' };
    var v = ${JSON.stringify(value)};

    // 富文本（TipTap/ProseMirror）：用 innerHTML + InputEvent
    if (el.isContentEditable || (el.getAttribute('contenteditable') === 'true')) {
      var before = String(el.innerText || '');
      el.focus();
      // 纯文本也要包成段落：ProseMirror 靠 <p> 维持文档结构，
      // 直接写裸文本会被它归一化掉（换行全丢）。
      var html = String(v).split(${JSON.stringify(NL)}).map(function(line){
        return '<p>' + (line === '' ? '<br>' : line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')) + '</p>';
      }).join('');
      el.innerHTML = html;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      return { ok: true, kind: 'richtext', before: before.slice(0,60), after: String(el.innerText||'').slice(0,60) };
    }

    var before2 = String(el.value === undefined ? '' : el.value);
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
              : el.tagName === 'INPUT'    ? window.HTMLInputElement.prototype
              : null;
    var setter = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) {
      setter.set.call(el, v);                       // 绕开 React 的 value 拦截器
    } else {
      el.value = v;
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, kind: 'input', before: before2.slice(0,60), after: String(el.value === undefined ? '' : el.value).slice(0,60) };
  })()`);
  // 回读验证：写完必须确认值真的进去了，不能以「脚本没报错」为成功依据
  if (out && out.ok && !out.after) {
    return { ...out, ok: false, reason: "value-empty-after-write" };
  }
  return out || { ok: false, reason: "no-result" };
}

/** 读字段当前值（回读验证用）。 */
export async function readField(rpc, tabId, labelText) {
  return ev(rpc, tabId, `(() => {
    var el = ${fieldExpr(labelText)};
    return el ? String(el.value === undefined ? el.innerText : el.value) : null;
  })()`);
}

// ───────────────────────── 点击 ─────────────────────────

/**
 * 用真实鼠标事件点击（CDP Input.dispatchMouseEvent）。
 *
 * 为什么需要两种点击：LinkedIn 有些按钮只认 `el.click()`（合成事件），
 * 有些只认真实鼠标事件（如确认删除框里的「删除」）。两者不等价，实测过。
 * 这个函数走真实鼠标路径；`clickEl` 走 el.click() 路径。
 */
export async function clickReal(rpc, tabId, selector) {
  const box = await evJson(rpc, tabId, `(() => {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  if (!box || !box.x) return { ok: false, reason: "not-found-or-invisible" };
  const r = await rpc.clickReal(tabId, box.x, box.y);
  return { ok: true, delta: r.delta };
}

/** 用 el.click() 点击（合成事件）。某些 LinkedIn 按钮只认这条路径。 */
export async function clickEl(rpc, tabId, selector) {
  return evJson(rpc, tabId, `(() => {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'not-found' };
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { ok: false, reason: 'invisible' };
    el.click();
    return { ok: true };
  })()`);
}

/**
 * 按按钮文本点击，**限定在指定作用域内**。
 *
 * 为什么必须限定：LinkedIn 表单底部和确认弹窗里常有同名按钮（如都有「删除」），
 * 全局找会点到错误的那个。默认作用域是「最后一个打开的 dialog」。
 */
export async function clickButtonByText(rpc, tabId, text, { scope = "lastDialog", useRealMouse = false } = {}) {
  const scopeExpr = scope === "lastDialog"
    ? `(function(){ var ds=[].slice.call(document.querySelectorAll('dialog')).filter(function(d){return d.open;}); return ds.length ? ds[ds.length-1] : (document.querySelector('dialog') || document); })()`
    : scope === "form"
    ? `(document.querySelector('dialog') || document)`
    : `document`;
  const found = await evJson(rpc, tabId, `(() => {
    var s = ${scopeExpr};
    var want = ${JSON.stringify(text)};
    var el = [].slice.call(s.querySelectorAll('button,[role=button],a')).find(function(b){
      if ((b.innerText||'').trim() !== want) return false;
      var r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!el) return null;
    el.setAttribute('data-bridge-target', '1');
    return { ok: true, tag: el.tagName };
  })()`);
  if (!found || !found.ok) return { ok: false, reason: "button-not-found", text };
  const sel = '[data-bridge-target="1"]';
  const r = useRealMouse ? await clickReal(rpc, tabId, sel) : await clickEl(rpc, tabId, sel);
  await ev(rpc, tabId, `(() => { var e=document.querySelector('[data-bridge-target="1"]'); if(e) e.removeAttribute('data-bridge-target'); return 1; })()`).catch(() => {});
  return r;
}

// ───────────────────────── 保存与回读验证 ─────────────────────────

/**
 * 点「保存」并确认真的生效。
 *
 * 不以「点了按钮」为成功依据（这是本仓库反复强调的约束零）：LinkedIn 保存失败时
 * 可能弹校验错误、也可能静默无反应，脚本却打印了 ✓。这里做三重验证：
 *   1. 表单弹窗是否关闭（保存成功会关）
 *   2. 是否出现错误提示（校验失败）
 *   3. 调用方传入的 verify() 回读校验
 */
/**
 * 点「保存」并确认真的生效。
 *
 * 不以「点了按钮」为成功依据（这是本仓库反复强调的约束零）：LinkedIn 保存失败时
 * 可能弹校验错误、也可能静默无反应，脚本却打印了 ✓。这里做三重验证：
 *   1. 出现成功提示（或表单弹窗关闭）
 *   2. 没出现错误提示（校验失败）
 *   3. 调用方传入的 verify() 回读校验
 *
 * **成功文案是「已成功保存。」**（实测）。不要写成 `保存成功` —— 字序不同，
 * 会导致把成功误判成校验错误（本函数第一版就这么错过：成功 toast 被当 errors 返回，
 * 报 `validation-error`，而实际已经保存了）。所以判定用宽松的「包含 保存 且不含失败词」。
 */
export async function saveAndVerify(rpc, tabId, { verify, timeoutMs = 25000 } = {}) {
  const clicked = await clickButtonByText(rpc, tabId, "保存", { scope: "form" });
  if (!clicked.ok) {
    // 英文界面或按钮文案不同时的兜底
    const alt = await clickButtonByText(rpc, tabId, "Save", { scope: "form" });
    if (!alt.ok) return { ok: false, reason: "save-button-not-found" };
  }

  // 成功提示的判据：含「保存」/「saved」且不含否定词。
  // 覆盖实测文案：「已成功保存。」「保存成功。」「Saved」
  const isSuccessText = (t) => /保存|saved/i.test(t) && !/失败|错误|无法|不能|error|fail/i.test(t);

  const deadline = Date.now() + timeoutMs;
  let dialogClosed = false;
  let errors = [];
  let toast = null;
  let sawSuccess = false;
  while (Date.now() < deadline) {
    await sleep(500);
    const s = await evJson(rpc, tabId, `(() => {
      var ds = [].slice.call(document.querySelectorAll('dialog')).filter(function(d){return d.open;});
      // 成功信号：LinkedIn 会弹 toast（.artdeco-toast-item / role=alert），实测文案「已成功保存。」
      var toasts = [].slice.call(document.querySelectorAll('[role=alert],.artdeco-toast-item'))
        .map(function(e){ return (e.innerText||'').trim(); }).filter(Boolean);
      return { openDialogs: ds.length, toasts: toasts.slice(0,3) };
    })()`).catch(() => null);
    if (!s) continue;
    if (s.toasts && s.toasts.length) toast = s.toasts;
    const bad = (s.toasts || []).filter(function(t){ return !isSuccessText(t); });
    if ((s.toasts || []).some(isSuccessText)) sawSuccess = true;
    // 保存成功有两种表现：弹成功提示，或表单弹窗直接关掉。任一成立即算成功。
    if (s.openDialogs === 0) { dialogClosed = true; errors = bad; break; }
    if (sawSuccess) break;
    if (bad.length) { errors = bad; break; }
  }

  let verified = null;
  if (typeof verify === "function") {
    try { verified = await verify(); } catch (e) { verified = { ok: false, reason: e.code || e.message }; }
  }

  if (errors && errors.length) return { ok: false, reason: "validation-error", errors, dialogClosed, toast, verified };
  // 既没成功提示、弹窗也没关 → 真的没生效
  if (!dialogClosed && !sawSuccess) return { ok: false, reason: "dialog-still-open", dialogClosed, toast, verified };
  if (verified && verified.ok === false) return { ok: false, reason: "verify-failed", dialogClosed, toast, verified };
  return { ok: true, dialogClosed, toast, verified };
}

/**
 * 删除条目：打开编辑表单 → 点删除 → 在确认框里再点删除 → 回读验证。
 *
 * 两个实测坑（都在这里收敛）：
 *   1. 表单底部和确认框里都有「删除」按钮 → 必须按 dialog 作用域区分
 *   2. 确认框的取消按钮文案是「不，谢谢」，不是「取消」；确认框文本形如
 *      「删除项目 删除<名称>？此操作不可撤消。」——用它作为「确实是确认框」的判据，
 *      不要只靠 dialog 数量（表单本身也是一个 dialog）
 */
export async function deleteEntry(rpc, tabId, { slug, editPath, confirmPattern, deleteButtonText = "删除", expectGone, timeoutMs = 30000 }) {
  if (!slug) return { ok: false, reason: "slug-required" };
  await gotoForm(rpc, tabId, { slug, path: editPath, timeoutMs });
  if (!(await waitDialog(rpc, tabId, 15000))) return { ok: false, reason: "form-not-open" };

  // 第一步：表单里的删除按钮（限定在 form dialog 内）
  // 实测：LinkedIn 的「删除项目」只认 el.click()（合成事件），真实鼠标事件无效
  const first = await clickButtonByText(rpc, tabId, deleteButtonText, { scope: "form" });
  if (!first.ok) return { ok: false, reason: "delete-button-not-found", text: deleteButtonText };
  await sleep(1500);

  // 第二步：确认框（用文本特征识别，而不是「第 2 个 dialog」）
  // 实测确认框文案：「删除项目 删除<名称>？此操作不可撤消。」，按钮是「不，谢谢」/「删除」
  const found = await evJson(rpc, tabId, `(() => {
    var pat = new RegExp(${JSON.stringify(confirmPattern || "删除")});
    var ds = [].slice.call(document.querySelectorAll('dialog')).filter(function(d){ return d.open && pat.test(d.innerText||''); });
    if (!ds.length) return { ok: false, reason: 'confirm-dialog-not-found' };
    var d = ds[ds.length-1];
    var btn = [].slice.call(d.querySelectorAll('button')).find(function(b){
      var t = (b.innerText||'').trim();
      return (t === '删除' || t === 'Delete') && b.getBoundingClientRect().width > 0;
    });
    if (!btn) return { ok: false, reason: 'confirm-button-not-found', buttons: [].slice.call(d.querySelectorAll('button')).map(function(b){return (b.innerText||'').trim();}) };
    btn.setAttribute('data-bridge-confirm', '1');
    return { ok: true };
  })()`);
  if (!found || !found.ok) return { ok: false, reason: found && found.reason, buttons: found && found.buttons };

  // 确认框里的「删除」必须用真实鼠标事件（el.click() 无效，实测）——
  // 与第一步正好相反，所以两种点击方式都要留着。
  await clickReal(rpc, tabId, '[data-bridge-confirm="1"]');
  await sleep(4000);

  let gone = null;
  if (typeof expectGone === "function") {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      gone = await expectGone().catch(() => null);
      if (gone && gone.ok) break;
      await sleep(1200);
    }
  }
  if (gone && gone.ok === false) return { ok: false, reason: "still-present-after-delete", gone };
  return { ok: true, gone };
}

// ───────────────────────── 读档案（只读，安全） ─────────────────────────

/**
 * 读某个档案页面的「区块列表」（经历 / 项目 / 教育 / 技能等）。
 *
 * 为什么需要它：变更类操作必须回读验证（本仓库约束零），而验证要有稳定的数据源。
 * 档案页（`/in/<slug>/details/<section>/`）是权威来源——比编辑表单更可靠，
 * 因为表单可能被缓存、也可能只是「打开了还没提交」的草稿。
 *
 * **条目定位靠「编辑表单锚点」而不是 `<li>`**：实测（2026-09）LinkedIn 档案页已改成
 * SDUI（server-driven UI）渲染，条目**不是** `<li>`（`main li` 数量为 0），类名是
 * 构建哈希（`_61ca0bf0` 之类，每次发版都变）。但每个条目都稳定地带一个
 * `<a href=".../edit/forms/<数字id>/">` —— 这个 id 就是编辑该条目要用的 id，
 * 既能当条目标识、又能直接拼出编辑 URL。所以以它为锚点最稳。
 *
 * 条目文本有两种携带方式（都实测过，必须都支持）：
 *   - **经历 / 项目 / 教育**：锚点自带可见文本（`innerText`）
 *   - **技能**：锚点是图标按钮，可见文本为空，名称在 `aria-label="编辑<名称>技能"` 里
 * 只读 `innerText` 会让技能区块读出 0 条（实际有 15 条），这是很容易误判成
 * 「这个人没填技能」的坑。
 *
 * @param {string} section 区块路径，如 "experience" / "projects" / "education" / "skills"
 * @returns {{ok:boolean, count:number, items:Array<{text:string, href:string, editId:string|null}>}}
 */
export async function readSection(rpc, tabId, { slug, section, lang, timeoutMs = 45000 }) {
  const path = `/details/${section}/`;
  await gotoForm(rpc, tabId, { slug, path, lang, timeoutMs }).catch(() => null);
  // SDUI 卡片是懒渲染的：导航返回后条目要再过一拍才出现，固定等一小段比猜选择器可靠
  await sleep(1500);
  return evJson(rpc, tabId, `(() => {
    var sec = document.querySelector('main section') || document.querySelector('main') || document.body;
    var links = [].slice.call(sec.querySelectorAll('a[href*="/edit/forms/"]'));
    var seen = {};
    var items = [];
    links.forEach(function(a){
      var href = a.getAttribute('href') || '';
      // 用字符串切分而不是正则：本仓库踩过「模板字符串里的单反斜杠被吃成 d」的坑
      // （\\d 变成 d，正则静默失配）。字符串操作没有转义层，不可能出这个问题。
      var tail = href.split('/edit/forms/')[1] || '';
      var id = tail.split('/')[0];
      if (!/^\\d+$/.test(id)) return;   // 跳过 "new" 这类新增表单锚点
      var text = (a.innerText || '').trim();
      // 技能类锚点没有可见文本，名称在 aria-label（如「编辑React.js技能」）里
      if (!text) {
        var al = (a.getAttribute('aria-label') || '').trim();
        if (al) {
          var m = al.match(/^编辑(.+?)(技能|技巧|Skill)?$/);
          text = m ? m[1] : al;
        }
      }
      // 每个条目常有两个锚点（一个带文本、一个空壳图标）。用 id 去重，否则条数会翻倍。
      if (!text || seen[id]) return;
      seen[id] = 1;
      items.push({ editId: id, text: text.slice(0, 400), href: href });
    });
    return { ok: true, count: items.length, items: items };
  })()`);
}

/** 读档案顶部的姓名 / Headline / 所在地（只读）。 */
export async function readIntro(rpc, tabId, { slug, lang }) {
  await gotoForm(rpc, tabId, { slug, path: "/", lang, timeoutMs: 45000 }).catch(() => null);
  await sleep(1500);
  return evJson(rpc, tabId, `(() => {
    // 姓名在 <h2>（不是 h1——实测 h1 数量为 0，早期版本据此读不到姓名）
    var h2 = document.querySelector('main h2') || document.querySelector('h2');
    var main = document.querySelector('main');
    // Headline 在主档案区的首段里：取 main 前几段中含「·」或较长的那个
    var ps = [].slice.call(document.querySelectorAll('main p')).map(function(e){ return (e.innerText||'').trim(); }).filter(Boolean);
    var headline = ps.find(function(t){ return t.length > 20 && t !== (h2 && h2.innerText || '').trim(); }) || null;
    return {
      ok: true,
      name: h2 ? (h2.innerText || '').trim() : null,
      headline: headline,
      top: main ? (main.innerText || '').trim().slice(0, 400) : null,
    };
  })()`);
}

// ───────────────────────── 会话入口 ─────────────────────────

/**
 * 打开档案页并跑 fn，结束时自动关掉自己开的 tab（复用用户已有 tab 时不动）。
 *
 * fn 收到 `(tabId, rpc, slug)`——slug 是**显式参数**，不要挂到 rpc 上当隐式全局。
 * 早期版本把 slug 挂在 `rpc.__slug` 上供 deleteEntry 内部取用，那种隐式状态在
 * 一个进程里操作多个档案时会串档（读到别人的档案），已改掉。
 */
export async function withProfile(url, fn, opts = {}) {
  const rpc = opts.rpc || new Rpc({ agentId: opts.agentId || `linkedin-${process.pid}`, agentName: opts.agentName || "LinkedIn" });
  const slug = normalizeSlug(url);
  return rpc.withPage(slug + "/", async (tabId) => fn(tabId, rpc, slug), opts);
}
