#!/usr/bin/env node
// chatgpt-ask.mjs —— 通过网页版 ChatGPT 提问并读取回复（含图片）。
// 为什么不用 page.evaluate：chatgpt.com 有严格 CSP（script-src 无 'unsafe-eval'），
// 任何 eval 字符串都会被拦（实测 EVAL_ERROR，MAIN 与 ISOLATED 世界均如此）。
// 本脚本的求值全部走 CDP Runtime.evaluate（DevTools 协议，不受页面 CSP 约束）。
//
// 用法:
//   BRIDGE_TOKEN=xxx node chatgpt-ask.mjs <tabId> "<提问>"
//   BRIDGE_TOKEN=xxx node chatgpt-ask.mjs <tabId> "<提问>" --new          # 先开新会话
//   BRIDGE_TOKEN=xxx node chatgpt-ask.mjs <tabId> "<提问>" --model "GPT-5" # 尽力选模型（UI 变化频繁，可能不生效）
//   BRIDGE_TOKEN=xxx node chatgpt-ask.mjs <tabId> "<提问>" --images ./out # 把生成的图片下载到本地目录
//   BRIDGE_TOKEN=xxx node chatgpt-ask.mjs <tabId> "<提问>" --timeout 180000 --out result.json
// 前置: 根 SKILL.md 的桥已就绪；目标 tab 是 chatgpt.com；用户已登录（未登录会提示手动登录）
//
// 输出: JSON { url, prompt, reply, thinking?, images[], elapsedMs, quotaHint, modelApplied }
const token = process.env.BRIDGE_TOKEN;
const [, , tabIdArg, promptArg, ...rest] = process.argv;
const tabId = Number(tabIdArg);
const opts = { newChat: false, model: null, imagesDir: null, out: null, timeoutMs: 180000 };
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--new") opts.newChat = true;
  else if (rest[i] === "--model") opts.model = rest[++i];
  else if (rest[i] === "--images") opts.imagesDir = rest[++i];
  else if (rest[i] === "--out") opts.out = rest[++i];
  else if (rest[i] === "--timeout") opts.timeoutMs = parseInt(rest[++i], 10) || 180000;
}
if (!token || !tabId || !promptArg) {
  console.error('usage: BRIDGE_TOKEN=xxx node chatgpt-ask.mjs <tabId> "<提问>" [--new] [--model <名>] [--images <dir>] [--timeout Ms] [--out <json>]');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CDP 求值：attach → Runtime.evaluate → detach。返回 JS 值（returnByValue）。
async function cdpEval(expression, { awaitPromise = false, timeoutMs = 30000 } = {}) {
  await rpc("session.attach", { tabId }, 15000);
  try {
    const r = await rpc("session.send", {
      tabId, method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise, userGesture: true },
    }, timeoutMs);
    const { result, exceptionDetails } = r.result || {};
    if (exceptionDetails) {
      const ex = exceptionDetails.exception || {};
      throw new Error(`页面内 JS 异常: ${ex.description || ex.value || JSON.stringify(exceptionDetails)}`);
    }
    return result && result.value !== undefined ? result.value : result;
  } finally {
    await rpc("session.detach", { tabId }, 10000).catch(() => {});
  }
}

// 页面状态：URL / 标题 / 是否登录墙 / composer 是否存在 / 生成中
const STATUS_EXPR = `(() => {
  const ta = document.querySelector('#prompt-textarea');
  const url = location.href;
  const body = (document.body && document.body.innerText || '').slice(0, 300);
  const loginWall = /auth\\/login|log\\s*in|sign\\s*up|继续使用 Google|Continue with/i.test(url + ' ' + body.slice(0, 120)) && !ta;
  return {
    url, title: document.title,
    loginWall,
    hasComposer: !!ta,
    generating: !!document.querySelector('button[data-testid="stop-button"]'),
    bodyHead: body.slice(0, 120),
  };
})()`;

async function waitForComposer(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await cdpEval(STATUS_EXPR);
    if (st.hasComposer) return st;
    if (st.loginWall) throw new Error("⛔ 未登录：页面是登录墙。请用户手动登录 chatgpt.com 后重试，不要替用户登录。");
    await sleep(800);
  }
  throw new Error(`等待输入框 #prompt-textarea 超时（${timeoutMs}ms），当前 URL: ${(await cdpEval("location.href"))}`);
}

