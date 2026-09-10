#!/usr/bin/env node
// 小红书搜索用户（示例脚本）—— 页面内搜索框输入关键词 → Enter → 切换到「用户」频道 → 读取用户卡片
// 不新开标签页，复用当前 tab。
//
// 用法:
//   BRIDGE_TOKEN=xxx node xhs-search-user.mjs <tabId> "<关键词>" [--max-results N]
//     --max-results 读取用户卡片数量上限（默认 10）
//  前置: 根 SKILL.md 的桥已就绪；目标 tab 是小红书页面
//
// 实测结构（2026-09-10 验证）:
//   - 频道 Tab：普通版 #channel-container #user；AI 新版 .channel-scroll-container-ai #user（都叫「用户」）
//   - 用户卡片：.user-list-item（两种布局一致）
//     - 姓名：.user-name
//     - 最近更新：.user-tag（如「2天前更新」）
//     - 小红书号：.user-desc（第一个 span）
//     - 粉丝/笔记：.user-desc-box（两个 span，如「粉丝・1353」「笔记・58」）
//     - 卡片整块是 a[href*="/user/profile/"] 链接
//   - 自己的账号会以「我」卡片置顶（无 xsec_token）
//   - 点卡片会导航到该用户主页（可在同 tab 内继续跑 xhs-user-notes.mjs）
const token = process.env.BRIDGE_TOKEN;
const [, , tabIdArg, keywordArg, ...rest] = process.argv;
let maxResults = 10;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--max-results") maxResults = parseInt(rest[i + 1], 10) || 10;
}
const tabId = Number(tabIdArg);
if (!token || !tabId || !keywordArg) {
  console.error('usage: BRIDGE_TOKEN=xxx node xhs-search-user.mjs <tabId> "<关键词>" [--max-results N]');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VISIBLE_TA = `(() => {
  window.scrollTo(0, 0);
  return Array.from(document.querySelectorAll('textarea.textarea, input.search-input')).find(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
  }) || null;
})()`;

async function main() {
  // 0. 静默准备标签页
  try { await rpc("tabs.prepare", { tabId }, 15000); } catch {}

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

  // 2. 输入关键词（React 受控组件：native setter + InputEvent；textarea/input 用各自原型）
  const kw = JSON.stringify(keywordArg);
  await evaluate(`(() => {
    const ta = ${VISIBLE_TA};
    if (!ta) return { ok: false };
    ta.focus();
    const proto = ta.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(ta, ${kw});
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${kw} }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`);
  console.error(`🔍 已输入关键词: ${keywordArg}`);

  // 3. 提交（Enter）
  await evaluate(`(() => {
    const ta = ${VISIBLE_TA};
    if (!ta) return { ok: false };
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    return { ok: true };
  })()`);
  console.error('🚀 已提交搜索');

  // 4. 等待搜索结果页
  try {
    await rpc("page.waitForUrl", { tabId, match: "search_result", timeoutMs: 15000 }, 20000);
  } catch {}
  await sleep(1800);

  // 5. 切换到「用户」频道（两种布局都兼容）
  const ck = await evaluate(`(() => {
    const el = document.querySelector('#channel-container #user, .channel-scroll-container-ai #user');
    if (!el) return { ok: false, reason: '未找到用户频道' };
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { ok: false, reason: '用户频道不可见' };
    el.click();
    return { ok: true };
  })()`);
  if (!ck || !ck.ok) {
    console.error(`❌ 切换到用户频道失败: ${ck && ck.reason}（确认已进入搜索页）`);
    process.exit(1);
  }
  console.error('👥 已切换到「用户」频道，等待结果...');
  await sleep(3000);

  // 6. 读取用户卡片
  //    踩坑：部分用户卡片中间多一行品类标签（如「服饰鞋帽」），.user-desc-box 按下标取会错位。
  //    因此 name/tag 用结构化选择器（实测可靠），粉丝/笔记/小红书号用整卡文本按语义正则匹配。
  const cards = await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.user-list-item'));
    return items.slice(0, ${maxResults}).map((item) => {
      const a = item.querySelector('a[href*="/user/profile/"]');
      const full = (item.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
      const lines = [...new Set(full)];
      const name = item.querySelector('.user-name')?.innerText?.trim() || lines[0] || '';
      const tag = item.querySelector('.user-tag')?.innerText?.trim() || '';
      const find = (re) => lines.find(l => re.test(l)) || '';
      const idText = (find(/^小红书号\\s*[:：]?\\s*(\\d+)/) || '').replace(/^小红书号\\s*[:：]?\\s*/, '');
      const fans = find(/^粉丝\\s*[・·]?/);
      const notes = find(/^笔记\\s*[・·]?/);
      return {
        name,
        lastUpdate: tag || find(/更新$/),
        xhsId: idText,
        fans,
        notes,
        href: a ? a.href.split('?')[0] : ''
      };
    }).filter((x) => x.name);
  })()`);
  console.log(JSON.stringify({ tabId, keyword: keywordArg, count: (cards || []).length, users: cards || [] }, null, 2));
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
