#!/usr/bin/env node
/**
 * NotebookLM (Gemini Notebook) —— 通过 Bridge + CDP 上传本地文件到笔记本
 *
 * 关键点: 网页版是 Angular 应用, file input 懒加载且不暴露稳定选择器。
 *   1) 伪造 DataTransfer/File 的 drop 事件 —— 事件能派发但 Angular 读不到真实内容, 无效
 *   2) CDP DOM.setFileInputFiles —— 注入真实文件路径, 才是可行通道 ✓
 *
 * 流程: 打开/复用笔记本页 → 点「添加来源」→ 等 file input 出现 →
 *       CDP 注入文件 → 等 source 处理完成(READY)
 *
 * 用法:
 *   node nblm-upload.mjs <tabId> <文件路径> [文件路径...]
 *   node nblm-upload.mjs --new "<笔记本标题>" <文件路径>...     # 先新建笔记本
 *
 * 环境: BRIDGE_TOKEN
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const token = process.env.BRIDGE_TOKEN;
const args = process.argv.slice(2);
if (!token) {
  console.error("需要 BRIDGE_TOKEN 环境变量");
  process.exit(1);
}

const BRIDGE = "http://127.0.0.1:8778/rpc";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error("[nblm]", ...a);

async function rpc(method, params = {}, timeoutMs = 30000) {
  const res = await fetch(BRIDGE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, params, timeoutMs }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method} failed: ${JSON.stringify(json.error || json).slice(0, 300)}`);
  return json.result;
}

async function cdp(tabId, method, params = {}, timeoutMs = 30000) {
  const r = await rpc("session.send", { tabId, method, params }, timeoutMs);
  return r.result;
}

async function evaluate(tabId, expression, awaitPromise = false) {
  const r = await rpc("session.send", {
    tabId,
    method: "Runtime.evaluate",
    params: { expression, returnByValue: true, awaitPromise, userGesture: true },
  }, 60000);
  const { result, exceptionDetails } = r.result || {};
  if (exceptionDetails) {
    const ex = exceptionDetails.exception || {};
    throw new Error(ex.description || ex.value || JSON.stringify(exceptionDetails));
  }
  return result?.value;
}

/** 深搜(含 shadow DOM)里的 file input */
const FIND_INPUT_JS = `(() => {
  const found = [];
  const walk = (root, d) => {
    if (d > 8) return;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot, d + 1);
      if (el.tagName === 'INPUT' && el.type === 'file') {
        const r = el.getBoundingClientRect();
        found.push({ acc: (el.accept || '').slice(0, 120), w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
  };
  walk(document, 0);
  return JSON.stringify(found);
})()`;

const COUNT_SOURCES_JS = `(() => {
  const t = document.body.innerText || '';
  const m = t.match(/(\\d+)\\s*个来源/);
  return m ? parseInt(m[1], 10) : -1;
})()`;

async function openOrCreateNotebook(tabId, title) {
  await rpc("page.navigate", { tabId, url: "https://notebooklm.google.com/" });
  await sleep(6000);
  if (!title) return null;
  // 点「新建」
  await evaluate(tabId, `(() => {
    const b = [...document.querySelectorAll('button')].find(e => /新建/.test(e.innerText || ''));
    if (b) { b.click(); return 'clicked'; }
    return 'no-new-button';
  })()`);
  await sleep(5000);
  const url = await evaluate(tabId, "location.href");
  log("新建笔记本:", url);
  return url;
}

/**
 * 找到并(必要时)唤出 file input。
 * 关键: file input 是 Angular 懒加载的 —— 页面初次进入时不存在,
 * 必须先点「添加来源」→ 再点「上传文件」才会创建(实测 accept 含 .mp4/.png 等)。
 * 只点「添加来源」不够, 必须点到底层「上传文件」按钮。
 */
