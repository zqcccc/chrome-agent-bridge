#!/usr/bin/env node
// 验证 v0.3.3 修复是否生效（扩展必须在 chrome://extensions 刷新后运行）
// 用法: BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node /tmp/verify-bridge-fix.mjs
"use strict";
const TOKEN = process.env.BRIDGE_TOKEN;
if (!TOKEN) { console.error("缺 BRIDGE_TOKEN"); process.exit(1); }

async function rpc(method, params, timeoutMs = 12000) {
  const r = await fetch("http://127.0.0.1:8778/rpc", {
    method: "POST",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ method, params, timeoutMs }),
  });
  return r.json();
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  → " + detail : ""}`);
  ok ? pass++ : fail++;
}

// 版本：断言 >= 修复引入的最低版本（0.3.3）。
// 不能写死具体版本——每次发版都得回来改脚本，改漏了就会出现"功能正常但测试失败"的假红。
const MIN_VERSION = [0, 3, 3];
const st = await rpc("bridge.status", {});
const ver = st.result?.version || "0.0.0";
const cmp = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};
check(`扩展版本 >= ${MIN_VERSION.join(".")}（已加载修复后的代码）`, cmp(ver, MIN_VERSION.join(".")) >= 0, `实际 ${ver}`);

// 1. 之前 128 次 UNKNOWN_METHOD 的三个真方法
for (const m of ["page.waitForReady", "page.waitForUrl", "page.waitForSelector"]) {
  const r = await rpc(m, { tabId: 1, timeoutMs: 1, match: "x", selector: "body" });
  const isUnknown = r.error?.code === "UNKNOWN_METHOD";
  check(`${m} 已注册`, !isUnknown, isUnknown ? "仍是 UNKNOWN_METHOD（扩展未重载）" : `返回 ${r.error?.code || "ok"}`);
}

// 2. 文档里写了但没实现的别名
for (const m of ["tabs.resolve", "tabs.openUrl", "page.open", "tabs.open", "tabs.new", "page.reload", "tabs.claim", "tabs.release"]) {
  // active:false —— 别名探测只是验证「方法已注册」，别把浏览器切到新 tab（污染用户当前页）
  const r = await rpc(m, { tabId: 1, url: "https://example.com", active: false, timeoutMs: 1 });
  const isUnknown = r.error?.code === "UNKNOWN_METHOD";
  check(`别名 ${m} 已兼容`, !isUnknown, isUnknown ? "UNKNOWN_METHOD" : `返回 ${r.error?.code || "ok"}`);
}

// 3. 真实 tab 上的等待方法
// 注意：扩展重载后旧标签页的 content script 会失效，随机挑一个来测会假红。
// 这里逐个候选做 tabs.prepare 探测，取第一个「可注入」的 tab——即测试自己保证前置条件。
const tabsR = await rpc("tabs.list", {});
const candidates = (tabsR.result?.tabs || []).filter(t => /^https?:/.test(t.url || "") && !t.discarded);
let tab = null;
for (const c of candidates) {
  const p = await rpc("tabs.prepare", { tabId: c.id }, 10000);
  if (p.ok) { tab = c; break; }
}
if (!tab) {
  console.log("（跳过真实 tab 测试：无可用 http tab，或全部不可注入——可先刷新任一 http 标签页）");
} else {
  const rr = await rpc("page.waitForReady", { tabId: tab.id, timeoutMs: 8000 }, 12000);
  check(`page.waitForReady 真机可用 (tab ${tab.id})`, rr.ok === true, JSON.stringify(rr.result || rr.error).slice(0, 120));
}

// 4. session.attach 幂等（旧版重复 attach 会报 Another debugger）
if (tab) {
  const a1 = await rpc("session.attach", { tabId: tab.id }, 15000);
  const a2 = await rpc("session.attach", { tabId: tab.id }, 15000);
  check("session.attach 幂等（第二次返回 already）", a2.ok === true && a2.result?.already === true, JSON.stringify(a2.result || a2.error).slice(0, 120));
  await rpc("session.detach", { tabId: tab.id }, 10000).catch(() => {});
}

// 5. 未 attach 就 send 应给出明确错误（旧版是 "Detached while handling command"）
if (tab) {
  const s = await rpc("session.send", { tabId: tab.id, method: "Runtime.evaluate", params: { expression: "1" } }, 10000);
  check("session.send 未 attach 时报 SESSION_NOT_ATTACHED", s.error?.code === "SESSION_NOT_ATTACHED", `实际 ${s.error?.code}`);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
