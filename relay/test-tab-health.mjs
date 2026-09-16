import { Rpc } from "../skills/agent-browser-bridge/scripts/lib/bridge.mjs";

const rpc = new Rpc({ agentId: "health-test", agentName: "HealthTest" });
let pass = 0, fail = 0;
const t = (n, c, e = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, e); } };

console.log("== 熔断：不存在的 tabId 连续失败 ==");
const DEAD = 999999999;
for (let i = 1; i <= 4; i++) {
  try { await rpc.ev(DEAD, "1"); console.log(`    第 ${i} 次: 未抛错（意外）`); }
  catch (e) { console.log(`    第 ${i} 次: ${e.code}`); }
}
t("达到阈值后标记为 unhealthy", rpc.isUnhealthy(DEAD));
t("strikes 计数正确", rpc._strikes.get(DEAD) >= 3, String(rpc._strikes.get(DEAD)));

console.log("\n== 熔断后快速失败（不再走网络）==");
const t0 = Date.now();
try { await rpc.ev(DEAD, "1"); } catch (e) { console.log("    错误码:", e.code); }
const ms = Date.now() - t0;
t("快速失败 < 200ms", ms < 200, `${ms}ms`);
t("错误码是 TAB_UNHEALTHY", await (async()=>{try{await rpc.ev(DEAD,"1")}catch(e){return e.code==="TAB_UNHEALTHY"}})());

console.log("\n== clearStrikes 可恢复 ==");
rpc.clearStrikes(DEAD);
t("清零后不再标记 unhealthy", !rpc.isUnhealthy(DEAD));

console.log("\n== withPage：选 tab + 验可注入 一步到位 ==");
try {
  const r = await rpc.withPage("https://example.com/", async (tabId) => {
    const title = await rpc.ev(tabId, "document.title");
    const ready = await rpc.ev(tabId, "document.readyState");
    return { tabId, title, ready };
  });
  console.log("    ", JSON.stringify(r));
  t("withPage 拿到可用 tab 并求值成功", !!r.title);
} catch (e) {
  t("withPage 正常", false, e.message);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
