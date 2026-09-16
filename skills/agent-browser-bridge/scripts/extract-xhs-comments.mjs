#!/usr/bin/env node
/**
 * extract-xhs-comments.mjs
 * 
 * 专门用于小红书（Xiaohongshu / RED）笔记与评论区深度采集的自动化脚本：
 * 1. 自动定位小红书标签页（或接收指定 tabId）
 * 2. 检查页面状态（404 / 登录受限自动阻断并提示）
 * 3. 智能识别当前页面类型：
 *    - 若在搜索列表页且未进入笔记，可指定 `--card <index>` 打开对应笔记详情
 *    - 若在笔记详情页，直接采集
 * 4. 循环平滑滚动评论区容器（.note-scroller / 页面），触发流式加载，直到一级评论彻底到底
 * 5. 递归查找并点击所有“展开 X 条回复”/“展开更多回复”/“...展开”按钮，将全部二级楼中楼与长文本展开（带已点击防重标记）
 * 6. 提取结构化笔记正文与完整评论树（包含标题、正文、作者、一级评论、二级回复、点赞数、发布时间与属地）
 * 
 * 用法:
 *   node extract-xhs-comments.mjs [tabId] [选项]
 * 
 * 选项:
 *   --max-scrolls <n>   评论区向下滚动的最大轮数 (默认: 30)
 *   --card <n>          若当前在搜索结果页，自动点击第 n 张卡片打开详情 (默认: 0)
 *   --out <file.json>   将完整提取数据导出为 JSON 文件
 *   --format <type>     输出格式: text (默认，格式化摘要与评论树) | json
 *   --help, -h          显示帮助
 */

import fs from "node:fs";
import path from "node:path";

function getToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN.trim();
  const tokenFile = path.join(process.env.HOME || "", ".chrome-agent-bridge", "token");
  if (fs.existsSync(tokenFile)) {
    return fs.readFileSync(tokenFile, "utf8").trim();
  }
  return null;
}

const token = getToken();
if (!token) {
  console.error("❌ 找不到 BRIDGE_TOKEN，请先启动 host 或确保 ~/.chrome-agent-bridge/token 存在。");
  process.exit(1);
}

const args = process.argv.slice(2);
let tabId = null;
let maxScrolls = 30;
let cardIndex = null;
let outFile = null;
let format = "text";

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") {
    console.log(`用法:
  node extract-xhs-comments.mjs [tabId] [选项]

选项:
  --max-scrolls <n>   评论区向下滚动的最大轮数 (默认: 30)
  --card <n>          若在搜索列表页，自动点击第 n 张卡片打开笔记详情 (从 0 开始)
  --out <file.json>   将完整提取数据导出为 JSON 文件
  --format <type>     输出格式: text (默认，格式化树状输出) | json
  --help, -h          显示帮助信息
`);
    process.exit(0);
  } else if (arg === "--max-scrolls" && args[i + 1]) {
    maxScrolls = parseInt(args[++i], 10) || 30;
  } else if (arg === "--card" && args[i + 1]) {
    cardIndex = parseInt(args[++i], 10);
  } else if (arg === "--out" && args[i + 1]) {
    outFile = args[++i];
  } else if (arg === "--format" && args[i + 1]) {
    format = args[++i];
  } else if (!tabId && !arg.startsWith("--")) {
    tabId = parseInt(arg, 10);
  }
}

const AGENT_ID = process.env.AGENT_ID || `xhs-crawler-${process.pid}`;
const AGENT_NAME = process.env.AGENT_NAME || "小红书采集";

