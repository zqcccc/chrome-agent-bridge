#!/usr/bin/env node
// BOSS 直聘聊天页：向当前选中会话发送一条消息并验证送达
// 提取自独立 skill boss-zhipin-apply，作为 agent-browser-bridge 的 BOSS 直聘子技能资产（见 boss/SKILL.md）。
// 用法: BRIDGE_TOKEN=xxx node boss-send-chat.mjs <tabId> "<text>"
// 前置: 已通过「立即沟通」进入聊天页且目标会话处于 selected 状态
//
// 设计：
//  - 写入输入框 → 轮询发送按钮可用 → 只点击一次（不可逆动作不自动重发）
//  - 验证：在当前 selected 会话内定位 .message-item.item-myself 本人气泡，
//    用精确发送文本匹配，再在同气泡/父级检查“送达|已读”。
//  - UNKNOWN（RPC 超时或暂未渲染）：先只读核对当前会话 DOM；确认已存在且已送达则视为成功；
//    确认不存在且输入框为空/会话匹配才允许人工补发。
//  - 平台拦截文案检测。
//
// 退出码：0=sent(已送达/已读); 1=verify failed(UNKNOWN/未发出/输入未清); 2=blocked(平台拦截)

const token = process.env.BRIDGE_TOKEN;
// 同一批次的多个 boss-send-chat 进程必须共享同一个 AGENT_ID；并行 Agent 请显式设置唯一值。
const agentId = process.env.AGENT_ID || "boss-send";
const agentName = process.env.AGENT_NAME || "BOSS直聘投递";
const tabId = parseInt(process.argv[2], 10);
const text = process.argv[3];

if (!token || !tabId || !text) {
  console.error("usage: BRIDGE_TOKEN=xxx node boss-send-chat.mjs <tabId> <text>");
  process.exit(1);
}

// 动态加载同目录 helper（ESM，与本体同放 scripts/ 目录）
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = import.meta.dirname || dirname(fileURLToPath(import.meta.url));
const helpersUrl = pathToFileURL(join(__dirname, "boss-verify-helpers.mjs")).href;
const { COLLECT_BUBBLES_EXPR, analyzeDelivery, decideOutcome } = await import(helpersUrl);

const RPC = "http://127.0.0.1:8778/rpc";
async function rpc(method, params) {
  const resp = await fetch(RPC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Agent-Id": agentId,
      "X-Agent-Name": encodeURIComponent(agentName),
    },
    body: JSON.stringify({ method, params, timeoutMs: 25000 }),
  }).then((r) => r.json());
  return resp;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function claimTab() {
  const resp = await fetch("http://127.0.0.1:8778/tabs/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Agent-Id": agentId },
    body: JSON.stringify({ tabId, agentId, ttlMs: 120000 }),
  }).then((r) => r.json());
  if (!resp.ok) throw new Error(`无法获取 Tab 租约: ${resp.error?.code || "LEASE_FAILED"} ${resp.error?.message || ""}`);
}
await claimTab();
console.log(`tab ${tabId} leased by ${agentId}`);

// page.evaluate 的返回值在 result.result 里（可能是 JSON 字符串），统一解析
function evalResult(resp) {
  const raw = resp?.ok === false ? null : resp?.result?.result;
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return { raw }; }
  }
  return raw;
}

// ---------- 1. 写入输入框（受控 contenteditable：native setter + InputEvent） ----------
const setExpr = `(()=>{
  const el = document.querySelector('.chat-input');
  if (!el) return JSON.stringify({ok:false, err:'no .chat-input'});
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText')?.set;
  if (!setter) return JSON.stringify({ok:false, err:'no innerText setter'});
  setter.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:${JSON.stringify(text)}}));
  el.dispatchEvent(new Event('input', {bubbles:true}));
  return JSON.stringify({ok:true, val:(el.innerText||'').slice(0,30)});
})()`;
let r = await rpc("page.evaluate", { tabId, expression: setExpr, awaitPromise: false });
const typed = evalResult(r);
console.log("type:", JSON.stringify(typed));
if (r.ok === false) { console.log("type: rpc error", JSON.stringify(r.error)); process.exit(1); }
if (!typed.ok) process.exit(1);