async function waitForFileInput(tabId, timeoutMs = 25000) {
  const clickUpload = `(() => {
    const hit = (el) => {
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      for (const t of ['mouseover','mousedown','mouseup','click'])
        el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,view:window}));
    };
    // 先确保「添加来源」面板开着
    const addBtn = [...document.querySelectorAll('button')].find(e => /添加来源/.test(e.innerText || ''));
    if (addBtn) hit(addBtn);
    // 再点「上传文件」—— 这一步才真正创建 input[type=file]
    const upBtn = [...document.querySelectorAll('button')].find(e => /上传文件/.test(e.innerText || ''));
    if (upBtn) { hit(upBtn); return 'clicked-upload'; }
    return addBtn ? 'clicked-add-only' : 'nf';
  })()`;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await evaluate(tabId, FIND_INPUT_JS);
    let arr = [];
    try { arr = JSON.parse(raw || "[]"); } catch {}
    if (arr.length) return true;
    const r = await evaluate(tabId, clickUpload).catch((e) => "err:" + e.message);
    log("唤出 file input:", r);
    await sleep(1500);
  }
  return false;
}

async function uploadFiles(tabId, files) {
  // 1) 确保 file input 存在
  const ok = await waitForFileInput(tabId);
  if (!ok) throw new Error("file input 未出现(可能页面结构变化或需登录)");

  // 2) DOM.setFileInputFiles 需要 nodeId: 先 document 再 querySelector
  const { root } = await cdp(tabId, "DOM.getDocument", { depth: -1, pierce: true });

  // 深搜 nodeId: 用 DOM.querySelectorAll 配 'input[type=file]' 在 pierce 模式下可穿透 shadow
  const { nodeIds } = await cdp(tabId, "DOM.querySelectorAll", {
    nodeId: root.nodeId,
    selector: "input[type=file]",
  });
  if (!nodeIds?.length) throw new Error("CDP 未找到 file input 节点");

  const nodeId = nodeIds[nodeIds.length - 1]; // 取最后一个(通常是最新创建的上传框)
  log(`注入 ${files.length} 个文件到 nodeId=${nodeId}`);
  await cdp(tabId, "DOM.setFileInputFiles", { files, nodeId }, 60000);
  return true;
}

async function waitProcessed(tabId, before, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last = before;
  while (Date.now() < deadline) {
    await sleep(3000);
    const n = await evaluate(tabId, COUNT_SOURCES_JS).catch(() => -1);
    if (n > before) {
      log(`来源数 ${before} -> ${n}`);
      // 继续等一小会儿, 确认处理完成(而不是刚加入还在转圈)
      await sleep(5000);
      return n;
    }
    last = n;
  }
  log(`超时, 来源数仍为 ${last}`);
  return last;
}

async function main() {
  const newIdx = args.indexOf("--new");
  let title = null;
  if (newIdx >= 0) {
    title = args[newIdx + 1];
    args.splice(newIdx, 2);
  }
  const tabId = Number(args[0]);
  const files = args.slice(1).map((f) => path.resolve(f.replace(/^~/, os.homedir())));

  if (!tabId || !files.length) {
    console.error("用法: node nblm-upload.mjs [--new <标题>] <tabId> <文件...>");
    process.exit(1);
  }
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error("文件不存在:", f); process.exit(1); }
  }

  await rpc("session.attach", { tabId }, 15000);
  try {
    if (title) await openOrCreateNotebook(tabId, title);

    const before = await evaluate(tabId, COUNT_SOURCES_JS).catch(() => 0);
    log("当前来源数:", before);

    await uploadFiles(tabId, files);
    const after = await waitProcessed(tabId, before);

    const url = await evaluate(tabId, "location.href");
    console.log(JSON.stringify({
      ok: after > before,
      notebookUrl: url,
      sourcesBefore: before,
      sourcesAfter: after,
      files: files.map((f) => path.basename(f)),
    }, null, 2));
  } finally {
    await rpc("session.detach", { tabId }, 10000).catch(() => {});
  }
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
