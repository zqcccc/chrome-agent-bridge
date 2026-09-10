#!/usr/bin/env node
// 小红书「问点点」（搜索页 AI 功能）—— 搜索 → 进入问点点 → 等 AI 回答完毕 → 返回完整输出
// 部分搜索结果页带「问点点」频道（新版 AI 搜索页 /search_result_ai 或 /ai_chat_tab），
// 本脚本在 AI 回答完成后把它的输出（markdown 全文 + 总结标题 + 引用笔记数）取回。
//
// 用法:
//   BRIDGE_TOKEN=xxx node xhs-ask-diandian.mjs <tabId> "<问题关键词>" [--wait 秒] [--out file] [--format text|json|markdown]
//     --wait      最大等待 AI 回答完成秒数（默认 90）
//     --out       保存完整回答 JSON/文本到文件
//     --format    输出格式：text（默认，可读）/ json / markdown（纯回答正文）
//  前置: 根 SKILL.md 的桥已就绪；目标 tab 是小红书页面（任意页均可，脚本会自动导航）
//
// 实测结构（2026-09-10 验证）:
//   - 新版 AI 搜索页频道：.channel-scroll-container-ai 内 #ask_diandian（文本「问点点」+ ai 角标），点击后跳转 /ai_chat_tab?conversationId=...
//   - 用户问题：.xhs-ai-chat-page .user-message__text
//   - AI 回答容器：.ai-message（生成中）→ .ai-message.ai-message-finished（回答完成）
//   - 回答正文：.xhs-ai-md-container .markdown-block —— data-original-text 属性是完整 markdown 原文，innerText 是渲染文本
//   - 总结标题：.progress-wrapper .progress-text（如「ai总结67篇笔记生成」）；data-has-reference 表示带引用笔记
//   - 追问输入框：textarea.textarea--v1-caret（placeholder「搜索或者输入任何问题」），Enter 或 .bottom-box-right-submit-button 发送
//   - 风控注意：回答生成耗时随笔记量变化；若页面出现验证码/安全验证立即停止，不要重试
import fs from "node:fs";
import path from "node:path";