// ---------- 2. 轮询发送按钮直到可用（BOSS contenteditable 异步同步，禁止固定 sleep） ----------
const waitButtonExpr = `(()=>{const b=document.querySelector('button.btn-send');return JSON.stringify({exists:!!b,disabled:!!(b?.disabled||(b?.className||'').includes('disabled')),input:document.querySelector('.chat-input')?.innerText||''});})()`;
let buttonState = {};
for (let i = 0; i < 20; i++) {
  r = await rpc("page.evaluate", { tabId, expression: waitButtonExpr, awaitPromise: false });
  buttonState = evalResult(r);
  if (buttonState.exists && !buttonState.disabled) break;
  await sleep(150);
}
if (!buttonState.exists || buttonState.disabled) {
  console.log("click-send:", JSON.stringify({ ok: false, err: "send button did not become enabled", state: buttonState }));
  process.exit(1);
}

// ---------- 3. 只点击一次（不可逆动作；失败由人工/调用方核对后补发） ----------
const clickExpr = `(()=>{const b=document.querySelector('button.btn-send');if(!b||b.disabled||(b.className||'').includes('disabled'))return JSON.stringify({ok:false,err:'disabled-at-click'});b.click();return JSON.stringify({ok:true});})()`;
r = await rpc("page.evaluate", { tabId, expression: clickExpr, awaitPromise: false });
const clicked = evalResult(r);
console.log("click-send:", JSON.stringify(clicked));
if (r.ok === false) { console.log("click-send: rpc error", JSON.stringify(r.error)); process.exit(1); }
if (!clicked.ok) process.exit(1);

// ---------- 4. 送达验证：当前 selected 会话内本人气泡 + 精确文本 + 同气泡状态 ----------
async function collect() {
  const resp = await rpc("page.evaluate", { tabId, expression: COLLECT_BUBBLES_EXPR, awaitPromise: false });
  return evalResult(resp);
}

let analysis = null;
let lastRaw = null;
for (let i = 0; i < 32; i++) {
  lastRaw = await collect();
  analysis = analyzeDelivery({
    sentText: text,
    bubbles: lastRaw.bubbles || [],
    inputText: lastRaw.inputText || "",
    blockedText: lastRaw.blockedText || "",
  });
  // 已送达/已读 或 平台拦截，即可定论
  if (analysis.delivery || analysis.blocked) break;
  // 消息已出现但状态未渲染：再等一会
  await sleep(150);
}

const outcome = decideOutcome(analysis);
const summary = {
  outcome,
  messageFound: analysis.messageFound,
  ownMessage: analysis.ownMessage,
  delivery: analysis.delivery,
  inputCleared: analysis.inputCleared,
  blocked: analysis.blocked,
  matchedBubbleText: (analysis.matchedBubbleText || "").slice(0, 120),
};

if (outcome === "blocked") {
  console.log("verify: BLOCKED: " + (analysis.blockedText || "").slice(0, 120));
  console.log("summary:", JSON.stringify(summary));
  process.exit(2);
}
if (outcome === "sent") {
  console.log("verify: OK: " + summary.delivery + " | " + summary.matchedBubbleText);
  console.log("summary:", JSON.stringify(summary));
  process.exit(0);
}

// ---------- 5. UNKNOWN / pending / input_not_cleared：先只读核对，不自动重发 ----------
// RPC 超时或 DOM 暂未渲染：再核对一次当前会话 DOM（只读，不点击）
await sleep(250);
const recheckRaw = await collect();
const recheck = analyzeDelivery({
  sentText: text,
  bubbles: recheckRaw.bubbles || [],
  inputText: recheckRaw.inputText || "",
  blockedText: recheckRaw.blockedText || "",
});
const recheckOutcome = decideOutcome(recheck);

if (recheckOutcome === "sent") {
  console.log("verify: OK (after recheck): " + recheck.delivery + " | " + (recheck.matchedBubbleText || "").slice(0, 120));
  console.log("summary:", JSON.stringify({ ...summary, rechecked: true, delivery: recheck.delivery, outcome: "sent" }));
  process.exit(0);
}
if (recheckOutcome === "blocked") {
  console.log("verify: BLOCKED (after recheck): " + (recheck.blockedText || "").slice(0, 120));
  console.log("summary:", JSON.stringify({ ...summary, rechecked: true, blocked: true, outcome: "blocked" }));
  process.exit(2);
}

// 仍未送达：不盲重发。报告结构化结果，交人工/调用方决定补发。
console.log("verify: " + recheckOutcome.toUpperCase() + ": " + JSON.stringify({
  sentTextPreview: text.slice(0, 40),
  inputCleared: recheck.inputCleared,
  messageFound: recheck.messageFound,
  ownMessage: recheck.ownMessage,
  delivery: recheck.delivery,
  matchedBubbleText: (recheck.matchedBubbleText || "").slice(0, 120),
  bubbleCount: (recheckRaw.bubbles || []).length,
}));
process.exit(1);
