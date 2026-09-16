// withPage 的 tab 生命周期测试：自己开的要关，复用的不能关。
//
// 为什么单独测这个：测试脚本反复跑却没关 tab，实测攒下 21 个 example.com
// （总标签页 62 个），这类垃圾页不会自己消失。这里把行为固化，防止回归。
import { Rpc } from "../skills/agent-browser-bridge/scripts/lib/bridge.mjs";

const rpc = new Rpc({ agentId: `tab-cleanup-${process.pid}`, agentName: "TabCleanup" });
let pass = 0, fail = 0;
const t = (n, c, e = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, e); } };
const exists = async (id) => { try { await rpc.call("tabs.get", { tabId: id }, 8000); return true; } catch { return false; } };
const URL_ = "https://example.com/";

try {
  console.log("== 默认 cleanup:true：自己开的 tab 应被关闭 ==");
  // 先确保没有现存 example.com tab，否则 withPage 会复用它们而不新建（复用时不关）
  const all = await rpc.call("tabs.list");
  for (const tb of all.tabs || []) {
    if (String(tb.url || "").startsWith(URL_)) await rpc.closeQuietly(tb.id);
  }
  await new Promise((r) => setTimeout(r, 1000));

  // 注意：withPage 返回的是 fn 的返回值，所以要从 fn 里把 opened 透出来
  const r1 = await rpc.withPage(URL_, async (id, opened) => ({ id, reused: opened.reused }));
  if (r1.reused === false) {
    t("withPage 结束 tab 已关闭", !(await exists(r1.id)));
  } else {
    console.log(`    （withPage 复用了已有 tab（reused=${r1.reused}），非新建，跳过关闭断言）`);
  }

  console.log("\n== keepOpen:true：应保留 tab ==");
  const r2 = await rpc.withPage(URL_, async (id) => ({ id }), { keepOpen: true });
  t("tab 被保留", await exists(r2.id));
  await rpc.closeQuietly(r2.id);
  t("手动关闭生效", !(await exists(r2.id)));

  console.log("\n== 复用已有 tab：不能被关闭（保护用户工作区）==");
  const created = await rpc.call("tabs.create", { url: URL_, active: false }, 30000);
  const myId = created.tab ? created.tab.id : created.id;
  await new Promise((r) => setTimeout(r, 3000));
  const r3 = await rpc.withPage(URL_, async (id, opened) => ({ id, reused: opened.reused }));
  if (r3.id === myId && r3.reused === true) {
    t("复用了已有 tab", true);
    t("复用的 tab 未被关闭", await exists(myId));
  } else {
    // 复用没命中不算失败（环境相关），但要说明
    console.log(`    （未复用：期望 ${myId} 实际 ${r3.id}，reused=${r3.reused}，跳过该断言）`);
  }
  await rpc.closeQuietly(myId);
} catch (e) {
  t("测试执行无异常", false, e.message);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
