#!/usr/bin/env node
// 单条小红书笔记全量抓取（示例脚本）—— 所有图片 + 所有文字 + 所有评论，全程不新开标签页
// 在当前 tab 的笔记详情（或列表页弹窗）内完成：滚动加载全部评论 → 展开全部楼中楼 → 提取图片/元数据/评论树
//
// 用法:
//   BRIDGE_TOKEN=xxx node xhs-note-full.mjs <tabId> [--card N] [--max-scrolls N] [--out out.json] [--format json|text] [--close]
//     <tabId>        笔记详情页 tab；若在搜索/列表页，配合 --card N 点开第 N 张卡片（弹窗）
//     --card N       列表页点开第 N 张卡片（默认 0），用页面内弹窗打开
//     --max-scrolls  评论区最大滚动轮数（默认 30）
//     --out          保存完整 JSON 到文件
//     --format       默认 text 可读输出；json 输出结构化数据
//     --close        抓取完成后关闭详情弹窗（回到列表页），便于同一 tab 继续点开下一条
//
// 实测结构（2026-09-10 验证）:
//   - 详情弹窗容器: .note-detail-mask（内部含 .note-container）
//   - 标题/正文: note 内 .title / .desc
//   - 图片: note 内 .swiper-slide img（sns-webpic 域，跳过 duplicate 副本后按去参 URL 去重；保留 ! 参数否则 403；live photo 标 isLive 并带 liveVideo blob）
//   - 互动: .engage-bar 内 .like-wrapper / .collect-wrapper / .chat-wrapper 的 .count（评论区有同名元素，必须限定 engage-bar）
//   - 坑: 模板字符串内正则必须写双反斜杠 \\d（单反斜杠 \\d 会被丢弃成 d）
//   - 评论: .comment-item（一级）/ .comment-item-sub（楼中楼），滚动 .note-scroller 触底加载
import fs from "node:fs";
import path from "node:path";

