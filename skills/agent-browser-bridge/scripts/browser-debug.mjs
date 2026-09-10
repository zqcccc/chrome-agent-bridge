#!/usr/bin/env node
// 通用浏览器页面临场 debug 工具 —— 先探查、不猜类名、异常先查 DOM 再下结论
//
// 用法:
//   BRIDGE_TOKEN=xxx node browser-debug.mjs <tabId>                 # 页面概览（默认）
//   BRIDGE_TOKEN=xxx node browser-debug.mjs <tabId> --links [N]     # 列表卡片内的链接 + 可见性（防点隐藏链接）
//   BRIDGE_TOKEN=xxx node browser-debug.mjs <tabId> --media         # 图片/视频/live photo/blob
//   BRIDGE_TOKEN=xxx node browser-debug.mjs <tabId> --scroll        # 哪些元素实际可滚动（找滚动容器）
//   BRIDGE_TOKEN=xxx node browser-debug.mjs <tabId> --modal         # 弹窗详情（存在/尺寸/滚动区/评论数）
//   BRIDGE_TOKEN=xxx node browser-debug.mjs <tabId> --sel "<css>"   # dump 任意选择器匹配的元素
//   BRIDGE_TOKEN=xxx node browser-debug.mjs <tabId> --js "<expr>"   # 执行任意 JS 表达式并返回结果（快速实验）
//
// 实测踩坑（2026-09-10，写入 xhs 子 skill 的同批问题，通用化）:
//   - 列表卡片第一个 a 可能是 display:none 隐藏链接，click() 会触发风控/404；必须点可见链接
//   - 懒加载图片 naturalWidth=0，不能按 naturalWidth 过滤；用 currentSrc || src || data-src
//   - 图床 URL 参数（如 !nd_dft_wlteh_webp_3）不能去掉，去掉会 403
//   - 内嵌 JS 表达式是模板字符串：正则必须写双反斜杠 \\d（单反斜杠 \d 会被模板字符串丢弃成 d，静默失败）
//   - 滚动只滚目标容器（.note-scroller 等），绝不滚 window——否则背后页面位置被带跑

import fs from "node:fs";
import path from "node:path";

const token = process.env.BRIDGE_TOKEN;
const [, , tabIdArg, ...rest] = process.argv;
const args = { tabId: Number(tabIdArg), mode: "overview", extra: null };
for (let i = 0; i < rest.length; i++) {
  const v = rest[i];
  if (v === "--links") { args.mode = "links"; args.extra = rest[i + 1] && !rest[i + 1].startsWith("--") ? parseInt(rest[++i], 10) : 6; }
  else if (v === "--media") args.mode = "media";
  else if (v === "--scroll") args.mode = "scroll";
  else if (v === "--modal") args.mode = "modal";
  else if (v === "--sel") args.mode = "sel", args.extra = rest[++i];
  else if (v === "--js") args.mode = "js", args.extra = rest[++i];
}
if (!token || !args.tabId) {
  console.error("usage: BRIDGE_TOKEN=xxx node browser-debug.mjs <tabId> [--links N|--media|--scroll|--modal|--sel <css>|--js <expr>]");
  process.exit(1);
}

const rpc = async (method, params = {}, timeoutMs = 20000) => {
  const res = await fetch("http://127.0.0.1:8778/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, params, timeoutMs }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${method} failed: ${JSON.stringify(j.error || j)}`);
  return j.result;
};
const safeParse = (s) => { try { return JSON.parse(s); } catch { return s; } };
const evaluate = async (tabId, expression, timeoutMs = 20000) => {
  const r = await rpc("page.evaluate", { tabId, expression, awaitPromise: false }, timeoutMs);
  const val = r && r.result;
  return typeof val === "string" ? safeParse(val) : val;
};

const vis = (el) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden";
};

