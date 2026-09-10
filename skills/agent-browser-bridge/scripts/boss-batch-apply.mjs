#!/usr/bin/env node
// BOSS 直聘批量投递模板：每个职位 = 打开详情 → 点「立即沟通」→ 等聊天页就绪 → 发打招呼 → 发简历网址 → 发 PDF(URL编码) → 轻量验证
// 提取自独立 skill boss-zhipin-apply，作为 agent-browser-bridge 的 BOSS 直聘子技能资产（见 boss/SKILL.md）。
// 用法: BRIDGE_TOKEN=xxx node boss-batch-apply.mjs <tabId>
//
// 环境变量配置：
//   BRIDGE_TOKEN     必填，桥 token
//   AGENT_ID         并行 Agent 请显式设置唯一值；同一批次的子流程复用该值
//   AGENT_NAME       可选，接管提示里显示的名字
//   BOSS_RESUME_SITE 简历网页版 URL（默认 https://example.com/resume）
//   BOSS_RESUME_PDF  简历 PDF URL，必须用 URL 编码形式发送（防手机号等被 BOSS 拦截）；留空则跳过第 3 条
//
// 使用前把 jobs 数组替换为当前任务的实际职位（URL + 会话校验关键词 + 定制打招呼语）。
// 前置: 用户已登录 BOSS；发送前已把清单给用户确认。
// 严格单条送达验证（送达/已读、UNKNOWN 只读复核）请用 boss-send-chat.mjs；本脚本是轻量模板。
const token = process.env.BRIDGE_TOKEN;
const agentId = process.env.AGENT_ID || "boss-batch";
const agentName = process.env.AGENT_NAME || "BOSS批量投递";
const TAB = parseInt(process.argv[2], 10);
if (!token || !TAB) { console.error("usage: BRIDGE_TOKEN=xxx node boss-batch-apply.mjs <tabId>"); process.exit(1); }

const SITE_URL = process.env.BOSS_RESUME_SITE || "";
const PDF_URL = process.env.BOSS_RESUME_PDF || "";

const jobs = [
  {
    name: "示例公司-岗位(地点)",
    check: /公司关键词/,          // 会话验证用：从选中会话文本中匹配
    url: "https://www.zhipin.com/job_detail/xxxxxxxx.html",
    greeting: "您好！我是<姓名>，<X>年+<方向>开发……（按 JD 定制，勿提敏感表述）",
  },
  // ...更多职位
];

async function rpc(method, params) {
  const resp = await fetch("http://127.0.0.1:8778/rpc", {
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

// page.evaluate 返回值在 result.result 里（可能是 JSON 字符串），统一解析
function evalResult(resp) {
  const raw = resp?.ok === false ? null : resp?.result?.result;
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return { raw }; }
  }
  return raw;
}

async function claimTab() {
  const resp = await fetch("http://127.0.0.1:8778/tabs/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Agent-Id": agentId },
    body: JSON.stringify({ tabId: TAB, agentId, ttlMs: 120000 }),
  }).then((r) => r.json());
  if (!resp.ok) throw new Error(`无法获取 Tab 租约: ${resp.error?.code || "LEASE_FAILED"} ${resp.error?.message || ""}`);
}
await claimTab();
console.log(`tab ${TAB} leased by ${agentId}`);

// 读取当前选中会话：会话文本 + URL + 聊天输入框是否已渲染
const SESSION_EXPR = `(()=>{
  const items=[...document.querySelectorAll('.friend-content')];
  const sel=items.find(i=>(i.className||'').includes('selected'));
  return JSON.stringify({
    sel: sel ? sel.textContent.replace(/\\s+/g,' ').trim().slice(0,60) : null,
    url: location.href,
    chatInput: !!document.querySelector('.chat-input'),
  });
})()`;
async function readSession() {
  return evalResult(await rpc("page.evaluate", { tabId: TAB, expression: SESSION_EXPR, awaitPromise: false }));
}

