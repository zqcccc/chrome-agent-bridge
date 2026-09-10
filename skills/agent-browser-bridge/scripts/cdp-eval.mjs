#!/usr/bin/env node
// CDP 求值工具 —— 在严格 CSP 页面（如 chatgpt.com）上执行任意 JS 的唯一通道。
// 背景: page.evaluate 用 eval(expression) 注入页面主世界/隔离世界, 会被页面 CSP 拦截
//       （chatgpt.com 的 script-src 无 'unsafe-eval', 实测 EVAL_ERROR）。
//       CDP Runtime.evaluate 走 DevTools 协议, 不受页面 CSP 约束, 可正常执行。
//
// 用法: BRIDGE_TOKEN=xxx node cdp-eval.mjs <tabId> "<JS 表达式>"
//       可选: --timeoutMs 20000   --awaitPromise   --json（原样输出 result.value）
// 前置: 根 SKILL.md 的桥已就绪（host 存活、扩展已连接、目标 tab 非 chrome:// 等受保护页）
//
// 返回值: 表达式求值结果（returnByValue）。若表达式返回 Promise, 需加 --awaitPromise。
// 注意: Runtime.evaluate 运行在页面主世界, 可访问 window/document/React 内部状态;
//       DOM 操作与主世界一致, 不受扩展隔离世界限制。
const token = process.env.BRIDGE_TOKEN;
const [, , tabIdArg, exprArg, ...rest] = process.argv;
let timeoutMs = 20000, awaitPromise = false, rawJson = false;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--timeoutMs") timeoutMs = parseInt(rest[i + 1], 10) || 20000;
  if (rest[i] === "--awaitPromise") awaitPromise = true;
  if (rest[i] === "--json") rawJson = true;
}
const tabId = Number(tabIdArg);
if (!token || !tabId || !exprArg) {
  console.error('usage: BRIDGE_TOKEN=xxx node cdp-eval.mjs <tabId> "<JS 表达式>" [--timeoutMs N] [--awaitPromise] [--json]');
  process.exit(1);
}

const rpc = async (method, params = {}, t = timeoutMs) => {
  const res = await fetch("http://127.0.0.1:8778/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, params, timeoutMs: t }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method} failed: ${JSON.stringify(json.error || json)}`);
  return json.result;
};

async function main() {
  // 0. 激活标签页（content script 注入前提，session 也需要页面可访问）
  try { await rpc("tabs.activate", { tabId }, 15000); } catch {}
  // 1. 挂上 CDP session
  await rpc("session.attach", { tabId }, 15000);
  try {
    const r = await rpc("session.send", {
      tabId,
      method: "Runtime.evaluate",
      params: {
        expression: exprArg,
        returnByValue: true,
        awaitPromise,
        userGesture: true,
      },
    }, timeoutMs);
    const { result, exceptionDetails } = r.result || {};
    if (exceptionDetails) {
      const ex = exceptionDetails.exception || {};
      console.error("EXCEPTION:", ex.description || ex.value || JSON.stringify(exceptionDetails));
      process.exit(2);
    }
    if (rawJson) {
      console.log(JSON.stringify(result && result.value !== undefined ? result.value : result, null, 2));
    } else {
      const v = result && result.value !== undefined ? result.value : result;
      console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
    }
  } finally {
    // 2. 收工卸掉 session（不阻塞主流程）
    await rpc("session.detach", { tabId }, 10000).catch(() => {});
  }
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
