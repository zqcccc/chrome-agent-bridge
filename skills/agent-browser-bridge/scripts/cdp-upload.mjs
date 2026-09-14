#!/usr/bin/env node
/**
 * CDP 文件上传 —— 给 file input 注入本地文件（Bridge 无原生上传 RPC）
 *
 * 用法: BRIDGE_TOKEN=xxx node cdp-upload.mjs <tabId> <selector> <file1> [file2...]
 *   selector: CSS 选择器 (没有 file input 时传 "", 脚本会等待点击后出现)
 *
 * 前置: session.attach 必须先调用（Runtime.evaluate 才能用；DOM.* 也需要 attach）
 */
const token = process.env.BRIDGE_TOKEN;
const [, , tabIdArg, selectorArg, ...files] = process.argv;
const tabId = Number(tabIdArg);
if (!token || !tabId || !files.length) {
  console.error('usage: BRIDGE_TOKEN=xxx node cdp-upload.mjs <tabId> <selector|""> <file...>');
  process.exit(1);
}
const BASE = "http://127.0.0.1:8778/rpc";

async function rpc(method, params, t = 20000) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, params, timeoutMs: t }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${method}: ${JSON.stringify(j.error || j)}`);
  return j.result;
}

async function main() {
  try { await rpc("tabs.prepare", { tabId }, 15000); } catch {}
  await rpc("session.attach", { tabId }, 15000);
  try {
    // 1. 找到 file input 的 nodeId
    let nodeId = null;
    if (selectorArg) {
      const { root } = await rpc("session.send", { tabId, method: "DOM.getDocument", params: { depth: -1 } });
      const { nodeId: n } = await rpc("session.send", {
        tabId,
        method: "DOM.querySelector",
        params: { nodeId: root.nodeId, selector: selectorArg },
      });
      nodeId = n;
    }
    if (!nodeId) throw new Error("未找到 file input；请确认选择器");

    // 2. 注入文件
    await rpc("session.send", {
      tabId,
      method: "DOM.setFileInputFiles",
      params: { files, nodeId },
    }, 30000);
    console.log(`✓ 已注入 ${files.length} 个文件:`, files.join(", "));
  } finally {
    await rpc("session.detach", { tabId }, 10000).catch(() => {});
  }
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