const EXPRS = {
  overview: `(() => {
    const mask = document.querySelector('.note-detail-mask') || document.querySelector('[class*="modal"][class*="mask"]');
    const mr = mask ? mask.getBoundingClientRect() : null;
    const cards = document.querySelectorAll('section[class*="item"], article, [class*="card"]');
    const scrollables = Array.from(document.querySelectorAll('*')).filter((el) => el.scrollHeight > el.clientHeight + 50).slice(0, 8).map((el) => ({
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 50),
      client: el.clientHeight,
      scroll: el.scrollHeight,
      top: el.scrollTop
    }));
    const searchBoxes = Array.from(document.querySelectorAll('input[type="search"], input[placeholder*="搜索"], [class*="search"] input, [class*="search-input"]')).slice(0, 3).map((el) => ({
      placeholder: el.getAttribute('placeholder') || '',
      cls: String(el.className || '').slice(0, 40)
    }));
    return {
      url: location.href.slice(0, 120),
      title: (document.title || '').slice(0, 50),
      readyState: document.readyState,
      hasModal: !!mask,
      modalVisible: mr ? (mr.width > 0 && mr.height > 0) : false,
      scrollY: window.scrollY,
      docScrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      cardCount: cards.length,
      scrollables,
      searchBoxes,
      iframes: document.querySelectorAll('iframe').length,
      bodyTextLen: (document.body.innerText || '').length
    };
  })()`,

  links: `(() => {
    const n = ${args.extra || 6};
    const cards = Array.from(document.querySelectorAll('section[class*="item"], article, [class*="card"]')).slice(0, n);
    return cards.map((c, i) => ({
      card: i,
      text: (c.innerText || '').replace(/\\s+/g, ' ').slice(0, 60),
      links: Array.from(c.querySelectorAll('a')).map((a) => ({
        href: (a.href || '').slice(0, 90),
        visible: (() => { const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(a).display !== 'none'; })(),
        cls: String(a.className || '').slice(0, 40),
        tag: a.tagName
      }))
    }));
  })()`,

  media: `(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'; };
    const imgs = Array.from(document.querySelectorAll('img')).slice(0, 20).map((img) => ({
      src: (img.currentSrc || img.src || '').slice(0, 100),
      dataSrc: img.getAttribute('data-src') ? img.getAttribute('data-src').slice(0, 100) : null,
      nw: img.naturalWidth,
      visible: vis(img),
      cls: String(img.className || '').slice(0, 30)
    }));
    const vids = Array.from(document.querySelectorAll('video')).map((v) => ({
      src: (v.src || '').slice(0, 80),
      poster: (v.poster || '').slice(0, 100),
      hasBlob: (v.src || '').startsWith('blob:')
    }));
    const blobs = Array.from(document.querySelectorAll('[src*="blob:"], [poster*="blob:"]')).map((el) => ({ tag: el.tagName, v: (el.src || el.poster || '').slice(0, 80) }));
    return { imgCount: document.querySelectorAll('img').length, imgs, vids, blobs };
  })()`,

  scroll: `(() => {
    const els = Array.from(document.querySelectorAll('*')).filter((el) => el.scrollHeight > el.clientHeight + 50);
    return els.slice(0, 15).map((el) => ({
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 60),
      id: el.id || '',
      clientH: el.clientHeight,
      scrollH: el.scrollHeight,
      top: Math.round(el.scrollTop),
      styleOverflow: getComputedStyle(el).overflowY
    }));
  })()`,

  modal: `(() => {
    const mask = document.querySelector('.note-detail-mask') || document.querySelector('[class*="modal"][class*="mask"]');
    if (!mask) return { hasModal: false };
    const r = mask.getBoundingClientRect();
    const scrollers = Array.from(mask.querySelectorAll('*')).filter((el) => el.scrollHeight > el.clientHeight + 50).slice(0, 6).map((el) => ({
      tag: el.tagName, cls: String(el.className || '').slice(0, 50), client: el.clientHeight, scroll: el.scrollHeight
    }));
    const comments = mask.querySelectorAll('[class*="comment-item"]').length;
    const title = (mask.querySelector('.title')?.innerText || '').slice(0, 50);
    const likeTxt = (mask.querySelector('.engage-bar')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 50);
    return { hasModal: true, w: Math.round(r.width), h: Math.round(r.height), title, comments, likeTxt, scrollers };
  })()`,
};

async function main() {
  const tabId = args.tabId;
  try { await rpc("tabs.prepare", { tabId }, 8000); } catch {}
  await new Promise((r) => setTimeout(r, 700));

  if (args.mode === "sel") {
    if (!args.extra) { console.error("--sel 需要 CSS 选择器参数"); process.exit(1); }
    const sel = JSON.stringify(args.extra);
    const out = await evaluate(tabId, `(() => {
      const els = Array.from(document.querySelectorAll(${sel}));
      return {
        count: els.length,
        sample: els.slice(0, 8).map((el) => ({
          tag: el.tagName,
          cls: String(el.className || '').slice(0, 50),
          id: el.id || '',
          text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 80),
          visible: (() => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })(),
          html: el.outerHTML.slice(0, 160)
        }))
      };
    })()`);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (args.mode === "js") {
    if (!args.extra) { console.error("--js 需要 JS 表达式参数"); process.exit(1); }
    const out = await evaluate(tabId, args.extra);
    console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
    return;
  }

  const expr = EXPRS[args.mode];
  if (!expr) { console.error("未知模式: " + args.mode); process.exit(1); }
  const out = await evaluate(tabId, expr);
  console.log(`== browser-debug: ${args.mode} @ tab ${tabId} ==`);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => { console.error("❌ 错误:", err.message); process.exit(1); });
