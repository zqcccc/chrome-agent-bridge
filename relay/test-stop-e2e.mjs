// 真机 E2E：用户点页面上的「停止 Agent」→ 扩展 → host → 后续 RPC 被拦 → 恢复后放行。
//
// 为什么必须用真 Chrome：这条链路的关键环节（indicator 按钮 → background 闸门 →
// native event → host stopState）全都是**跨进程/跨扩展上下文**的，Node 里的桩测不到。
// 它已经抓到过两个只靠单测看不出来的 bug：
//   1. host 收到扩展上报的 agent.stop 只做 broadcastToAgent，自己的 stopState 没变 ——
//      界面停了但 HTTP 客户端照发。
//   2. 经 RPC 发的 agent.resume 只转发给扩展，host 状态不变 —— 两边状态分叉。
//
// 前置：扩展已加载并连上 host（扩展目录被单独更新过时先跑 `node agent/cli.mjs reload-ext`）。
// 用法: BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node relay/test-stop-e2e.mjs
//
// 注：本文件**不**接入 `npm test`（它需要真实浏览器）。属于 test:e2e 层。
import { Rpc } from "../skills/agent-browser-bridge/scripts/lib/bridge.mjs";
const rpc = new Rpc({ agentId: "stop-e2e", agentName: "StopE2E" });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, c, e = "") => { c ? (pass++, console.log("  ✓", n)) : (fail++, console.log("  ✗", n, e)); };
const U = "https://example.com/";
const isStoppedErr = (e) => e && e.code === "AGENT_STOPPED";
const status = async () => (await rpc.preflight(), await rpc.call("agent.stopStatus", {}, 8000));

await rpc.call("agent.resume", {}, 8000).catch(() => {});
const all = await rpc.call("tabs.list");
for (const tb of all.tabs || []) if (String(tb.url || "").startsWith(U)) await rpc.closeQuietly(tb.id).catch(() => {});
await sleep(600);

const id = (await rpc.call("tabs.create", { url: U, active: false }, 20000)).tab.id;
await sleep(1500);
await rpc.call("tabs.prepare", { tabId: id }, 20000);
await sleep(500);

// 交互类方法才会让「停止 Agent」按钮出现
await rpc.call("page.hover", { tabId: id, selector: "h1" }, 20000).catch(() => {});
await sleep(900);
const hasBtn = await rpc.ev(id, "!!document.getElementById('agent-bridge-stop') && document.getElementById('agent-bridge-stop').style.display !== 'none'");
t("停止按钮已出现在页面上", hasBtn === true, String(hasBtn));

// 前置：未停止时写操作不应报 AGENT_STOPPED
const pre = await rpc.call("page.click", { tabId: id, selector: "#not-here" }, 8000).catch(e => e);
t("点击前未被停止闸门拦住", !isStoppedErr(pre), pre && pre.code);

// 模拟用户真实点击停止按钮（完整链路：indicator → background → host）
await rpc.ev(id, "document.getElementById('agent-bridge-stop').click(); 'clicked'");
await sleep(1200);

t("停止按钮已隐藏", (await rpc.ev(id, "!document.getElementById('agent-bridge-stop') || document.getElementById('agent-bridge-stop').style.display === 'none'")) === true);

// 核心契约：写操作被拦，且 details 可编程读取、范围是 tab
const w = await rpc.call("page.click", { tabId: id, selector: "#x" }, 8000).catch(e => e);
t("写操作被停止闸门拦下", isStoppedErr(w), w && w.code);
t("details.resumeWith 可编程读取", w && w.detail && w.detail("resumeWith") === "agent.resume", w && JSON.stringify(w.details));
t("作用域是 tab，不是整机全停", w && w.detail && w.detail("scope") === "tab", w && JSON.stringify(w.details));
t("host /status 报告停止状态", (await status()).stopped === true);
t("host stopStatus 对当前 tab applicable", (await rpc.call("agent.stopStatus", { tabId: id }, 8000)).applicable === true);

// 观察/释放类不被拦：否则停止会把桥自己锁死
t("停止期间只读可用（page.info）", await rpc.call("page.info", { tabId: id }, 8000).then(() => true, e => e.code));
t("停止期间 session.attach 可用（不自锁）", await rpc.attach(id).then(() => true, e => e.code));
await rpc.detach(id).catch(() => {});

// 恢复（tab 级）
await rpc.call("agent.resume", { tabId: id }, 8000);
await sleep(700);
t("恢复后写操作放行", !isStoppedErr(await rpc.call("page.click", { tabId: id, selector: "#still-not-here" }, 8000).catch(e => e)));
t("恢复后 host 报告未停止", (await status()).stopped === false);

await rpc.closeQuietly(id).catch(() => {});
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