// 从页面读当前状态：以 conversation-turn 容器为准（实测：图片-only 的 assistant 轮
// 有 conversation-turn 容器但【没有】data-message-author-role，按 role 取会漏/错位）。
const READ_EXPR = `(() => {
  const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn"]'));
  const last = turns[turns.length - 1] || null;
  const roleEl = last && last.querySelector('[data-message-author-role]');
  const role = roleEl ? roleEl.getAttribute('data-message-author-role') : '';
  const imgs = last ? Array.from(last.querySelectorAll('img[alt^="Generated image"]')).map(im => im.src).filter(Boolean) : [];
  const isAssistant = role === 'assistant' || imgs.length > 0;
  const reply = roleEl && role === 'assistant' ? (roleEl.innerText || '').trim() : '';
  const thinkingEl = roleEl && roleEl.querySelector('[data-testid="thinking-visualization"]');
  const thinking = thinkingEl ? (thinkingEl.innerText || '').trim().slice(0, 2000) : '';
  const quota = (document.body.innerText.match(/(\\d+)\\s*\\/\\s*(\\d+)/g) || []).slice(-3);
  return {
    turnCount: turns.length,
    role,
    isAssistant,
    reply,
    thinking,
    images: Array.from(new Set(imgs)),
    quotaHint: quota,
    generating: !!document.querySelector('button[data-testid="stop-button"]'),
    hasSendBtn: !!document.querySelector('button[data-testid="send-button"]'),
  };
})()`;

async function waitReply(before, timeoutMs) {
  // 完成判定：生成结束(!generating) 且满足其一——
  //   a) 回复文本连续两次读取一致（稳定）；b) 新 turn 带生成图（纯图片回复）。
  // 实测坑：图片-only 的 assistant turn 有 conversation-turn 容器但没有 data-message-author-role，
  // 完成信号必须用「turn 数增加 + 图片出现」，不能只依赖 role 消息数。
  const t0 = Date.now();
  let prev = "";
  let stable = 0;
  let lastLog = 0;
  while (Date.now() - t0 < timeoutMs) {
    const r = await cdpEval(READ_EXPR);
    const newTurn = r.turnCount > before.turnCount || !!r.reply || r.images.length > before.images.length;
    if (newTurn && !r.generating) {
      if (r.reply) {
        if (r.reply === prev) {
          stable++;
          if (stable >= 2) return r;
        } else {
          prev = r.reply; stable = 0;
        }
      } else if (r.images.length > before.images.length) {
        return r; // 纯图片/无文本回复，生成结束即完成
      }
    } else if (newTurn && r.generating) {
      prev = r.reply; stable = 0;
    }
    const elapsed = Date.now() - t0;
    if (elapsed - lastLog > 15000) {
      lastLog = elapsed;
      console.error(`⏳ 等待回复中 ${(elapsed / 1000).toFixed(0)}s … (turn=${r.turnCount} 图=${r.images.length} 生成中=${r.generating})`);
    }
    await sleep(1200);
  }
  const last = await cdpEval(READ_EXPR);
  if (last.reply || last.images.length > before.images.length) {
    console.error(`⚠️ 等待超时(${timeoutMs}ms)但已有内容，按现状返回`);
    return last;
  }
  throw new Error(`等待回复超时(${timeoutMs}ms)。可能: 额度用尽/需要升级/网络异常。可再跑一次，或让用户到页面查看。`);
}

// 尽力选择模型：找文本/aria 含模型名的按钮点击，再在弹层里点对应选项。找不到不阻塞。
async function trySelectModel(name) {
  if (!name) return { requested: null, applied: false, note: "未指定模型" };
  const expr = `new Promise(async (resolve) => {
    const name = ${JSON.stringify(name)};
    const norm = name.toLowerCase();
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const findBtn = () => Array.from(document.querySelectorAll('button')).find(b =>
      vis(b) && ((b.textContent || '').trim().toLowerCase().includes(norm) || ((b.getAttribute('aria-label') || '').toLowerCase().includes(norm))));
    let btn = findBtn();
    if (!btn) return resolve({ applied: false, note: '未找到模型名按钮' });
    btn.click();
    await new Promise(r => setTimeout(r, 700));
    // 弹层里点同名选项
    const opts = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], [role="radio"], button'))
      .filter(e => vis(e) && (e.textContent || '').trim().toLowerCase().includes(norm));
    if (opts.length) { opts[0].click(); await new Promise(r => setTimeout(r, 400)); resolve({ applied: true, note: 'clicked ' + opts[0].textContent.trim().slice(0, 30) }); }
    else resolve({ applied: false, note: '点了按钮但未找到同名选项（UI 可能已变化）' });
  })`;
  return cdpEval(expr, { awaitPromise: true, timeoutMs: 20000 });
}