// 点「立即沟通」并等待聊天页就绪：.chat-input 出现 + 选中会话文本匹配职位。最多轮询 ~12s，失败重试一次。
async function openChat(job) {
  for (let attempt = 0; attempt < 2; attempt++) {
    // 导航必须用 page.navigate（chrome.tabs.update），禁止用 page.evaluate 改 location.href（会销毁执行上下文）
    await rpc("page.navigate", { tabId: TAB, url: job.url, timeoutMs: 30000 });
    await sleep(4000);
    await rpc("page.evaluate", { tabId: TAB, expression: `(()=>{const b=document.querySelector('a.btn-startchat');if(b)b.click();return 'ok';})()`, awaitPromise: false });
    let sess = null;
    for (let i = 0; i < 24; i++) {   // 12s
      sess = await readSession();
      if (sess && sess.chatInput && sess.url.indexOf("/chat") >= 0 && sess.sel && job.check.test(sess.sel)) return sess;
      await sleep(500);
    }
    console.log("会话未就绪/不匹配，重试...");
  }
  return null;
}

// 发送一条消息：受控输入 → 轮询发送按钮可用（≤3s）→ 只点一次 → 轻量验证（拦截文案 + 输入框已清空）
async function sendText(text) {
  const safe = JSON.stringify(text);
  const typed = evalResult(await rpc("page.evaluate", { tabId: TAB, expression: `(()=>{
    const el=document.querySelector('.chat-input');
    if(!el) return JSON.stringify({ok:false,err:'no .chat-input'});
    el.focus();
    const setter=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'innerText')?.set;
    if(!setter) return JSON.stringify({ok:false,err:'no setter'});
    setter.call(el,${safe});
    el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${safe}}));
    el.dispatchEvent(new Event('input',{bubbles:true}));
    return JSON.stringify({ok:true});
  })()`, awaitPromise: false }));
  if (!typed.ok) return { sent: false, blocked: false, last: typed.err || "no .chat-input" };

  let ready = null;
  for (let i = 0; i < 20; i++) {   // ≤3s 轮询按钮 enabled
    ready = evalResult(await rpc("page.evaluate", { tabId: TAB, expression: `(()=>{const b=document.querySelector('button.btn-send');return JSON.stringify({exists:!!b,disabled:!!(b?.disabled||(b?.className||'').includes('disabled'))});})()`, awaitPromise: false }));
    if (ready.exists && !ready.disabled) break;
    await sleep(150);
  }
  if (!ready || !ready.exists || ready.disabled) return { sent: false, blocked: false, last: "send button not enabled" };

  const clicked = evalResult(await rpc("page.evaluate", { tabId: TAB, expression: `(()=>{const b=document.querySelector('button.btn-send');if(!b||b.disabled||(b.className||'').includes('disabled'))return JSON.stringify({ok:false});b.click();return JSON.stringify({ok:true});})()`, awaitPromise: false }));
  if (!clicked.ok) return { sent: false, blocked: false, last: "click failed" };

  await sleep(1200);
  const v = evalResult(await rpc("page.evaluate", { tabId: TAB, expression: `(()=>{
    const mine=[...document.querySelectorAll('.message-item.item-myself,[class*="item-myself"],[class*="myself"]')];
    const last=mine.length?mine[mine.length-1].textContent.replace(/\\s+/g,' ').trim():'';
    const body=document.body.innerText.replace(/\\s+/g,' ').trim();
    const m=body.match(/平台暂不支持直接发送[^\\n]{0,40}/);
    return JSON.stringify({last:last.slice(-80), inputEmpty:((document.querySelector('.chat-input')?.innerText||'').replace(/\\s+/g,'')===''), blocked:m?m[0]:''});
  })()`, awaitPromise: false }));
  const blocked = !!(v.blocked || /暂不支持直接发送/.test(v.last || ""));
  const sent = !blocked && !!v.last && v.inputEmpty !== false;
  return { sent, blocked, last: (v.blocked || v.last || "").slice(0, 80) };
}

// 3 条独立消息（对方方便复制）；PDF 未配置时自动跳过
const messages = [
  ["打招呼", (j) => j.greeting],
  ["简历网址", () => SITE_URL],
  ["PDF网址", () => PDF_URL],
];

for (const j of jobs) {
  console.log(`\n===== ${j.name} =====`);
  const sess = await openChat(j);
  if (!sess) { console.log("✗ 会话未就绪/不匹配，跳过（投递记录标记 not_sent）"); continue; }
  console.log("会话:", sess.sel);
  for (const [label, getText] of messages) {
    const txt = getText(j);
    if (!txt) continue;
    const res = await sendText(txt);
    console.log(`${label}:`, res.sent ? "✓ 已发送" : "✗ " + (res.blocked ? "BLOCKED " : "") + res.last);
    if (res.blocked) break;   // 平台拦截：停止当前职位后续消息，记录 blocked
    await sleep(500);
  }
}
console.log("\n===== 完成 =====");