async function rpc(method, params = {}, timeoutMs = 30000) {
  const res = await fetch("http://127.0.0.1:8778/rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Agent-Id": AGENT_ID,
      "X-Agent-Name": encodeURIComponent(AGENT_NAME),
    },
    body: JSON.stringify({ method, params, timeoutMs })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt}`);
  }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`RPC [${data.error?.code || "ERROR"}]: ${data.error?.message || "未知错误"}`);
  }
  return data.result;
}

async function evaluate(targetTabId, expression, awaitPromise = false) {
  const result = await rpc("page.evaluate", {
    tabId: targetTabId,
    expression,
    awaitPromise
  }, 35000);
  let val = result?.result;
  if (typeof val === "string") {
    try {
      val = JSON.parse(val);
    } catch {
      // 保留原始
    }
  }
  return val;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function resolveTargetTab() {
  if (tabId) return tabId;
  const res = await rpc("tabs.list");
  const tabs = Array.isArray(res) ? res : (res?.tabs || []);
  // 只复用「用户没在看」的同类 tab：活动 tab 是用户正在浏览的页面，不能拿来 navigate。
  // 没有可用候选时交给 tabs.resolve 静默新开后台 tab。
  const xhsTab = tabs.find(t => t.url && t.url.includes("xiaohongshu.com") && !t.active);
  if (xhsTab) return xhsTab.id;
  const r = await rpc("tabs.resolve", { url: "https://www.xiaohongshu.com/explore" }, 45000);
  if (r && r.tabId) return r.tabId;
  throw new Error("未找到任何可用 Chrome 标签页");
}

async function main() {
  const targetTabId = await resolveTargetTab();
  console.log(`🔍 正在连接小红书标签页 #${targetTabId}...`);

  try {
    await rpc("tabs.prepare", { tabId: targetTabId });
  } catch (e) {}

  // 1. 检查页面状态及类型
  const checkStatusExpr = `(() => {
    const url = location.href;
    const title = document.title || '';
    if (url.includes('/404') || title.includes("你访问的页面不见了") || title.includes("Sorry")) {
      return { ok: false, reason: '404_OR_LOGIN_REQUIRED', url, title };
    }
    if (url.includes('website-login/captcha') || url.includes('/captcha') || /security\\s*verification|captcha|安全验证|人机验证/i.test(title)) {
      return { ok: false, reason: 'CAPTCHA_BLOCKED', url, title };
    }
    const hasNoteDetail = !!(document.querySelector('.note-scroller, .note-container, .note-detail-mask, .interaction-container') && document.querySelector('.comment-item, [class*="comment-item"], .interact-container'));
    const isSearchList = url.includes('/search_result') || !!document.querySelector('.search-layout, .feeds-container');
    const cards = Array.from(document.querySelectorAll('section.note-item, .search-card, [class*="note-item"]'));

    return {
      ok: true,
      url,
      title,
      hasNoteDetail,
      isSearchList,
      cardCount: cards.length
    };
  })()`;

  let status = await evaluate(targetTabId, checkStatusExpr);
  if (!status || !status.ok) {
    if (status?.reason === 'CAPTCHA_BLOCKED') {
      console.error(`⛔ 小红书触发安全验证（验证码页），已停止：${status.url}`);
      console.error(`请勿重试或继续请求。等待用户手动完成验证码、风控解除后再继续。`);
      process.exit(1);
    }
    console.error(`⚠️ 小红书页面受限或处于 404: ${status?.reason || "访问受限"} (URL: ${status?.url})`);
    console.error(`提示: 小红书笔记需要登录态或访问有效链接。请在 Chrome 中确认已登录小红书账号后再继续。`);
    process.exit(1);
  }

  // 若处于搜索列表页且未打开详情，根据用户配置或默认打开卡片
  if (!status.hasNoteDetail && status.isSearchList) {
    const targetIdx = cardIndex !== null ? cardIndex : 0;
    console.log(`📑 检测到当前位于搜索列表页，正在打开第 ${targetIdx} 张笔记详情...`);
    const clickCardExpr = `(() => {
      const cards = Array.from(document.querySelectorAll('section.note-item, .search-card, [class*="note-item"]'));
      const card = cards[${targetIdx}];
      if (!card) return { ok: false, reason: 'card_not_found', count: cards.length };
      const clickTarget = card.querySelector('a.cover, .cover, a, img') || card;
      clickTarget.click();
      return { ok: true, cardTitle: card.innerText.slice(0, 40) };
    })()`;

    const clickRes = await evaluate(targetTabId, clickCardExpr);
    if (!clickRes || !clickRes.ok) {
      console.error(`❌ 打开笔记卡片失败: ${clickRes?.reason || "未知"}`);
      process.exit(1);
    }
    await sleep(2000);
    status = await evaluate(targetTabId, checkStatusExpr);
  }

  console.log(`📌 目标页面: ${status.title}`);
  console.log(`⏳ 开始全量滚动加载一级评论 (最大滚动轮数: ${maxScrolls})...`);

  // 2. 循环向下平滑滚动评论区容器
  //    只滚动详情弹窗内右侧滚动区（.note-scroller），绝不滚动 window——
  //    否则弹窗背后的列表页滚动位置会被带跑，关闭弹窗后列表位置就变了
  let lastCount = 0;
  let sameCountRounds = 0;

  for (let round = 1; round <= maxScrolls; round++) {
    const scrollStepExpr = `(() => {
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
      if (scroller) {
        scroller.scrollTop = scroller.scrollHeight;
      }
      return {
        count: beforeCount,
        scrollHeight: scroller ? scroller.scrollHeight : 0,
        scrollTop: scroller ? scroller.scrollTop : 0
      };
    })()`;

    const scrollResult = await evaluate(targetTabId, scrollStepExpr);
    const count = scrollResult?.count || 0;

    if (count === lastCount) {
      sameCountRounds++;
    } else {
      sameCountRounds = 0;
      lastCount = count;
    }

    process.stdout.write(`\r   [第 ${round}/${maxScrolls} 轮滚动] 当前已加载一级评论: ${count} 条...`);

    if (sameCountRounds >= 4 && round >= 3) {
      console.log(`\n   ✓ 评论列表已触底（连续多次无新增评论）。`);
      break;
    }

    await sleep(650);
  }
  console.log("");

  // 3. 递归展开所有二级回复与长文本折叠按钮
  console.log(`⏳ 正在扫描并展开所有二级回复（楼中楼）与长文本...`);
  let totalExpanded = 0;
  for (let expandPass = 1; expandPass <= 6; expandPass++) {
    const expandExpr = `(() => {
      const expandCandidates = Array.from(document.querySelectorAll('*')).filter(el => {
        if (el.children.length > 2) return false;
        if (el.getAttribute('data-agent-expanded') === 'true') return false;
        const txt = (el.innerText || '').trim();
        if (!txt) return false;
        const isShowMore = el.classList?.contains('show-more') ||
                           el.classList?.contains('expand-btn') ||
                           el.parentElement?.classList?.contains('reply-container') ||
                           el.parentElement?.classList?.contains('show-more') ||
                           txt.includes('展开') ||
                           txt.includes('条回复') ||
                           txt === '...展开';
        const isClose = txt.includes('收起');
        return isShowMore && !isClose;
      });

      let clicked = 0;
      for (const btn of expandCandidates) {
        try {
          btn.setAttribute('data-agent-expanded', 'true');
          btn.click();
          clicked++;
        } catch (e) {}
      }
      return { clicked, remaining: expandCandidates.length };
    })()`;

    const expResult = await evaluate(targetTabId, expandExpr);
    const clicked = expResult?.clicked || 0;
    if (clicked > 0) {
      totalExpanded += clicked;
      console.log(`   [第 ${expandPass} 轮展开] 点击展开了 ${clicked} 处折叠回复/内容...`);
      await sleep(600);
    } else {
      break;
    }
  }
  console.log(`   ✓ 折叠内容已全部展开完毕（共触发 ${totalExpanded} 次展开操作）。`);

  // 4. 提取笔记与全部评论的完整结构化数据
  console.log(`⏳ 正在提取笔记元数据与评论树...`);
  const extractExpr = `(() => {
    // 笔记基本信息
    const noteScope = document.querySelector('.note-container, .note-detail-mask, .interaction-container, .note-scroller') || document;
    const titleEl = noteScope.querySelector('#detail-title, .title, [class*="title"]') || document.querySelector('#detail-title, .title');
    const descEl = noteScope.querySelector('#detail-desc, .desc, [class*="desc"], .note-text') || document.querySelector('#detail-desc, .desc');
    const authorEl = noteScope.querySelector('.author-container .name, .username, .author .name, [class*="author"] [class*="name"]');
    const noteDateEl = noteScope.querySelector('.date, .bottom-info .date, [class*="bottom-info"]');
    const noteLikeEl = noteScope.querySelector('.interact-container .like-wrapper, .like-wrapper, [class*="like-wrapper"]');
    const noteCollectEl = noteScope.querySelector('.interact-container .collect-wrapper, .collect-wrapper, [class*="collect-wrapper"]');
    const noteChatEl = noteScope.querySelector('.interact-container .chat-wrapper, .chat-wrapper, [class*="chat-wrapper"]');

    const rawTitle = titleEl ? titleEl.innerText.trim() : document.title.replace(/\\s*-\\s*小红书.*$/, '');
    const noteInfo = {
      title: rawTitle || document.title.replace(/\\s*-\\s*小红书.*$/, ''),
      author: authorEl ? authorEl.innerText.trim() : '未知作者',
      publishInfo: noteDateEl ? noteDateEl.innerText.replace(/\\s+/g, ' ').trim() : '',
      likeCount: noteLikeEl ? (noteLikeEl.querySelector('.count')?.innerText || noteLikeEl.innerText).trim() : '',
      collectCount: noteCollectEl ? (noteCollectEl.querySelector('.count')?.innerText || noteCollectEl.innerText).trim() : '',
      chatCount: noteChatEl ? (noteChatEl.querySelector('.count')?.innerText || noteChatEl.innerText).trim() : '',
      content: descEl ? descEl.innerText.trim() : '',
      url: location.href
    };

    // 评论提取：小红书一级楼层通常为 .parent-comment，内含主评论 .comment-item 与楼中楼 .reply-container
    let parentNodes = Array.from(noteScope.querySelectorAll('.parent-comment'));
    // 兼容回退：若无 .parent-comment 则寻找顶层 .comment-item
    if (parentNodes.length === 0) {
      parentNodes = Array.from(noteScope.querySelectorAll('.comment-item')).filter(el => !el.classList.contains('comment-item-sub') && !el.closest('.reply-container'));
    }

    const comments = [];

    function formatCount(val) {
      if (!val || val === '赞' || val === '回复') return '0';
      return String(val).trim();
    }

    function cleanDateLoc(node) {
      const dateEl = node.querySelector('.info .date, .date, [class*="info"] .date');
      const locEl = node.querySelector('.info .location, .location, [class*="location"]');
      const dTxt = dateEl?.innerText?.trim() || '';
      const lTxt = locEl?.innerText?.trim() || '';
      if (dTxt && lTxt && !dTxt.includes(lTxt)) return dTxt + " " + lTxt;
      return dTxt || lTxt || node.querySelector('.info')?.innerText?.replace(/\\s+/g, ' ').trim() || '';
    }

    for (const node of parentNodes) {
      const mainItem = node.classList.contains('parent-comment')
        ? (node.querySelector('.comment-item:not(.comment-item-sub)') || node)
        : node;

      const author = mainItem.querySelector('.author .name, .name, [class*="name"]')?.innerText?.trim() || '匿名用户';
      const content = mainItem.querySelector('.content .note-text, .note-text, .content, [class*="content"]')?.innerText?.trim() || '';
      const dateLoc = cleanDateLoc(mainItem);
      
      const likeRaw = mainItem.querySelector('.interactions .like .count, .like-wrapper .count')?.innerText ||
                      mainItem.querySelector('.interactions .like')?.innerText || '0';
      const likeCount = formatCount(likeRaw);
      
      const isAuthorLiked = !!mainItem.querySelector('[class*="author-like"]');

      // 提取该一级评论下的所有二级回复（楼中楼）
      const subCommentNodes = Array.from(node.querySelectorAll('.comment-item-sub, .sub-comment-item, [class*="comment-item-sub"], [class*="sub-comment"]'));
      const subReplies = [];

      for (const sub of subCommentNodes) {
        const subAuthor = sub.querySelector('.author .name, .name, [class*="name"]')?.innerText?.trim() || '匿名用户';
        const subContent = sub.querySelector('.content .note-text, .note-text, .content, [class*="content"]')?.innerText?.trim() || '';
        const subDateLoc = cleanDateLoc(sub);
        const subLikeRaw = sub.querySelector('.interactions .like .count, .like-wrapper .count')?.innerText ||
                           sub.querySelector('.interactions .like')?.innerText || '0';
        const subLike = formatCount(subLikeRaw);

        if (subContent) {
          subReplies.push({
            author: subAuthor,
            content: subContent,
            dateLoc: subDateLoc,
            likeCount: subLike
          });
        }
      }

      if (content) {
        comments.push({
          author,
          content,
          dateLoc,
          likeCount,
          isAuthorLiked,
          subRepliesCount: subReplies.length,
          subReplies
        });
      }
    }

    return {
      note: noteInfo,
      totalParentComments: comments.length,
      totalSubComments: comments.reduce((acc, cur) => acc + cur.subReplies.length, 0),
      comments
    };
  })()`;

  const data = await evaluate(targetTabId, extractExpr);
  if (!data || !data.comments) {
    console.error("❌ 提取评论失败，未能获取到评论数据。");
    process.exit(1);
  }

  const totalAll = data.totalParentComments + data.totalSubComments;
  console.log(`🎉 成功搜集全部评论！一级评论: ${data.totalParentComments} 条，二级回复: ${data.totalSubComments} 条，共计: ${totalAll} 条。\n`);

  if (outFile) {
    const resolvedPath = path.resolve(process.cwd(), outFile);
    fs.writeFileSync(resolvedPath, JSON.stringify(data, null, 2), "utf8");
    console.log(`💾 完整评论数据已保存至: ${resolvedPath}\n`);
  }

  if (format === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // 格式化文本输出
  console.log(`==================== 笔记详情 ====================`);
  console.log(`标题: ${data.note.title}`);
  console.log(`作者: ${data.note.author} | 发布/属地: ${data.note.publishInfo}`);
  console.log(`互动: 点赞 ${data.note.likeCount || 0} | 收藏 ${data.note.collectCount || 0} | 评论 ${data.note.chatCount || 0}`);
  console.log(`链接: ${data.note.url}`);
  console.log(`正文:\n${data.note.content}\n`);
  console.log(`==================== 全部评论列表 (${totalAll}条) ====================`);

  if (data.comments.length === 0) {
    console.log("(该笔记暂无评论)");
    return;
  }

  data.comments.forEach((c, i) => {
    const authorLikedTag = c.isAuthorLiked ? " [作者赞过]" : "";
    console.log(`[#${i + 1}] ${c.author} (${c.dateLoc}) [赞:${c.likeCount}]${authorLikedTag}:`);
    console.log(`   ${c.content}`);
    if (c.subReplies && c.subReplies.length > 0) {
      c.subReplies.forEach((sub, j) => {
        console.log(`      ↳ [回复 ${j + 1}] ${sub.author} (${sub.dateLoc}) [赞:${sub.likeCount}]: ${sub.content}`);
      });
    }
    console.log("");
  });
}

main().catch(err => {
  console.error("❌ 发生错误:", err.message);
  process.exit(1);
});
