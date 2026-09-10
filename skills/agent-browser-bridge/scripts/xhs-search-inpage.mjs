#!/usr/bin/env node
// 页面内搜索框搜索（示例脚本）—— 不新开标签页
// 在当前 tab 内定位页面搜索框 → 输入关键词 → Enter 提交 → 等待结果 → 读取卡片
//
// 用法: BRIDGE_TOKEN=xxx node xhs-search-inpage.mjs <tabId> "<关键词>" [--max-results N]
// 前置: 根 SKILL.md 的桥已就绪；目标 tab 是小红书页面（explore / search_result 均可）
//
// 踩坑记录（已实测验证，2026-09-10）:
//   - 小红书桌面端顶部搜索栏的真实输入框是可见的 `textarea.textarea`（React 受控组件），
//     不是隐藏的 `input.search-input`（0×0 不可见，向其输入不生效）
//   - 输入必须用 HTMLTextAreaElement 的 native value setter + InputEvent（受控组件友好）
//   - 提交用 Enter 键（keydown Enter），或点 .bottom-box-right-submit-button
//   - 结果跳转到 /search_result 或 /search_result_ai
const token = process.env.BRIDGE_TOKEN;
const [, , tabIdArg, keywordArg, ...rest] = process.argv;
let maxResults = 10;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--max-results") maxResults = parseInt(rest[i + 1], 10) || 10;
}
const tabId = Number(tabIdArg);
if (!token || !tabId || !keywordArg) {
  console.error('usage: BRIDGE_TOKEN=xxx node xhs-search-inpage.mjs <tabId> "<关键词>" [--max-results N]');
  process.exit(1);
}

const rpc = async (method, params = {}, timeoutMs = 20000) => {
  const res = await fetch("http://127.0.0.1:8778/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, params, timeoutMs }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method} failed: ${JSON.stringify(json.error || json)}`);
  return json.result;
};
const safeParse = (s) => { try { return JSON.parse(s); } catch { return s; } };
const evaluate = async (expression, timeoutMs = 20000) => {
  const r = await rpc("page.evaluate", { tabId, expression, awaitPromise: false }, timeoutMs);
  const val = r && r.result;
  return typeof val === "string" ? safeParse(val) : val;
};
// 选择当前可见的搜索输入框（过滤 0 尺寸/在视口外/display:none 的隐藏元素）
const VISIBLE_TA = `(() => {
  return Array.from(document.querySelectorAll('textarea.textarea')).find(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.y >= 0 && r.y < innerHeight;
  }) || null;
})()`;

async function main() {
  // 0. 激活标签页（content script 注入前提）
  try { await rpc("tabs.activate", { tabId }, 15000); } catch {}

  // 1. 状态检查：验证码/404 立即停止，不重试
  const st = await evaluate(`(() => {
    const url = location.href, title = document.title || '';
    if (url.includes('/404') || title.includes('你访问的页面不见了') || title.includes('Sorry')) return { ok: false, reason: '404' };
    if (url.includes('website-login/captcha') || /security\\s*verification|captcha|安全验证|人机验证/i.test(title)) return { ok: false, reason: 'CAPTCHA_BLOCKED' };
    const ta = ${VISIBLE_TA};
    return { ok: true, hasSearch: !!ta, url: url.slice(0, 80) };
  })()`);
  if (!st || !st.ok) {
    console.error(st?.reason === 'CAPTCHA_BLOCKED'
      ? '⛔ 小红书触发安全验证，已停止。请等待用户手动完成验证后再试，不要重试。'
      : `⚠️ 页面受限(404/登录): ${st && st.url}`);
    process.exit(1);
  }
  if (!st.hasSearch) {
    console.error('⚠️ 未找到可见搜索框 textarea.textarea，页面结构可能已变化，先确认页面已打开小红书');
    process.exit(1);
  }

  // 2. 在可见搜索框输入关键词（React 受控组件：native setter + InputEvent）
  const kw = JSON.stringify(keywordArg);
  await evaluate(`(() => {
    const ta = ${VISIBLE_TA};
    if (!ta) return { ok: false, err: 'no visible textarea' };
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${kw});
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${kw} }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, val: ta.value };
  })()`);
  console.error(`🔍 已在页面内输入: ${keywordArg}`);

  // 3. 提交：优先按 Enter（实测有效）；备用点击 .bottom-box-right-submit-button
  await evaluate(`(() => {
    const ta = ${VISIBLE_TA};
    if (!ta) return { ok: false };
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    return { ok: true };
  })()`);

  // 4. 等待跳转到搜索结果页
  try {
    await rpc("page.waitForUrl", { tabId, match: "search_result", timeoutMs: 15000 }, 20000);
  } catch {}
  await new Promise((r) => setTimeout(r, 1500));

  // 5. 读取结果卡片（页面内读取，不逐条开新 tab）
  //    注意：卡片里第一个 a[href*="/explore/"] 是 display:none 的隐藏链接，取可见的封面链接（a.cover.mask.ld）
  const cards = await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('section.note-item'));
    return items.slice(0, ${maxResults}).map((c) => {
      const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'; };
      const a = Array.from(c.querySelectorAll('a')).find((x) => vis(x) && (x.classList.contains('cover') || /cover|mask|ld/.test(x.className)));
      const t = c.querySelector('.title');
      return { title: (t && t.textContent || '').trim().slice(0, 60), href: a ? a.href : '' };
    }).filter((x) => x.href || x.title);
  })()`);
  console.log(JSON.stringify({ tabId, keyword: keywordArg, count: (cards || []).length, results: cards || [] }, null, 2));
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
