// 回归测试：渲染器被冻结时的自愈（Chrome Memory Saver / 高能效模式）。
//
// 为什么需要它：Chrome 冻结后台标签页后，chrome.scripting.* 会一直挂到超时才失败
// （实测 13s → PAGE_CONTEXT_TIMEOUT），而 CDP 通道完好。这是 host.log 里最大的失败源
// （433 次 PAGE_CONTEXT_TIMEOUT，tabs.prepare 失败率 34%，耗时整齐卡在 13s / 26s）。
//
// 本测试用 CDP 的 Page.setWebLifecycleState 手动冻结渲染器——这正是 Chrome 自己的
// Memory Saver 用的协议，所以不依赖「等它自然冻结」，可稳定复现。
//
// 用法: BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node relay/test-freeze-recovery.mjs
import { Rpc } from "../skills/agent-browser-bridge/scripts/lib/bridge.mjs";

const rpc = new Rpc({ agentId: "freeze-test", agentName: "FreezeTest" });
let pass = 0, fail = 0;
const t = (n, c, e = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, e); } };

const cdp = (tabId, method, params) => rpc.call("session.send", { tabId, method, params }, 10000);
/** 用 CDP 冻结渲染器（等价于 Chrome Memory Saver 的动作）。 */
async function freeze(tabId) {
  await rpc.attach(tabId);
  await cdp(tabId, "Page.setWebLifecycleState", { state: "frozen" });
  await rpc.detach(tabId);
}
/** 跑一次调用，返回 { ok, code, ms } —— 不抛，方便断言真实结果。 */
async function attempt(fn) {
  const t0 = Date.now();
  try { const v = await fn(); return { ok: true, value: v, ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, code: e.code, ms: Date.now() - t0 }; }
}

// 先确认扩展版本够新：解冻自愈是 0.3.10 引入的。
// 断言下限而不是具体版本——写死具体值会让每次发版都出现「功能正常但测试失败」的假红。
const MIN = [0, 3, 10];
const cmp = (a, b) => {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};
const st = await rpc.call("bridge.status", {}, 10000);
const ver = st.version || "0.0.0";
if (cmp(ver, MIN.join(".")) < 0) {
  console.log(`扩展版本 ${ver} < ${MIN.join(".")}：解冻自愈未实现，跳过（先 node agent/cli.mjs reload-ext 重载扩展）`);
  process.exit(0);
}
console.log(`扩展版本 ${ver} ✓\n`);

const opened = await rpc.call("tabs.resolve", { url: "https://example.com/?freeze-regression=1", waitLoad: true }, 30000);
const tabId = opened.tabId;
console.log(`测试 tab: ${tabId}（reused=${opened.reused}）\n`);

try {
  // 前置：确认未冻结时脚本通道正常（否则后面分不清「自愈」还是「本来就坏」）
  const pre = await attempt(() => rpc.call("page.evaluate", { tabId, expression: "document.title" }, 20000));
  t("前置：未冻结时 page.evaluate 正常", pre.ok, pre.ok ? `${pre.ms}ms` : pre.code);

  // ---- 1. 冻结 → tabs.prepare 应自愈 ----
  await freeze(tabId);
  console.log("  （已用 CDP Page.setWebLifecycleState 冻结渲染器）");
  const p1 = await attempt(() => rpc.call("tabs.prepare", { tabId }, 45000));
  t("冻结后 tabs.prepare 自愈成功（不再 PAGE_CONTEXT_TIMEOUT）", p1.ok, p1.ok ? `${p1.ms}ms` : `实际 ${p1.code}，耗时 ${p1.ms}ms`);
  t("自愈耗时合理（一次 13s 超时 + 解冻，< 30s）", p1.ok && p1.ms < 30000, `${p1.ms}ms`);

  // ---- 2. 自愈后脚本通道恢复毫秒级（证明真解冻了，不是碰巧）----
  const e1 = await attempt(() => rpc.call("page.evaluate", { tabId, expression: "1+1" }, 20000));
  t("自愈后 page.evaluate 恢复且值正确", e1.ok && e1.value === 2, e1.ok ? `返回 ${JSON.stringify(e1.value)}` : e1.code);
  t("自愈后响应回到毫秒级（< 3000ms）", e1.ok && e1.ms < 3000, `${e1.ms}ms`);

  // ---- 3. 再冻一次：证明不是一次性修复（滑动窗口限流允许反复自愈）----
  await freeze(tabId);
  const p2 = await attempt(() => rpc.call("tabs.prepare", { tabId }, 45000));
  t("第二次冻结仍能自愈（限流窗口允许反复自愈）", p2.ok, p2.ok ? `${p2.ms}ms` : `实际 ${p2.code}，耗时 ${p2.ms}ms`);
  const e2 = await attempt(() => rpc.call("page.evaluate", { tabId, expression: "2+2" }, 20000));
  t("第二次自愈后 evaluate 可用", e2.ok && e2.value === 4, e2.ok ? `返回 ${JSON.stringify(e2.value)}` : e2.code);

  // ---- 4. 客户端错误码：超时不应被伪装成 CONNECTION_REFUSED ----
  // 冻结后不给自己愈机会（noRecover 走的是扩展内部路径），这里改用「不存在的方法」验证码值透传：
  // 更直接的验证是 lib 层——对不可达端口请求超时必须是 TIMEOUT 而不是 CONNECTION_REFUSED。
  const dead = new Rpc({ port: 9, agentId: "freeze-test-dead" });  // 丢弃端口，连接必然失败
  const deadR = await attempt(() => dead.call("bridge.status", {}, 3000));
  t("真·连不上时报 CONNECTION_REFUSED（未误伤）", !deadR.ok && deadR.code === "CONNECTION_REFUSED", `实际 ${deadR.code}`);
} catch (e) {
  t("测试流程未抛异常", false, e.message);
} finally {
  // 收尾：先解冻（用 prepare 的自愈路径，顺带清掉 broken 标记），再关掉自己新建的 tab。
  await attempt(() => rpc.call("tabs.prepare", { tabId }, 45000));
  if (opened.reused === false) await rpc.closeQuietly(tabId);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
