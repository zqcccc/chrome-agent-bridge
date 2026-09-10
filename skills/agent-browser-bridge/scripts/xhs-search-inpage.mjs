#!/usr/bin/env node
// 页面内搜索框搜索（示例脚本）—— 不新开标签页，支持频道切换与站内筛选
// 在当前 tab 内定位页面搜索框 → 输入关键词 → Enter 提交 → 等待结果 →（可选）切换频道/应用筛选 → 读取卡片
//
// 用法:
//   BRIDGE_TOKEN=xxx node xhs-search-inpage.mjs <tabId> "<关键词>" [--max-results N] [--channel <全部|图文|视频|用户>] [--filter "排序依据:最新"] [--filter "发布时间:一周内"]
//     --channel   结果频道：全部 / 图文 / 视频 / 用户（小红书自带频道 Tab；AI 新版搜索页只有 全部/用户/问点点，图文/视频不可用时会提示跳过）
//     --filter    筛选条件，可多次传或分号连接多个：--filter "排序依据:最新;发布时间:一周内;笔记类型:视频"
//                 支持的组：排序依据(综合/最新/最多点赞/最多评论/最多收藏) 笔记类型(不限/视频/图文)
//                           发布时间(不限/一天内/一周内/半年内) 搜索范围(不限/已看过/未看过/已关注)
//                           位置距离(不限/同城/附近)
//     --max-results 读取卡片数量上限（默认 10）
//  前置: 根 SKILL.md 的桥已就绪；目标 tab 是小红书页面（explore / search_result 均可）
//
// 踩坑记录（已实测验证，2026-09-10）:
//   - 小红书桌面端顶部搜索栏的真实输入框是可见的 `textarea.textarea`（React 受控组件），
//     不是隐藏的 `input.search-input`（0×0 不可见，向其输入不生效）
//   - 输入必须用 HTMLTextAreaElement 的 native value setter + InputEvent（受控组件友好）
//   - 提交用 Enter 键（keydown Enter），或点 .bottom-box-right-submit-button
//   - 结果跳转到 /search_result 或 /search_result_ai（两者 URL 都含 search_result）
//   - 频道 Tab：普通版 #channel-container .channel(id: all/image/video/user)；AI 新版 .channel-scroll-container-ai .channel(id: all/user/ask_diandian)
//   - 筛选面板：点 .search-layout__top .filter 展开，.filters-wrapper 内每个 .filters 一组（组名在 span），
//     选项是 .tag-container .tags；点选即生效（无确定按钮）；面板外点击/按 Esc 收起
//   - 「位置距离:附近」需要浏览器定位权限：默认视为无权限，直接跳过不点击（输出 skipped:true），不尝试授权
//   - ⚠️ 页面里有另一个扩展注入的隐藏副本（button-hp-installed / aria-hidden="true"，绝对定位覆盖层），
//     点 .tags 时必须过滤掉，否则会点到透明覆盖层（对结果无效且可能被风控）
//   - 结果卡片：section.note-item 内的 .title（标题）+ 可见封面链接（a.cover.mask.ld，带 xsec_token）；
//     卡片里第一个 a[href*="/explore/"] 是 display:none 的隐藏链接，禁止点击
//   - 多关键词时：复用同一 tab，输入框输入新词 → Enter，循环即可，不要开新标签页
const token = process.env.BRIDGE_TOKEN;
const [, , tabIdArg, keywordArg, ...rest] = process.argv;
let maxResults = 10;
let channel = null;
const filters = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--max-results") maxResults = parseInt(rest[i + 1], 10) || 10;
  else if (rest[i] === "--channel") channel = rest[++i];
  else if (rest[i] === "--filter") {
    const spec = rest[++i] || "";
    for (const pair of spec.split(";")) {
      const [group, option] = pair.split(":").map((s) => s.trim());
      if (group && option) filters.push({ group, option });
    }
  }
}
const tabId = Number(tabIdArg);
if (!token || !tabId || !keywordArg) {
  console.error('usage: BRIDGE_TOKEN=xxx node xhs-search-inpage.mjs <tabId> "<关键词>" [--max-results N] [--channel <全部|图文|视频|用户>] [--filter "排序依据:最新;发布时间:一周内"]');
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
// 选择当前可见的搜索输入框（先滚回顶部；过滤 0 尺寸/display:none 的隐藏元素）
// 实测：小红书顶部搜索框有两种形态——展开态 textarea.textarea（首页/探索页）、紧凑态 input.search-input（结果页 sticky 头部）；
// 且部分页面存在 0×0 的隐藏 input.search-input，必须按可见性过滤。
const VISIBLE_TA = `(() => {
  window.scrollTo(0, 0);
  return Array.from(document.querySelectorAll('textarea.textarea, input.search-input')).find(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
  }) || null;
})()`;
// 页面布局探测：普通搜索页 vs AI 新版搜索页（search_result_ai）
// 注意：document.documentElement 上的 ai-layout-active 是「账号级」全局类（该账号开了 AI 布局），
// 不是页面类型标志，普通 search_result 页也会有它——只有 .channel-scroll-container-ai 才是 AI 搜索页。
const LAYOUT_EXPR = `(() => {
  const url = location.href;
  const isAi = !!document.querySelector('.channel-scroll-container-ai');
  const chans = Array.from(document.querySelectorAll('#channel-container .channel, .channel-scroll-container-ai .channel'))
    .map(c => ({ id: c.id, txt: (c.innerText || '').trim().slice(0, 8), active: !!c.classList.contains('active') || !!c.querySelector('.active, .channel-content.active') }));
  return { url: url.slice(0, 80), isAi, chans, hasFilter: !!document.querySelector('.search-layout__top .filter') };
})()`;

// 频道名 → 频道 id（两种布局的映射）
function channelToId(name, layout) {
  const map = {
    '全部': 'all', 'all': 'all',
    '图文': 'image', 'image': 'image',
    '视频': 'video', 'video': 'video',
    '用户': 'user', 'user': 'user',
  };
  const id = map[String(name || '').trim()];
  if (!id) return null;
  // AI 新版布局没有 图文/视频 频道，调用方据此提示跳过
  return id;
}
function channelAvailable(id, chans) {
  return chans.some((c) => c.id === id);
}

async function main() {
  // 0. 静默准备标签页（content script 注入前提，不抢焦点）
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

  // 2. 在可见搜索框输入关键词（React 受控组件：native setter + InputEvent；textarea/input 用各自原型）
  const kw = JSON.stringify(keywordArg);
  await evaluate(`(() => {
    const ta = ${VISIBLE_TA};
    if (!ta) return { ok: false, err: 'no visible search input' };
    ta.focus();
    const proto = ta.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
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
  console.error('🚀 已提交搜索');

  // 4. 等待跳转到搜索结果页
  try {
    await rpc("page.waitForUrl", { tabId, match: "search_result", timeoutMs: 15000 }, 20000);
  } catch {}
  await sleep(1800);

  // 5. 布局探测 + 频道切换（可选）
  const layout = await evaluate(LAYOUT_EXPR);
  console.error(`📄 当前结果页: ${layout.url} ${layout.isAi ? '[AI 新版布局]' : '[普通布局]'} 频道: ${layout.chans.map(c => c.txt).join('/')}（当前: ${(layout.chans.find(c => c.active) || {}).txt || '?'}）筛选按钮: ${layout.hasFilter ? '有' : '无'}`);
  if (channel) {
    const id = channelToId(channel, layout);
    if (!id) {
      console.error(`⚠️ 未知频道: ${channel}（可选: 全部/图文/视频/用户）`);
    } else if (!channelAvailable(id, layout.chans)) {
      console.error(`⚠️ 当前布局没有「${channel}」频道，跳过频道切换`);
    } else {
      const ck = await evaluate(`(() => {
        const el = document.querySelector('#channel-container #${id}, .channel-scroll-container-ai #${id}');
        if (!el) return { ok: false, reason: 'no channel #${id}' };
        // 防止点到隐藏覆盖层（其他扩展注入），校验可见性
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return { ok: false, reason: 'channel hidden' };
        el.click();
        return { ok: true };
      })()`);
      if (!ck || !ck.ok) console.error(`⚠️ 切换频道「${channel}」失败: ${ck && ck.reason}`);
      else { console.error(`🔀 已切换频道: ${channel}`); await sleep(2500); }
    }
  }

  // 6. 应用筛选（可选）：展开面板 → 逐项点选（并验证激活）→ 收起
  const appliedFilters = [];
  if (filters.length > 0) {
    // 筛选按钮只在笔记类频道（全部/图文/视频）显示；当前若停在「用户」频道，先切回「全部」
    const cur = await evaluate(`(() => {
      const chans = Array.from(document.querySelectorAll('#channel-container .channel, .channel-scroll-container-ai .channel'));
      return { active: (chans.find(c => c.classList.contains('active') || !!c.querySelector('.active, .channel-content.active')) || {}).id || null };
    })()`);
    if (cur && cur.active === 'user') {
      console.error('🔀 当前在「用户」频道（筛选仅对笔记类频道可用），先切回「全部」...');
      await evaluate(`(() => {
        const el = document.querySelector('#channel-container #all, .channel-scroll-container-ai #all');
        if (el) el.click();
        return { ok: !!el };
      })()`);
      await sleep(2500);
    }
    const layout2 = await evaluate(LAYOUT_EXPR);
    if (!layout2.hasFilter) {
      console.error('⚠️ 当前页面没有「筛选」按钮（AI 新版搜索页不支持筛选），跳过筛选');
    } else {
      // 打开筛选面板：按钮可能因页面刚跳转/重排未就绪，可重试 + 轮询确认面板出现
      let panelOpen = false;
      for (let attempt = 1; attempt <= 3 && !panelOpen; attempt++) {
        const fb = await evaluate(`(() => {
          const f = document.querySelector('.search-layout__top .filter');
          if (!f) return { ok: false, reason: '筛选按钮不存在' };
          const r = f.getBoundingClientRect();
          return { ok: r.width > 0 && r.height > 0, reason: r.width > 0 ? '' : '筛选按钮不可见' };
        })()`);
        if (!fb || !fb.ok) {
          console.error(`⚠️ ${fb && fb.reason}（结果页可能仍在加载），等 1.5s 重试...`);
          await sleep(1500);
          continue;
        }
        await evaluate(`(() => { const f = document.querySelector('.search-layout__top .filter'); if (f) f.click(); return { ok: true }; })()`);
        let waited = 0;
        while (waited < 5000) {
          const opened = await evaluate(`(() => !!document.querySelector('.filters-wrapper .filters'))()`);
          if (opened) { panelOpen = true; break; }
          await sleep(600); waited += 600;
        }
        if (!panelOpen) console.error(`⚠️ 第 ${attempt} 次点击后筛选面板未展开，重试...`);
      }
      if (!panelOpen) {
        console.error('❌ 无法展开筛选面板，跳过筛选（页面可能处于异常状态）');
      } else {
        console.error('🎛 筛选面板已展开');
        for (const { group, option } of filters) {
          // 已知不可用选项：直接跳过，不点击（减少无效交互）
          // 「位置距离:附近」需要浏览器定位权限，默认视为无权限，不尝试
          if (group === '位置距离' && option === '附近') {
            console.error(`⏭ 筛选 ${group}:${option} 需要浏览器定位权限，默认跳过（不尝试授权）`);
            appliedFilters.push({ group, option, activated: false, skipped: true, reason: '需要浏览器定位权限，默认不可用' });
            continue;
          }
          const g = JSON.stringify(group), o = JSON.stringify(option);
          const r = await evaluate(`(() => {
            const groups = Array.from(document.querySelectorAll('.filters-wrapper .filters'));
            const g = groups.find(x => (x.querySelector('span') || {}).innerText === ${g});
            if (!g) return { ok: false, reason: '无筛选组 ' + ${g}, available: groups.map(x => (x.querySelector('span') || {}).innerText) };
            // 过滤掉其他扩展注入的隐藏副本（button-hp-installed / aria-hidden）
            const real = Array.from(g.querySelectorAll('.tag-container .tags')).filter(el => !el.hasAttribute('aria-hidden') && !el.hasAttribute('button-hp-installed'));
            const t = real.find(el => (el.querySelector('span') || {}).innerText === ${o});
            if (!t) return { ok: false, reason: '无选项 ' + ${o} + ' in ' + ${g}, options: real.map(x => x.innerText.trim()) };
            const rect = t.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return { ok: false, reason: '选项不可见(隐藏副本?)' };
            t.click();
            return { ok: true, clicked: ${g} + ':' + ${o} };
          })()`);
          if (!r || !r.ok) {
            console.error(`⚠️ 筛选 ${group}:${option} 未生效: ${r && r.reason}`);
            if (r && r.available) console.error(`   当前可用筛选组: ${r.available.join(' / ')}`);
            continue;
          }
          // 点选后结果重新拉取，稍等渲染，并**验证该选项真的获得选中态**
          // （实测「位置距离:附近」点击成功但 active 不变——站点侧定位权限限制，脚本应如实报告而非假装成功）
          await sleep(1800);
          const chk = await evaluate(`(() => {
            const grp = Array.from(document.querySelectorAll('.filters-wrapper .filters')).find(x => (x.querySelector(':scope > span') || {}).innerText === ${g});
            if (!grp) return { activated: false };
            const opt = Array.from(grp.querySelectorAll('.tag-container .tags'))
              .filter(el => !el.hasAttribute('aria-hidden') && !el.hasAttribute('button-hp-installed'))
              .find(t => (t.querySelector('span') || {}).innerText === ${o});
            return { activated: !!(opt && opt.classList.contains('active')) };
          })()`);
          if (chk && chk.activated) {
            console.error(`🎛 已应用筛选: ${group}:${option}`);
            appliedFilters.push({ group, option, activated: true });
          } else {
            console.error(`⚠️ 筛选 ${group}:${option} 点击成功但未获得选中态（站点侧未接受）`);
            appliedFilters.push({ group, option, activated: false });
            if (group === '位置距离' && option === '附近') {
              console.error(`   「附近」依赖浏览器定位权限：请先在 chrome://settings/content/location 允许 www.xiaohongshu.com 定位（或点地址栏权限图标授权），再重试`);
            }
          }
          // 面板可能因外部点击收起，每项前重新打开
          await evaluate(`(() => {
            if (!document.querySelector('.filters-wrapper')) { const f = document.querySelector('.search-layout__top .filter'); if (f) f.click(); }
            return { ok: true };
          })()`);
          await sleep(600);
        }
        // 收起面板（Esc；兜底再点一次筛选按钮）
        await evaluate(`(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
          return { ok: true };
        })()`);
        await sleep(800);
      }
    }
  }

  // 7. 读取结果卡片（页面内读取，不逐条开新 tab）
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
  console.log(JSON.stringify({ tabId, keyword: keywordArg, channel: channel || '全部', filters: appliedFilters.length > 0 ? appliedFilters : filters, count: (cards || []).length, results: cards || [] }, null, 2));
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
