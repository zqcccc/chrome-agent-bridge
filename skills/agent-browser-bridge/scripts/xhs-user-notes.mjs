#!/usr/bin/env node
// 小红书用户主页全部笔记拉取（示例脚本）—— 用户信息 + 全部笔记列表（ID/标题/封面/点赞/链接），不新开标签页
// 适用于已打开某用户主页（/user/profile/<uid>）的 tab；会滚动加载更多笔记并检测是否被页面截断。
//
// 用法:
//   BRIDGE_TOKEN=xxx node xhs-user-notes.mjs <tabId> [--max-scrolls N] [--out notes.json] [--format text|json]
//     --max-scrolls 最大滚动轮数（默认 30）
//     --out         保存 JSON 到文件
//     --format      默认 text 可读输出；json 输出结构化数据
//  前置: 根 SKILL.md 的桥已就绪；目标 tab 是小红书用户主页
//
// 实测结构（2026-09-10 验证，新版 AI 布局主页）:
//   - 用户信息：.info（昵称/小红书号/IP/简介），.data-info 内 .count+.shows 成对（关注/粉丝/获赞与收藏）
//   - 笔记总数：.tertiary .reds-tab-item 的「笔记・N」计数
//   - 笔记卡片：.feeds-container .note-item（带 data-note-id）
//     - 标题 .footer .title / 作者 .author-wrapper .name / 点赞 .like-wrapper .count（无数字时为占位「赞」= 0）
//     - 封面 a.cover.mask.ld img；卡片里第一个 a[href*="/explore/"] 是 display:none 隐藏链接（只读，不点）
//   - ⚠️ 注意：「笔记・N」计数 chip 是「收藏」子分类数（与「文件・0」同排），不是本人笔记总数，
//     不要用它判断本人笔记是否抓全；已加载条数以 .feeds-container .note-item 为准。
//   - 需要逐条详情时，用笔记 ID 配 xhs-note-full.mjs 抓取。
import fs from "node:fs";
import path from "node:path";

const token = process.env.BRIDGE_TOKEN;
const [, , tabIdArg, ...rest] = process.argv;
let maxScrolls = 30;
let out = null;
let format = "text";
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--max-scrolls") maxScrolls = parseInt(rest[++i], 10) || 30;
  else if (rest[i] === "--out") out = rest[++i];
  else if (rest[i] === "--format") format = rest[++i];
}
const tabId = Number(tabIdArg);
if (!token || !tabId) {
  console.error('usage: BRIDGE_TOKEN=xxx node xhs-user-notes.mjs <tabId> [--max-scrolls N] [--out notes.json] [--format text|json]');
  process.exit(1);
}