const token = process.env.BRIDGE_TOKEN;
const [, , tabIdArg, keywordArg, ...rest] = process.argv;
let waitSec = 90;
let out = null;
let format = "text";
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--wait") waitSec = parseInt(rest[++i], 10) || 90;
  else if (rest[i] === "--out") out = rest[++i];
  else if (rest[i] === "--format") format = rest[++i];
}
const tabId = Number(tabIdArg);
if (!token || !tabId || !keywordArg) {
  console.error('usage: BRIDGE_TOKEN=xxx node xhs-ask-diandian.mjs <tabId> "<问题关键词>" [--wait 90] [--out file] [--format text|json|markdown]');
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

const STATUS_EXPR = `(() => {
  const url = location.href, title = document.title || '';
  if (url.includes('/404') || title.includes('你访问的页面不见了') || title.includes('Sorry')) return { ok: false, reason: '404' };
  if (url.includes('website-login/captcha') || /security\\s*verification|captcha|安全验证|人机验证/i.test(title)) return { ok: false, reason: 'CAPTCHA_BLOCKED' };
  const askBtn = document.querySelector('.channel-scroll-container-ai #ask_diandian');
  const isChat = !!document.querySelector('.xhs-ai-chat-page');
  return { ok: true, isChat, hasAskChannel: !!askBtn, url: url.slice(0, 90) };
})()`;

// 读取当前聊天页的 AI 回答（未完成返回 null）
const READ_ANSWER_EXPR = `(() => {
  const done = document.querySelector('.ai-message.ai-message-finished');
  const generating = document.querySelector('.ai-message:not(.ai-message-finished)');
  const questionEl = document.querySelector('.user-message__text');
  const block = document.querySelector('.xhs-ai-md-container .markdown-block');
  const progress = document.querySelector('.progress-wrapper');
  const header = document.querySelector('.progress-text');
  return {
    finished: !!done,
    generating: !!generating && !done,
    question: questionEl ? questionEl.innerText.trim() : '',
    header: header ? header.innerText.trim() : '',
    hasReference: progress ? progress.getAttribute('data-has-reference') === 'true' : false,
    markdown: block ? (block.getAttribute('data-original-text') || '') : '',
    text: block ? block.innerText.trim() : (done ? done.innerText.trim() : '')
  };
})()`;

async function main() {
  // 0. 激活标签页
  try { await rpc("tabs.activate", { tabId }, 15000); } catch {}

  // 1. 状态检查
  let st = await evaluate(STATUS_EXPR);
  if (!st || !st.ok) {
    console.error(st?.reason === 'CAPTCHA_BLOCKED'
      ? '⛔ 小红书触发安全验证，已停止。请等待用户手动完成验证后再试，不要重试。'
      : `⚠️ 页面受限(404/登录): ${st && st.url}`);
    process.exit(1);
  }
  console.error(`📄 当前页面: ${st.url} ${st.isChat ? '[问点点对话页]' : (st.hasAskChannel ? '[AI 搜索页，有待点开的问点点]' : '[普通页面，需导航]')}`);

  // 2. 进入问点点：已在对话页跳过；AI 搜索页点 #ask_diandian；否则导航到 search_result_ai 再点
  if (!st.isChat) {
    if (!st.hasAskChannel) {
      const url = "https://www.xiaohongshu.com/search_result_ai?keyword=" + encodeURIComponent(keywordArg);
      console.error(`🧭 导航到 AI 搜索页: ${url.slice(0, 100)}...`);
      await rpc("page.navigate", { tabId, url }, 30000);
      await sleep(4000);
      // 导航后等待问点点频道出现
      let waited = 0;
      while (waited < 20000) {
        const chk = await evaluate(`(() => !!document.querySelector('.channel-scroll-container-ai #ask_diandian'))()`);
        if (chk) break;
        await sleep(1500); waited += 1500;
      }
    }
    const ck = await evaluate(`(() => {
      const btn = document.querySelector('.channel-scroll-container-ai #ask_diandian');
      if (!btn) return { ok: false, reason: '未找到问点点频道' };
      const r = btn.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return { ok: false, reason: '问点点频道不可见' };
      btn.click();
      return { ok: true };
    })()`);
    if (!ck || !ck.ok) {
      console.error(`❌ 进入问点点失败: ${ck && ck.reason}`);
      process.exit(1);
    }
    console.error('💬 已点击「问点点」，等待 AI 回答...');
    await sleep(2500);
  }

  // 3. 轮询等待回答完成（.ai-message-finished）
  const deadline = Date.now() + waitSec * 1000;
  let answer = null;
  while (Date.now() < deadline) {
    answer = await evaluate(READ_ANSWER_EXPR);
    if (answer && answer.finished && (answer.markdown || answer.text)) {
      console.error(`✅ AI 回答完成（${answer.header || '未标注'}${answer.hasReference ? '，带引用笔记' : ''}）`);
      break;
    }
    if (answer && answer.generating) process.stdout.write("\r   ⏳ AI 生成中...");
    else if (!answer || (!answer.finished && !answer.generating)) process.stdout.write("\r   ⏳ 等待进入回答状态...");
    await sleep(2000);
  }
  process.stdout.write("\n");
  if (!answer || !(answer.finished && (answer.markdown || answer.text))) {
    console.error(`❌ 等待 ${waitSec}s 后 AI 回答仍未完成。可能原因：回答较长、页面风控或关键词无结果。可增大 --wait 后重试（但若见验证码页请停止）。`);
    process.exit(1);
  }

  // 4. 组装输出
  const result = {
    question: answer.question || keywordArg,
    header: answer.header,
    hasReference: answer.hasReference,
    answerText: answer.text,
    answerMarkdown: answer.markdown || answer.text,
    url: (await evaluate(`location.href`)) || "",
  };
  if (out) {
    const p = path.resolve(process.cwd(), out);
    fs.writeFileSync(p, JSON.stringify(result, null, 2), "utf8");
    console.error(`💾 已保存至: ${p}`);
  }
  if (format === "json") { console.log(JSON.stringify(result, null, 2)); return; }
  if (format === "markdown") { console.log(result.answerMarkdown); return; }
  console.log(`\n==================== 问点点 ====================`);
  console.log(`问题: ${result.question}`);
  console.log(`标题: ${result.header}`);
  console.log(`------------------------------------------------`);
  console.log(result.answerText);
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