async function downloadImages(images, dir) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (let i = 0; i < images.length; i++) {
    const expr = `new Promise(async (resolve) => {
      try {
        const r = await fetch(${JSON.stringify(images[i])}, { credentials: 'include' });
        if (!r.ok) return resolve({ ok: false, status: r.status });
        const buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let j = 0; j < bytes.length; j += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(j, j + 0x8000));
        resolve({ ok: true, b64: btoa(bin), type: r.headers.get('content-type') || 'image/png' });
      } catch (e) { resolve({ ok: false, err: String(e) }); }
    })`;
    const data = await cdpEval(expr, { awaitPromise: true, timeoutMs: 60000 });
    if (data && data.ok) {
      const ext = (data.type || "image/png").split("/")[1] || "png";
      const file = path.join(dir, `chatgpt-img-${Date.now()}-${i + 1}.${ext}`);
      fs.writeFileSync(file, Buffer.from(data.b64, "base64"));
      saved.push(file);
    } else {
      console.error(`⚠️ 图片 ${i + 1} 下载失败: ${JSON.stringify(data || {}).slice(0, 120)}`);
    }
  }
  return saved;
}

async function main() {
  const t0 = Date.now();
  // 0. 静默准备标签页（content script 注入 + CDP 访问前提，不抢焦点）
  try { await rpc("tabs.prepare", { tabId }, 15000); } catch {}
  await sleep(600);

  // 1. 状态检查：是否在 chatgpt.com、是否登录墙
  let st = await cdpEval(STATUS_EXPR);
  if (!/chatgpt\.com|chat\.openai\.com/.test(st.url)) {
    throw new Error(`当前 tab 不是 chatgpt.com（${st.url}）。请先在浏览器打开 chatgpt.com 并登录，再跑本脚本。`);
  }
  if (st.loginWall) throw new Error("⛔ 未登录：页面是登录墙。请用户手动登录后重试。");

  // 2. 新开会话或复用当前
  if (opts.newChat || !st.hasComposer) {
    console.error("🆕 打开新会话 …");
    await rpc("page.navigate", { tabId, url: "https://chatgpt.com/" }, 20000).catch(() => {});
    st = await waitForComposer();
  } else {
    st = await waitForComposer();
  }

  // 3. 尽力选模型（不阻塞主流程）
  const model = await trySelectModel(opts.model);

  // 4. 输入提问（page.type 走 content script 的 execCommand insertText，实测可用）
  const before = await cdpEval(READ_EXPR);
  await rpc("page.type", { tabId, selector: "#prompt-textarea", text: promptArg }, 20000);
  await sleep(400);
  const typed = await cdpEval(`(() => { const ta = document.querySelector('#prompt-textarea'); return ta ? ta.innerText.trim() : ''; })()`);
  if (!typed) throw new Error("输入失败：composer 未出现文本，页面结构可能已变化，请人工确认后重试");
  console.error(`✍️ 已输入（${typed.length} 字符），发送中 …`);

  // 5. 等发送按钮可用再点
  const tSend = Date.now();
  while (Date.now() - tSend < 15000) {
    const b = await cdpEval(`(() => { const b = document.querySelector('button[data-testid="send-button"]'); return b ? { exists: true, disabled: b.disabled } : { exists: false }; })()`);
    if (b && b.exists && !b.disabled) break;
    await sleep(500);
  }
  await rpc("page.click", { tabId, selector: "button[data-testid=\"send-button\"]", by: "css" }, 20000);

  // 6. 等回复完成
  const r = await waitReply(before, opts.timeoutMs);

  // 7. 下载图片（可选）
  let savedImages = [];
  if (opts.imagesDir && r.images.length) {
    console.error(`🖼️ 下载 ${r.images.length} 张图片 …`);
    savedImages = await downloadImages(r.images, opts.imagesDir);
  }

  const out = {
    tabId, url: st.url,
    prompt: promptArg,
    reply: r.reply || "",
    thinking: r.thinking || "",
    images: r.images || [],
    savedImages,
    modelApplied: model.applied,
    quotaHint: r.quotaHint || [],
    elapsedMs: Date.now() - t0,
  };
  if (opts.out) {
    const fs = await import("node:fs");
    fs.writeFileSync(opts.out, JSON.stringify(out, null, 2));
  }
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