const rpc = async (method, params = {}, timeoutMs = 30000) => {
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
const evaluate = async (expression, timeoutMs = 30000) => {
  const r = await rpc("page.evaluate", { tabId, expression, awaitPromise: false }, timeoutMs);
  const val = r && r.result;
  return typeof val === "string" ? safeParse(val) : val;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 用户信息 + 已加载数
const SNAPSHOT_EXPR = `(() => {
  const infoEl = document.querySelector('.info');
  const dataInfo = document.querySelector('.data-info');
  const counts = {};
  if (dataInfo) {
    const pairs = Array.from(dataInfo.querySelectorAll('*')).filter(el => el.children.length === 0 && el.innerText && el.innerText.trim());
    for (let i = 0; i < pairs.length - 1; i++) {
      const cur = pairs[i].innerText.trim();
      const next = pairs[i + 1].innerText.trim();
      if (/^\\d+([.，,]?\\d+)?[kKwW万]?$/.test(cur) && /^(关注|粉丝|获赞与收藏|获赞|收藏)$/.test(next)) {
        counts[next] = cur;
        i++;
      }
    }
  }
  const infoText = infoEl ? infoEl.innerText.trim().split('\\n').map(s => s.trim()).filter(Boolean) : [];
  const loaded = document.querySelectorAll('.feeds-container .note-item').length;
  return {
    infoText,
    counts,
    loaded,
    isProfile: !!infoEl && /user\\/profile/.test(location.href)
  };
})()`;

// 滚动一轮（window + 可能的内层滚动容器），返回当前已加载数
const SCROLL_EXPR = `(() => {
  const de = document.documentElement;
  window.scrollTo(0, de.scrollHeight);
  window.dispatchEvent(new Event('scroll'));
  const feed = document.querySelector('.feeds-container');
  if (feed) {
    const inner = Array.from(feed.querySelectorAll('*')).find(el => el.scrollHeight > el.clientHeight + 150 && el.clientHeight > 200 && getComputedStyle(el).overflowY !== 'hidden');
    if (inner) inner.scrollTop = inner.scrollHeight;
  }
  return { loaded: document.querySelectorAll('.feeds-container .note-item').length, y: window.scrollY, deSh: de.scrollHeight };
})()`;

// 提取全部笔记卡片
const EXTRACT_EXPR = `(() => {
  const cards = Array.from(document.querySelectorAll('.feeds-container .note-item'));
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'; };
  return cards.map((c) => {
    const coverLink = Array.from(c.querySelectorAll('a')).find(x => vis(x) && (x.classList.contains('cover') || /cover|mask|ld/.test(x.className)));
    const coverImg = coverLink ? coverLink.querySelector('img') : null;
    const title = c.querySelector('.footer .title, .title');
    const author = c.querySelector('.author-wrapper .name');
    const likeEl = c.querySelector('.like-wrapper .count, .like-wrapper');
    const likeTxt = likeEl ? likeEl.innerText.trim() : '';
    const likeNum = /^\\d+([.，,]?\\d+)?[kKwW万]?$/.test(likeTxt) ? likeTxt : '0';
    return {
      noteId: c.getAttribute('data-note-id') || '',
      title: title ? title.innerText.trim() : '',
      author: author ? author.innerText.trim() : '',
      likeCount: likeNum,
      cover: coverImg ? (coverImg.currentSrc || coverImg.src || '') : '',
      url: coverLink ? coverLink.href.split('&amp;')[0] : ''
    };
  }).filter(x => x.noteId || x.title);
})()`;

async function main() {
  // 0. 激活标签页
  try { await rpc("tabs.activate", { tabId }, 15000); } catch {}

  // 1. 状态检查：验证码/404 立即停止；确认是用户主页
  const st = await evaluate(`(() => {
    const url = location.href, title = document.title || '';
    if (url.includes('/404') || title.includes('你访问的页面不见了') || title.includes('Sorry')) return { ok: false, reason: '404' };
    if (url.includes('website-login/captcha') || /security\\s*verification|captcha|安全验证|人机验证/i.test(title)) return { ok: false, reason: 'CAPTCHA_BLOCKED' };
    return { ok: true, url: url.slice(0, 100) };
  })()`);
  if (!st || !st.ok) {
    console.error(st?.reason === 'CAPTCHA_BLOCKED'
      ? '⛔ 小红书触发安全验证，已停止。请等待用户手动完成验证后再试，不要重试。'
      : `⚠️ 页面受限(404/登录): ${st && st.url}`);
    process.exit(1);
  }
  let snap = await evaluate(SNAPSHOT_EXPR);
  if (!snap || !snap.isProfile) {
    console.error(`⚠️ 当前页面不是小红书用户主页（URL: ${st.url}）。请先打开用户主页再运行。`);
    process.exit(1);
  }
  console.error(`👤 用户: ${snap.infoText[0] || '未知'} | 关注 ${snap.counts['关注'] || '-'} | 粉丝 ${snap.counts['粉丝'] || '-'} | ${snap.counts['获赞与收藏'] ? '获赞与收藏 ' + snap.counts['获赞与收藏'] : ''}`);
  console.error(`   简介: ${snap.infoText.slice(1, 4).join(' / ') || '(空)'}`);

  // 2. 滚动加载更多
  let prev = snap.loaded || 0;
  let sameRounds = 0;
  for (let round = 1; round <= maxScrolls; round++) {
    const sc = await evaluate(SCROLL_EXPR);
    const cur = sc && sc.loaded != null ? sc.loaded : 0;
    process.stdout.write(`\r   [第 ${round}/${maxScrolls} 轮滚动] 已加载 ${cur} 条笔记...`);
    if (cur === prev) sameRounds++; else { sameRounds = 0; prev = cur; }
    if (sameRounds >= 5 && round >= 5) {
      console.log("\n   ✓ 滚动不再增长，视为已加载全部可见笔记。");
      break;
    }
    await sleep(900);
  }
  console.log("");

  // 3. 提取笔记列表
  const notes = await evaluate(EXTRACT_EXPR);
  console.error(`📚 提取到 ${notes.length} 条笔记。`);

  const result = {
    profile: {
      name: snap.infoText[0] || '',
      infoLines: snap.infoText,
      counts: snap.counts,
      url: (await evaluate(`location.href`)).split('?')[0] || ""
    },
    noteCount: notes.length,
    notes
  };
  if (out) {
    const p = path.resolve(process.cwd(), out);
    fs.writeFileSync(p, JSON.stringify(result, null, 2), "utf8");
    console.log(`💾 已保存至: ${p}`);
  }
  if (format === "json") { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`\n==================== 用户 ${result.profile.name} ====================`);
  console.log(`关注 ${result.profile.counts['关注'] || '-'} | 粉丝 ${result.profile.counts['粉丝'] || '-'} | ${result.profile.counts['获赞与收藏'] ? '获赞与收藏 ' + result.profile.counts['获赞与收藏'] : ''} | 已拉取 ${notes.length} 条笔记`);
  console.log(`主页: ${result.profile.url}`);
  console.log(`\n==================== 笔记 (${notes.length}) ====================`);
  notes.forEach((n, i) => {
    console.log(`[#${i + 1}] ${n.title}  (赞 ${n.likeCount})`);
    console.log(`    ID: ${n.noteId}`);
    if (n.cover) console.log(`    封面: ${n.cover.slice(0, 100)}`);
    if (n.url) console.log(`    链接: ${n.url}`);
  });
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
