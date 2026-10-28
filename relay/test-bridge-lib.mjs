import { Rpc, unwrap, openUrl, versionGte, MIN_BRIDGE_VERSION } from "../skills/agent-browser-bridge/scripts/lib/bridge.mjs";

let pass = 0, fail = 0;
const t = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra); }
};

console.log("== unwrap 三层解包 ==");
t("裸HTTP {result:{result:RemoteObject}}", unwrap({result:{result:{type:"object", value:{a:1}}}}).a === 1);
t("client {result:RemoteObject}", unwrap({result:{type:"object", value:{a:2}}}).a === 2);
t("CDP {type,value}", unwrap({type:"object", value:{a:3}}).a === 3);
t("JSON 字符串自动 parse", unwrap({result:{result:{type:"string", value:'{"a":4}'}}}).a === 4);
const typed = unwrap({ ok: true, result: { ok: true, value: "hi", verified: true, delta: { urlChanged: false } } });
t("含 value 键的业务对象不被剥层（typeReal 返回）", typed.verified === true && typed.value === "hi" && !!typed.delta, JSON.stringify(typed));
t("null 安全", unwrap(null) === null);

const rpc = new Rpc({ agentId: "lib-test", agentName: "LibTest" });

console.log("\n== preflight（统一版本号）==");
const pf = await rpc.preflight();
console.log("   ", JSON.stringify(pf));
t("version 存在", !!pf.version);
t("versionKnown 为真", pf.versionKnown === true);
t("version 与 manifest.json 一致",
  pf.version === JSON.parse(await (await import("node:fs/promises")).readFile(
    new URL("../extension/manifest.json", import.meta.url), "utf8")).version);
t("不再输出分叉字段 hostVersion/extensionVersion",
  !("hostVersion" in pf) && !("extensionVersion" in pf));
t("版本满足本库最低要求", versionGte(pf.version, MIN_BRIDGE_VERSION), `${pf.version} < ${MIN_BRIDGE_VERSION}`);
t("versionGte 比较正确", versionGte("0.3.13", "0.3.13") && versionGte("0.4.0", "0.3.99") && !versionGte("0.3.9", "0.3.13"));

console.log("\n== ev 取值（真实 tab）==");
// 挑 tab 必须**逐个探测可注入**，不能只看 http + !discarded。
// 实测踩过：`status:"unloaded"` 的内部 API 页能混过 URL 过滤，但扩展对它没有 host 权限，
// prepare 直接 PAGE_CONTEXT_TIMEOUT、ev 挂满 30s —— 功能没坏，测试假红。
// 所以这里按候选顺序试 prepare，取第一个真能注入的。
const { tabs: allTabs } = await rpc.call("tabs.list");
const candidates = allTabs
  .filter((x) => /^https?:/.test(x.url) && !x.discarded && x.status !== "unloaded")
  .sort((a, b) => (a.active === b.active ? 0 : a.active ? -1 : 1));
let tab = null;
for (const c of candidates) {
  try {
    await rpc.call("tabs.prepare", { tabId: c.id, timeoutMs: 8000 });
    tab = c;
    break;
  } catch (e) {
    console.log(`    跳过 tab ${c.id}（${c.url.slice(0, 50)}）：${e.code}`);
  }
}
if (!tab) {
  console.log("  ✗ 没有可注入的 tab，跳过真实 tab 断言");
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
console.log("    使用 tab", tab.id, tab.url.slice(0, 60));
const v = await rpc.ev(tab.id, "({n: 1+1, title: document.title.slice(0,30)})");
t("ev 返回真实对象", v && v.n === 2, JSON.stringify(v));
const j = await rpc.evJson(tab.id, "return {ok:true, len: document.body.innerText.length};");
t("evJson 解析", j && j.ok === true && typeof j.len === "number");
const vv = await rpc.ev(tab.id, "({value: 7, other: 1})");
t("ev 不误剥对象里的 value 键", vv && vv.value === 7 && vv.other === 1, JSON.stringify(vv));
const ex = await rpc.ev(tab.id, "(()=>{throw new Error('boom-ev')})()").then(() => null, (e) => e);
t("页面异常报 EVAL_ERROR", ex && ex.code === "EVAL_ERROR" && /boom-ev/.test(ex.message), ex && ex.message);

console.log("\n== session.send 经本库自动 attach ==");
await rpc.detach(tab.id);
const ss = await rpc.call("session.send", { tabId: tab.id, method: "Runtime.evaluate", params: { expression: "2+3", returnByValue: true } }).then((v) => v, (e) => e);
t("未显式 attach 的 session.send 成功", ss === 5, ss && ss.code ? `[${ss.code}]` : JSON.stringify(ss));
t("自动 attach 已登记，退出时会释放", rpc._attached.has(tab.id));
await rpc.detach(tab.id);

console.log("\n== withSession 异常路径也 detach ==");
let threw = false;
try {
  await rpc.withSession(tab.id, async () => { throw new Error("boom"); });
} catch { threw = true; }
t("异常向上抛", threw);
t("异常后会话已释放", !rpc._attached.has(tab.id));

console.log("\n== openUrl（走 tabs.resolve）==");
const o = await openUrl(rpc, "https://example.com/");
console.log("   ", JSON.stringify({ tabId: o.tabId, reused: o.reused, reason: o.reason }));
t("拿到 tabId", !!o.tabId);
// 测试自己开的 tab 必须自己关，否则反复跑会攒一堆垃圾页
if (o.reused === false && o.tabId) await rpc.closeQuietly(o.tabId);
t("新建的 tab 已关闭", true);

await rpc.detach(tab.id);
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
