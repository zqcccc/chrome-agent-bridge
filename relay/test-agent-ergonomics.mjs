// 真机回归：Agent 易用性相关的四处行为（v0.3.15）。
//   0. 后台标签页：clickReal / typeReal{pressEnter} 报 TAB_HIDDEN（曾 6s 后回 ok:true 但页面无反应），
//      scripts/lib/bridge.mjs 的封装自动 ensureActive 后重试
//   1. clickReal / typeReal 的 delta 与 DOM 动作同形（含 mutationCount），密码框 verified 可用且值脱敏
//   2. 同一原因（tab 已关）各入口统一报 TAB_GONE
//   3. RPC 版 tabs.claim / tabs.release 走 host 租约账本
//   4. UNKNOWN_METHOD 带 suggestions；help / bridge.methods 返回方法清单
// 本地起页面确定性复现，不依赖外网。
// 用法: BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node relay/test-agent-ergonomics.mjs
import http from "node:http";
import { Rpc } from "../skills/agent-browser-bridge/scripts/lib/bridge.mjs";

const rpcA = new Rpc({ agentId: "ergo-a", agentName: "ErgoA" });
const rpcB = new Rpc({ agentId: "ergo-b", agentName: "ErgoB" });
let pass = 0, fail = 0;
const t = (n, c, e = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, e); } };
const err = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e.code, message: e.message, details: e.details }; } };

const PAGE = `<!doctype html><meta charset="utf-8"><title>ergo</title>
<button id="add" onclick="for(let i=0;i<3;i++){const d=document.createElement('div');d.textContent='row'+i;document.body.appendChild(d)}">add</button>
<form id="f" onsubmit="event.preventDefault();window.__sub=(window.__sub||0)+1"><input id="q" placeholder="q"></form>
<input id="pw" type="password">
<a id="nav" href="/next">next</a>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(req.url.startsWith("/next") ? "<!doctype html><title>next</title><p>next page</p>" : PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${server.address().port}/?t=${process.pid}`;

const opened = await rpcA.call("tabs.resolve", { url: URL_, waitLoad: true, match: "exact" }, 30000);
const tabId = opened.tabId;
console.log(`测试页 tab ${tabId}\n`);