const token = process.env.BRIDGE_TOKEN;
const [, , tabIdArg, ...rest] = process.argv;
const args = { tabId: Number(tabIdArg), card: null, maxScrolls: 30, out: null, format: "text", close: false };
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--card") args.card = parseInt(rest[++i], 10);
  else if (rest[i] === "--max-scrolls") args.maxScrolls = parseInt(rest[++i], 10) || 30;
  else if (rest[i] === "--out") args.out = rest[++i];
  else if (rest[i] === "--format") args.format = rest[++i];
  else if (rest[i] === "--close") args.close = true;
}
if (!token || !args.tabId) {
  console.error('usage: BRIDGE_TOKEN=xxx node xhs-note-full.mjs <tabId> [--card N] [--max-scrolls N] [--out out.json] [--format json|text]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const evaluate = async (tabId, expression, timeoutMs = 20000) => {
  const r = await rpc("page.evaluate", { tabId, expression, awaitPromise: false }, timeoutMs);
  const val = r && r.result;
  return typeof val === "string" ? safeParse(val) : val;
};

// 弹窗是否还存在（幂等判断：无弹窗/不可见 = 已关闭）
const modalGoneExpr = `(() => {
  const m = document.querySelector('.note-detail-mask');
  if (!m) return true;
  const r = m.getBoundingClientRect();
  return r.width <= 0 || r.height <= 0;
})()`;

// 健壮关闭详情弹窗：Esc → 关闭按钮 → 点遮罩空白，每级后轮询验证，最多 3 轮；无弹窗时直接返回（幂等）
async function closeNoteModal(tabId) {
  const has = await evaluate(tabId, `(() => {
    const m = document.querySelector('.note-detail-mask');
    if (!m) return { has: false };
    const r = m.getBoundingClientRect();
    return { has: r.width > 0 && r.height > 0 };
  })()`);
  if (!has || !has.has) return { closed: false, reason: 'no-modal' };

  for (let attempt = 1; attempt <= 3; attempt++) {
    // a) Esc 键
    await evaluate(tabId, `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      return { sent: true };
    })()`);
    await sleep(600);
    if (await evaluate(tabId, modalGoneExpr)) return { closed: true, via: 'esc' };

    // b) 关闭按钮（弹窗左上角 X / 关闭图标）
    await evaluate(tabId, `(() => {
      const note = document.querySelector('.note-detail-mask');
      const btn = note && (note.querySelector('.close-circle, .close.close-mask-dark, button.reds-button-new.close-icon, [class*="close-icon"]'));
      if (btn) { btn.click(); return { clicked: true }; }
      return { clicked: false };
    })()`);
    await sleep(600);
    if (await evaluate(tabId, modalGoneExpr)) return { closed: true, via: 'close-btn' };

    // c) 点弹窗右侧外部空白（遮罩区域）
    await evaluate(tabId, `(() => {
      const modal = document.querySelector('.note-detail-mask');
      if (!modal) return { clicked: false };
      const r = modal.getBoundingClientRect();
      const x = Math.min(r.right + 24, window.innerWidth - 8);
      const y = Math.max(8, Math.min(140, r.top + 60));
      const el = document.elementFromPoint(x, y);
      if (el) {
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window });
        el.dispatchEvent(ev);
        return { clicked: true, on: el.tagName + '.' + String(el.className || '').slice(0, 30) };
      }
      return { clicked: false };
    })()`);
    await sleep(700);
    if (await evaluate(tabId, modalGoneExpr)) return { closed: true, via: 'mask-click' };
  }
  return { closed: false, reason: 'still-open-after-3-attempts' };
}

async function main() {
  const tabId = args.tabId;
  try { await rpc("tabs.activate", { tabId }, 15000); } catch {}

  // 1. 状态检查：验证码/404 立即停止，不重试
  const checkStatusExpr = `(() => {
    const url = location.href, title = document.title || '';
    if (url.includes('/404') || title.includes('你访问的页面不见了') || title.includes('Sorry')) return { ok: false, reason: '404_OR_LOGIN_REQUIRED' };
    if (url.includes('website-login/captcha') || /security\\s*verification|captcha|安全验证|人机验证/i.test(title)) return { ok: false, reason: 'CAPTCHA_BLOCKED' };
    const hasNoteDetail = !!(document.querySelector('.note-scroller, .note-container, .note-detail-mask, .interaction-container') && document.querySelector('.comment-item, [class*="comment-item"], .interact-container'));
    const isSearchList = url.includes('/search_result') || !!document.querySelector('.search-layout, .feeds-container');
    return { ok: true, hasNoteDetail, isSearchList, url: url.slice(0, 80) };
  })()`;
  let status = await evaluate(tabId, checkStatusExpr);
  if (!status || !status.ok) {
    console.error(status?.reason === 'CAPTCHA_BLOCKED'
      ? '⛔ 小红书触发安全验证，已停止。请等待用户手动完成验证后再试，不要重试。'
      : `⚠️ 小红书页面受限或处于 404，请确认已登录且链接有效（URL: ${status && status.url}）`);
    process.exit(1);
  }

  // 2. 若在列表页且未打开详情，用页面内弹窗点开第 N 张卡片
  if (!status.hasNoteDetail && status.isSearchList) {
    const idx = args.card !== null ? args.card : 0;
    console.log(`📑 当前位于列表页，点开第 ${idx} 张卡片（页面内弹窗，不新开 tab）...`);
    const r = await evaluate(tabId, `(() => {
      const cards = Array.from(document.querySelectorAll('section.note-item, .search-card, [class*="note-item"]'));
      const card = cards[${idx}];
      if (!card) return { ok: false, reason: 'no card at index ' + ${idx} };
      // 必须点「可见」的封面链接（a.cover.mask.ld，带 xsec_token）；
      // 卡片里第一个 a[href*="/explore/"] 是 display:none 的隐藏链接，click() 会触发风控 404，禁止使用。
      const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'; };
      const a = Array.from(card.querySelectorAll('a')).find((x) => vis(x) && (x.classList.contains('cover') || /cover|mask|ld/.test(x.className) || x.href.includes('/search_result/')));
      if (a) { a.click(); return { ok: true, href: a.href.slice(0, 90), title: card.innerText.slice(0, 40) }; }
      const anyVis = Array.from(card.querySelectorAll('a')).find((x) => vis(x));
      if (anyVis) { anyVis.click(); return { ok: true, href: anyVis.href.slice(0, 90), title: card.innerText.slice(0, 40) }; }
      card.click();
      return { ok: true, mode: 'card' };
    })()`);
    if (!r || !r.ok) { console.error(`❌ 打开卡片失败: ${r && r.reason}`); process.exit(1); }
    await sleep(2500);
  }

  // 3. 循环滚动加载全部一级评论
  //    只滚动详情弹窗内右侧滚动区（.note-scroller），绝不滚动 window——
  //    否则弹窗背后的列表页滚动位置会被带跑，关闭弹窗后列表位置就变了（用户实测反馈）
  let lastCount = 0, sameCountRounds = 0;
  for (let round = 1; round <= args.maxScrolls; round++) {
    const sr = await evaluate(tabId, `(() => {
      const mask = document.querySelector('.note-detail-mask');
      let scroller = null;
      if (mask) {
        scroller = mask.querySelector('.note-scroller');
        if (!scroller) {
          scroller = Array.from(mask.querySelectorAll('*')).find((el) => el.scrollHeight > el.clientHeight + 60);
          if (!scroller) scroller = mask;
        }
      }
      if (!scroller) scroller = document.querySelector('.note-scroller');
      const beforeCount = document.querySelectorAll('.comment-item, [class*="comment-item"]').length;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      return { count: beforeCount, scrolled: scroller ? String(scroller.className || scroller.tagName).slice(0, 30) : null };
    })()`);
    const count = (sr && sr.count) || 0;
    if (count === lastCount) sameCountRounds++; else { sameCountRounds = 0; lastCount = count; }
    process.stdout.write(`\r   [第 ${round}/${args.maxScrolls} 轮滚动] 已加载一级评论: ${count} 条...`);
    if (sameCountRounds >= 4 && round >= 3) { console.log("\n   ✓ 评论列表已触底。"); break; }
    await sleep(650);
  }
  console.log("");

  // 4. 递归展开所有二级回复与长文本折叠
  let totalExpanded = 0;
  for (let pass = 1; pass <= 6; pass++) {
    const er = await evaluate(tabId, `(() => {
      const candidates = Array.from(document.querySelectorAll('*')).filter((el) => {
        if (el.children.length > 2) return false;
        if (el.getAttribute('data-agent-expanded') === 'true') return false;
        const txt = (el.innerText || '').trim();
        if (!txt) return false;
        const isShowMore = el.classList?.contains('show-more') || el.classList?.contains('expand-btn') ||
          el.parentElement?.classList?.contains('reply-container') || el.parentElement?.classList?.contains('show-more') ||
          txt.includes('展开') || txt.includes('条回复') || txt === '...展开';
        return isShowMore && !txt.includes('收起');
      });
      let clicked = 0;
      for (const btn of candidates) { try { btn.setAttribute('data-agent-expanded', 'true'); btn.click(); clicked++; } catch {} }
      return { clicked };
    })()`);
    const clicked = (er && er.clicked) || 0;
    if (clicked > 0) { totalExpanded += clicked; await sleep(600); } else break;
  }
  console.log(`   ✓ 折叠内容已全部展开（共触发 ${totalExpanded} 次）。`);

  // 5. 提取完整数据：笔记元数据 + 全部图片 + 全部评论树
  console.log("⏳ 提取笔记元数据、图片与评论树...");
  const extractExpr = `(() => {
    const noteScope = document.querySelector('.note-detail-mask, .note-container, .interaction-container, .note-scroller') || document;

    // ---- 笔记元数据 ----
    const titleEl = noteScope.querySelector('#detail-title, .title') || document.querySelector('#detail-title, .title');
    const descEl = noteScope.querySelector('#detail-desc, .desc, [class*="note-text"]') || document.querySelector('#detail-desc, .desc');
    const authorEl = noteScope.querySelector('.author-container .name, .username, .author-wrapper .name, [class*="author"] [class*="name"]');
    const dateEl = noteScope.querySelector('.date, [class*="bottom-info"] .date');
    const locEl = noteScope.querySelector('.location');
    // 互动计数（笔记主互动区在 .engage-bar 内；页面中还有评论区的小 like-wrapper，必须限定范围）
    const bar = noteScope.querySelector('.engage-bar') || noteScope;
    const likeEl = bar.querySelector('.like-wrapper');
    const collectEl = bar.querySelector('.collect-wrapper');
    const chatEl = bar.querySelector('.chat-wrapper');
    // 互动计数只取纯数字（.count 缺失时 fallback 的"赞/评论/回复"字样视为 0）
    // 注意：extractExpr 是模板字符串，正则里必须写双反斜杠 \\d，单反斜杠 \d 会被模板字符串丢弃成 d
    const numOf = (el) => {
      if (!el) return '';
      const c = el.querySelector('.count');
      const t = (c ? c.innerText : el.innerText || '').trim();
      return /^\\d+(\\.\\d+)?[kKwW万]?$/.test(t) ? t : '';
    };

    // ---- 全部图片（轮播图；含 live photo 标记与 blob 视频；保留完整 URL——去掉 ! 参数会 403）----
    // 实测：URL 必须保留 !nd_dft_wlteh_webp_3 等参数才能直接访问；split('!')[0] 去参数 → 403
    const seen = new Set(); const images = [];
    for (const s of noteScope.querySelectorAll('.swiper-slide')) {
      if (s.classList.contains('swiper-slide-duplicate')) continue; // 跳过轮播首尾副本
      const img = s.querySelector('img');
      const video = s.querySelector('video');
      const isLive = !!s.querySelector('[class*="live"]') || !!video;
      let src = img ? (img.currentSrc || img.src || img.getAttribute('data-src') || '') : '';
      if (!src && video) src = video.poster || '';
      if (!src || !src.includes('sns-webpic')) continue;
      const key = src.split('!')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      images.push({ url: src, isLive, liveVideo: video ? video.src : null });
    }

    const noteInfo = {
      title: (titleEl ? titleEl.innerText.trim() : document.title.replace(/\\s*-\\s*小红书.*$/, '')) || '',
      author: authorEl ? authorEl.innerText.trim() : '未知作者',
      publishInfo: [dateEl && dateEl.innerText.trim(), locEl && locEl.innerText.trim()].filter(Boolean).join(' '),
      likeCount: numOf(likeEl),
      collectCount: numOf(collectEl),
      chatCount: numOf(chatEl),
      content: descEl ? descEl.innerText.trim() : '',
      url: location.href.split('?')[0],
      imageCount: images.length,
      images
    };

    // ---- 评论树（一级 + 楼中楼）----
    let parentNodes = Array.from(noteScope.querySelectorAll('.parent-comment'));
    if (parentNodes.length === 0) {
      parentNodes = Array.from(noteScope.querySelectorAll('.comment-item')).filter((el) => !el.classList.contains('comment-item-sub') && !el.closest('.reply-container'));
    }
    const formatCount = (val) => { if (!val || val === '赞' || val === '回复') return '0'; return String(val).trim(); };
    const cleanDateLoc = (node) => {
      const d = node.querySelector('.info .date, .date'); const l = node.querySelector('.info .location, .location');
      const dt = d?.innerText?.trim() || ''; const lt = l?.innerText?.trim() || '';
      if (dt && lt && !dt.includes(lt)) return dt + ' ' + lt;
      return dt || lt || node.querySelector('.info')?.innerText?.replace(/\\s+/g, ' ').trim() || '';
    };
    const comments = [];
    for (const node of parentNodes) {
      const mainItem = node.classList.contains('parent-comment') ? (node.querySelector('.comment-item:not(.comment-item-sub)') || node) : node;
      const content = mainItem.querySelector('.content .note-text, .note-text, .content, [class*="content"]')?.innerText?.trim() || '';
      if (!content) continue;
      const likeRaw = mainItem.querySelector('.interactions .like .count, .like-wrapper .count')?.innerText ||
                      mainItem.querySelector('.interactions .like')?.innerText || '0';
      const subReplies = [];
      for (const sub of node.querySelectorAll('.comment-item-sub, .sub-comment-item, [class*="comment-item-sub"], [class*="sub-comment"]')) {
        const subContent = sub.querySelector('.content .note-text, .note-text, .content, [class*="content"]')?.innerText?.trim() || '';
        if (!subContent) continue;
        const subLikeRaw = sub.querySelector('.interactions .like .count, .like-wrapper .count')?.innerText ||
                           sub.querySelector('.interactions .like')?.innerText || '0';
        subReplies.push({
          author: sub.querySelector('.author .name, .name, [class*="name"]')?.innerText?.trim() || '匿名用户',
          content: subContent,
          dateLoc: cleanDateLoc(sub),
          likeCount: formatCount(subLikeRaw)
        });
      }
      comments.push({
        author: mainItem.querySelector('.author .name, .name, [class*="name"]')?.innerText?.trim() || '匿名用户',
        content,
        dateLoc: cleanDateLoc(mainItem),
        likeCount: formatCount(likeRaw),
        isAuthorLiked: !!mainItem.querySelector('[class*="author-like"]'),
        subRepliesCount: subReplies.length,
        subReplies
      });
    }

    return {
      note: noteInfo,
      totalParentComments: comments.length,
      totalSubComments: comments.reduce((acc, cur) => acc + cur.subReplies.length, 0),
      comments
    };
  })()`;
  const data = await evaluate(tabId, extractExpr);
  if (!data || !data.note) { console.error("❌ 提取失败，未能获取笔记数据。"); process.exit(1); }

  const totalAll = data.totalParentComments + data.totalSubComments;
  console.log(`🎉 完成！图片 ${data.note.imageCount} 张 | 一级评论 ${data.totalParentComments} 条 | 楼中楼 ${data.totalSubComments} 条 | 共 ${totalAll} 条评论。`);

  // 6. 可选：抓取完成后关闭详情弹窗（放在所有输出分支之前，保证 --close 总是执行）
  if (args.close) {
    const c = await closeNoteModal(tabId);
    console.log(c.closed
      ? `🗑 详情弹窗已关闭${c.via ? '（方式: ' + c.via + '）' : ''}，可继续点开下一条。`
      : `⚠️ 弹窗关闭未成功${c.reason ? ': ' + c.reason : ''}`);
  }

  if (args.out) {
    const p = path.resolve(process.cwd(), args.out);
    fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
    console.log(`💾 完整数据已保存至: ${p}`);
  }
  if (args.format === "json") { console.log(JSON.stringify(data, null, 2)); return; }

  // 可读输出
  const n = data.note;
  console.log(`\n==================== 笔记 ====================`);
  console.log(`标题: ${n.title}`);
  console.log(`作者: ${n.author} | ${n.publishInfo}`);
  console.log(`互动: 赞 ${n.likeCount || 0} | 藏 ${n.collectCount || 0} | 评 ${n.chatCount || 0}`);
  console.log(`链接: ${n.url}`);
  console.log(`图片 (${n.imageCount} 张, 其中 live photo ${n.images.filter(i => i.isLive).length} 张):`);
  n.images.forEach((im, i) => {
    console.log(`   [${i + 1}] ${im.isLive ? '🎞 live' : '    '} ${im.url}`);
    if (im.liveVideo) console.log(`         live 视频: ${im.liveVideo}`);
  });
  console.log(`正文:\n${n.content}\n`);
  console.log(`==================== 评论 (${totalAll}) ====================`);
  if (data.comments.length === 0) { console.log("(无评论)"); return; }
  data.comments.forEach((c, i) => {
    console.log(`[#${i + 1}] ${c.author} (${c.dateLoc}) [赞:${c.likeCount}]${c.isAuthorLiked ? ' [作者赞过]' : ''}:`);
    console.log(`   ${c.content}`);
    c.subReplies.forEach((s, j) => console.log(`      ↳ [回复 ${j + 1}] ${s.author} (${s.dateLoc}) [赞:${s.likeCount}]: ${s.content}`));
    console.log("");
  });
}

main().catch((err) => { console.error("❌ 发生错误:", err.message); process.exit(1); });
