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
  await releaseLease(); process.exit(1);
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
  return assertOk(resp, method);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 桥调用守卫 ----------
// 桥错误必须显式抛出，否则会被下游误读成「未送达」。
// 退出码约定（见 SKILL.md）：0=已送达/已读，1=失败/未定论，2=平台拦截，**3=用户叫停**。
// `AGENT_STOPPED` 是用户明确叫停：立即终止，绝不重试、绝不重发。
const EXIT_STOPPED = 3;
let leased = false;
function assertOk(resp, method) {
  if (resp && resp.ok !== false) return resp;
  const e = (resp && resp.error) || {};
  const code = e.code || "RPC_ERROR";
  const msg = `${method} 失败: [${code}] ${e.message || "未知错误"}`;
  const err = new Error(msg);
  err.code = code;
  err.details = e.details;
  throw err;
}
// 本脚本用顶层 await：顶层 await 的 reject 走的是 **uncaughtException**（不是
// unhandledRejection——已实测确认）。两个都注册，否则用户叫停时打出的是 Node 堆栈，
// 退出码也不是约定的 3。
function fatal(e) {
  // 先释放租约再退出：否则该 tab 会被锁 120 秒，下一个 Agent 拿到 TAB_LEASED。
  return releaseLease().then(async () => {
    if (e && e.code === "AGENT_STOPPED") {
      console.error(`✗ 用户已停止 Agent，本次发送终止（未确认送达）：${e.message}`);
      console.error(`  resumeWith=${(e.details && e.details.resumeWith) || "agent.resume"}  scope=${(e.details && e.details.scope) || "?"}`);
      console.error("  不要自动重试/重发：用户刚明确要求停下来。");
      process.exit(EXIT_STOPPED);
    }
    console.error("✗ " + ((e && e.code) ? `[${e.code}] ` : "") + (e && e.message ? e.message : String(e)));
    process.exit(1);
  });
}
process.on("unhandledRejection", fatal);
process.on("uncaughtException", fatal);

// 发送前确认用户没叫停（停止状态查询是只读的，停止期间也允许）。
async function checkStop(where) {
  let st;
  try {
    st = await rpc("agent.stopStatus", { tabId });
  } catch (e) {
    if (e.code === "AGENT_STOPPED") throw e;
    return;   // 查询不可用（旧版扩展）不阻断
  }
  const r = st && st.result;
  if (r && r.applicable) {
    const err = new Error(`用户已停止 Agent（${where}）`);
    err.code = "AGENT_STOPPED";
    err.details = { ...(r.stop || {}), resumeWith: "agent.resume", scope: r.scope };
    throw err;
  }
}

async function claimTab() {
  const resp = await fetch("http://127.0.0.1:8778/tabs/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Agent-Id": agentId },
    body: JSON.stringify({ tabId, agentId, ttlMs: 120000 }),
  }).then((r) => r.json());
  if (!resp.ok) throw new Error(`无法获取 Tab 租约: ${resp.error?.code || "LEASE_FAILED"} ${resp.error?.message || ""}`);
  leased = true;
}
// 租约必须主动释放（见 fatal 注释）。
async function releaseLease() {
  if (!leased) return;
  leased = false;
  try {
    await fetch("http://127.0.0.1:8778/tabs/release", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Agent-Id": agentId },
      body: JSON.stringify({ tabId, agentId }),
    });
  } catch (e) { /* 不掩盖原始错误 */ }
}
await claimTab();
console.log(`tab ${tabId} leased by ${agentId}`);

// page.evaluate 的返回值在 result.result 里（可能是 JSON 字符串），统一解析。
// rpc() 已保证 resp.ok 为真，所以这里的 `{}` 只代表「表达式返回空」。
function evalResult(resp) {
  const raw = resp?.result?.result;
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return { raw }; }
  }
  return raw;
}

// ---------- 1. 写入输入框（受控 contenteditable：native setter + InputEvent） ----------
// 先查停止：本脚本的「输入」走 page.evaluate（只读方法，不会被 host 的停止闸门拦），
// 所以必须自己检查，否则用户叫停后还会把文字填进输入框。
await checkStop("写入输入框前");
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
if (!typed.ok) { await releaseLease(); process.exit(1); }

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
  await releaseLease(); process.exit(1);
}

// ---------- 3. 只点击一次（不可逆动作；失败由人工/调用方核对后补发） ----------
// 点击前再确认一次用户没叫停：这是整个脚本唯一真正不可逆的动作。
await checkStop("点击发送前");
const clickExpr = `(()=>{const b=document.querySelector('button.btn-send');if(!b||b.disabled||(b.className||'').includes('disabled'))return JSON.stringify({ok:false,err:'disabled-at-click'});b.click();return JSON.stringify({ok:true});})()`;
r = await rpc("page.evaluate", { tabId, expression: clickExpr, awaitPromise: false });
const clicked = evalResult(r);
console.log("click-send:", JSON.stringify(clicked));
if (!clicked.ok) { await releaseLease(); process.exit(1); }

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
  await releaseLease(); process.exit(2);
}
if (outcome === "sent") {
  console.log("verify: OK: " + summary.delivery + " | " + summary.matchedBubbleText);
  console.log("summary:", JSON.stringify(summary));
  await releaseLease(); process.exit(0);
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
  await releaseLease(); process.exit(0);
}
if (recheckOutcome === "blocked") {
  console.log("verify: BLOCKED (after recheck): " + (recheck.blockedText || "").slice(0, 120));
  console.log("summary:", JSON.stringify({ ...summary, rechecked: true, blocked: true, outcome: "blocked" }));
  await releaseLease(); process.exit(2);
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
await releaseLease(); process.exit(1);
