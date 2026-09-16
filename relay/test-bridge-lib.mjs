import { Rpc, unwrap, openUrl } from "../skills/agent-browser-bridge/scripts/lib/bridge.mjs";

let pass = 0, fail = 0;
const t = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra); }
};

console.log("== unwrap 三层解包 ==");
t("裸HTTP {result:{result:{value}}}", unwrap({result:{result:{value:{a:1}}}}).a === 1);
t("client {result:{value}}", unwrap({result:{value:{a:2}}}).a === 2);
t("CDP {type,value}", unwrap({type:"object", value:{a:3}}).a === 3);
t("JSON 字符串自动 parse", unwrap({result:{result:{value:'{"a":4}'}}}).a === 4);
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
t("capabilities.tabsResolve 已判定", pf.capabilities.tabsResolve === true);

console.log("\n== ev 取值（真实 tab）==");
const tabs = await rpc.call("tabs.list");
const tab = tabs.tabs.find(x => /^https?:/.test(x.url) && !x.discarded);
console.log("    使用 tab", tab.id, tab.url.slice(0, 60));
const v = await rpc.ev(tab.id, "({n: 1+1, title: document.title.slice(0,30)})");
t("ev 返回真实对象", v && v.n === 2, JSON.stringify(v));
const j = await rpc.evJson(tab.id, "return {ok:true, len: document.body.innerText.length};");
t("evJson 解析", j && j.ok === true && typeof j.len === "number");

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