try {
  console.log("== 0. 后台标签页 ==");
  {
    const hidden = await rpcA.ev(tabId, "document.hidden");
    if (!hidden) {
      console.log("  （跳过：测试页不是后台标签页，可能用户正切到它）");
    } else {
      const c = await err(() => rpcA.call("page.clickReal", { tabId, selector: "#add" }));
      t("raw clickReal 报 TAB_HIDDEN", !c.ok && c.code === "TAB_HIDDEN", c.ok ? "未抛错" : c.code);
      t("TAB_HIDDEN 带 recoverable", !c.ok && c.details && c.details.recoverable === true, JSON.stringify(c.details));
      const ty = await err(() => rpcA.call("page.typeReal", { tabId, selector: "#q", text: "zzz", pressEnter: true }));
      t("raw typeReal{pressEnter} 报 TAB_HIDDEN", !ty.ok && ty.code === "TAB_HIDDEN", ty.ok ? "未抛错" : ty.code);
      t("报错时输入框未被改动", (await rpcA.ev(tabId, "document.querySelector('#q').value")) === "");
    }
  }

  console.log("\n== 1. CDP 动作的 delta ==");
  {
    const c = await err(() => rpcA.clickReal(tabId, "#add"));
    t("clickReal 成功", c.ok, c.ok ? "" : `[${c.code}] ${c.message}`);
    const d = c.ok && c.value.delta;
    t("clickReal delta 含 mutationCount 且 > 0", d && d.mutationCount > 0, JSON.stringify(d));
    t("clickReal delta 含 mutations 明细", d && d.mutations && d.mutations.added >= 3, JSON.stringify(d && d.mutations));

    const ty = await err(() => rpcA.typeReal(tabId, "#q", "hello bridge"));
    t("typeReal verified", ty.ok && ty.value.verified === true, JSON.stringify(ty.value || ty));
    t("typeReal 回读值正确", ty.ok && ty.value.value === "hello bridge", ty.ok ? ty.value.value : "");
    t("typeReal delta 含 mutationCount 字段", ty.ok && typeof ty.value.delta.mutationCount === "number", JSON.stringify(ty.value && ty.value.delta));

    const ent = await err(() => rpcA.typeReal(tabId, "#q", "submit me", { pressEnter: true }));
    t("typeReal{pressEnter} 触发表单提交", ent.ok && (await rpcA.ev(tabId, "window.__sub || 0")) === 1, JSON.stringify(ent.value || ent).slice(0, 120));

    const pw = await err(() => rpcA.typeReal(tabId, "#pw", "s3cret-pass"));
    t("密码框 typeReal verified", pw.ok && pw.value.verified === true, JSON.stringify(pw.value || pw));
    t("密码框返回值已脱敏", pw.ok && pw.value.value === "[value redacted]" && pw.value.delta.activeValue === "[value redacted]", JSON.stringify(pw.value));

    const nav = await err(() => rpcA.clickReal(tabId, "#nav"));
    t("导航点击成功", nav.ok, nav.ok ? "" : `[${nav.code}] ${nav.message}`);
    const nd = nav.ok && nav.value.delta;
    t("导航后 delta.urlChanged=true", nd && nd.urlChanged === true && /\/next/.test(nd.url), JSON.stringify(nd));
  }

  console.log("\n== 2. tab 已关统一报 TAB_GONE ==");
  {
    const tmp = (await rpcA.call("tabs.create", { url: "about:blank", active: false })).tab;
    await rpcA.call("tabs.close", { tabId: tmp.id });
    for (const [label, fn] of [
      ["page.clickReal", () => rpcA.call("page.clickReal", { tabId: tmp.id, x: 1, y: 1 })],
      ["page.evalCdp", () => rpcA.call("page.evalCdp", { tabId: tmp.id, expression: "1" })],
      ["session.attach", () => rpcA.call("session.attach", { tabId: tmp.id })],
      ["page.read", () => rpcA.call("page.read", { tabId: tmp.id }, 20000)],
      ["tabs.get", () => rpcA.call("tabs.get", { tabId: tmp.id })],
    ]) {
      const r = await err(fn);
      t(`${label} → TAB_GONE`, !r.ok && r.code === "TAB_GONE", r.ok ? "未抛错" : `[${r.code}] ${String(r.message).slice(0, 80)}`);
    }
  }

  console.log("\n== 3. RPC 版 tabs.claim 走 host 租约 ==");
  {
    const c = await err(() => rpcA.call("tabs.claim", { tabId, ttlMs: 30000 }));
    t("A 申请租约成功并返回 expiresAt", c.ok && typeof c.value.expiresAt === "number", JSON.stringify(c.value || c));
    const b = await err(() => rpcB.call("page.info", { tabId }));
    t("B 访问被拒 TAB_LEASED", !b.ok && b.code === "TAB_LEASED", b.ok ? "未被拒" : b.code);
    const rel = await err(() => rpcA.call("tabs.release", { tabId }));
    t("A 释放成功", rel.ok && rel.value.released === true, JSON.stringify(rel.value || rel));
    const b2 = await err(() => rpcB.call("page.info", { tabId }));
    t("释放后 B 可访问", b2.ok, b2.ok ? "" : b2.code);
  }

  console.log("\n== 4. 方法发现 ==");
  {
    const u = await err(() => rpcA.call("page.eval", { tabId }));
    t("未登记方法报 UNKNOWN_METHOD", !u.ok && u.code === "UNKNOWN_METHOD", u.code);
    t("details.suggestions 含 page.evaluate", !u.ok && u.details && u.details.suggestions.includes("page.evaluate"), JSON.stringify(u.details));
    const h = await err(() => rpcA.call("help"));
    t("help 返回方法清单", h.ok && Array.isArray(h.value.methods) && h.value.methods.length > 50, h.ok ? `${h.value.methods.length} 个` : h.code);
    const one = await err(() => rpcA.call("bridge.methods", { name: "page.clickReal" }));
    t("bridge.methods 按名查询", one.ok && one.value.params && one.value.params.selector, JSON.stringify(one.value || one).slice(0, 80));
  }
} finally {
  await rpcA.call("tabs.release", { tabId }).catch(() => {});
  await rpcA.closeQuietly(tabId);
  server.close();
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
