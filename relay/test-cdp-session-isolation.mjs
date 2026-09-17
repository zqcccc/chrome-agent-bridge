// 回归测试：CDP 调试会话隔离 —— 扩展内部借用调试器时不得拆掉 agent 的会话。
//
// 背景（三个真实故障，同一个根因）：
//   扩展里原本有 4 处「chrome.debugger.attach → sendCommand → detach」的裸写法
//   （CDP 兜底求值 / CDP 截图 / 渲染器解冻 / agent 会话），前 3 处都**无条件 detach**。
//   而 `rpc.ev()` 会先 `session.attach` 建立 agent 自己的会话，于是：
//
//   1. **严格 CSP 站点**（linkedin.com / github.com / chatgpt.com）
//      `page.evaluate` 注入的 eval() 被 CSP 拦 → 走 CDP 兜底 → 兜底把 agent 会话拆了。
//      后果 A：兜底自己因 detach/sendCommand 竞态拿不到结果，抛出的却是 `EVAL_ERROR`
//              （错误信息指向 CSP，完全看不出是兜底拆的会话）。
//      后果 B：下一次 `ev()` 报 `SESSION_SEND_FAILED`「Debugger is not attached」。
//   2. **agent 持有会话时截图** → attach 报「Another debugger is already attached」，
//      截图直接失败（而不是复用会话）。
//   3. **agent 持有会话时渲染器被冻结** → 解冻的 attach 失败，**自愈静默失效**，
//      仍要空等 13s 才报 `PAGE_CONTEXT_TIMEOUT`（本仓库最大的失败源之一）。
//
// 修法：收敛成 `withBorrowedDebugger()`（扩展内唯一入口）——「谁借的谁还」，
// agent 已持有会话时复用且绝不拆。详见 extension/background.js 该函数注释。
//
// 全部用本地页面确定性复现，不依赖外网站点与登录态。
//
// 用法: BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node relay/test-cdp-session-isolation.mjs
import http from "node:http";
import { Rpc } from "../skills/agent-browser-bridge/scripts/lib/bridge.mjs";

const rpc = new Rpc({ agentId: "cdp-iso-test", agentName: "CdpIsolationTest" });
let pass = 0, fail = 0;
const t = (n, c, e = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, e); } };
const err = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } };

// 本地 CSP 页：`script-src 'self'` 无 'unsafe-eval' → page.evaluate 必走 CDP 兜底
const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'",
  });
  res.end(`<!doctype html><meta charset="utf-8"><title>CSP</title><h1>csp</h1>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${server.address().port}/csp?t=${process.pid}`;

// 唯一 URL + match:"exact"：避免复用环境里已有的同域 tab（复用会让断言失去意义）
const opened = await rpc.call("tabs.resolve", { url: URL_, waitLoad: true, match: "exact" }, 30000);
const tabId = opened.tabId;
console.log(`CSP 测试页 tab ${tabId}\n`);

try {
  // ── 1. CSP 兜底本身要能拿到结果 ──
  console.log("== 1. page.evaluate 在严格 CSP 站点兜底到 CDP ==");
  {
    const r = await err(() => rpc.call("page.evaluate", { tabId, expression: "6*7" }, 20000));
    t("兜底成功且不报 EVAL_ERROR", r.ok, r.ok ? "" : `[${r.code}] ${String(r.message).slice(0, 110)}`);
    t("兜底返回值正确", r.ok && r.value === 42, JSON.stringify(r.value));
  }

  // ── 2. 兜底不得拆掉 agent 的会话（故障 1） ──
  console.log("\n== 2. 兜底不得拆掉 agent 已有的 CDP 会话 ==");
  {
    const a = await err(() => rpc.ev(tabId, "1+1"));
    t("ev 建立会话成功", a.ok, a.ok ? "" : `[${a.code}]`);

    const b = await err(() => rpc.call("page.evaluate", { tabId, expression: "8*8" }, 20000));
    t("兜底调用成功", b.ok, b.ok ? "" : `[${b.code}] ${String(b.message).slice(0, 110)}`);

    const c = await err(() => rpc.ev(tabId, "3+3"));
    t("兜底后 ev 仍可用（会话未被拆）", c.ok, c.ok ? "" : `[${c.code}] ${String(c.message).slice(0, 130)}`);
    t("错误码不是 SESSION_SEND_FAILED", c.ok || c.code !== "SESSION_SEND_FAILED", c.code || "");

    const d = await err(() =>
      rpc.call("session.send", { tabId, method: "Runtime.evaluate", params: { expression: "10*10", returnByValue: true } }, 15000)
    );
    t("兜底后 session.send 直连可用", d.ok, d.ok ? "" : `[${d.code}]`);
  }

  // ── 3. agent 持有会话时截图要复用会话，而不是失败（故障 2） ──
  console.log("\n== 3. agent 持有会话时 page.screenshot 复用会话 ==");
  {
    // 自己先建立会话：本节要独立成立，不能依赖上一节留下的状态
    // （否则上一节把会话拆掉后，本节「碰巧」attach 成功，断言就白做了——实测踩过）
    const a = await err(() => rpc.ev(tabId, "1"));
    t("前置：先让 agent 持有会话", a.ok, a.ok ? "" : `[${a.code}]`);

    const s = await err(() => rpc.call("page.screenshot", { tabId, format: "png" }, 25000));
    t("截图成功（不再 Another debugger）", s.ok, s.ok ? "" : `[${s.code}] ${String(s.message).slice(0, 110)}`);
    t("截图返回了图像数据", s.ok && typeof s.value.image === "string" && s.value.image.startsWith("data:image/"), s.ok ? String(s.value.image).slice(0, 24) : "");
    const after = await err(() => rpc.ev(tabId, "5+5"));
    t("截图后 ev 仍可用（会话未被拆）", after.ok, after.ok ? "" : `[${after.code}] ${String(after.message).slice(0, 130)}`);
  }

  // ── 4. agent 持有会话时冻结自愈必须仍生效（故障 3） ──
  console.log("\n== 4. agent 持有会话时冻结自愈仍生效 ==");
  {
    // 同样先确保会话在 agent 手上（这正是 rpc.ev 的常态）
    const a = await err(() => rpc.ev(tabId, "2"));
    t("前置：先让 agent 持有会话", a.ok, a.ok ? "" : `[${a.code}]`);

    // 用 CDP 手动冻结渲染器（Chrome Memory Saver 用的同一协议），不依赖等它自然冻结
    await rpc.call("session.send", { tabId, method: "Page.setWebLifecycleState", params: { state: "frozen" } }, 10000);
    console.log("    （已冻结渲染器）");
    const t0 = Date.now();
    const p = await err(() => rpc.call("tabs.prepare", { tabId }, 45000));
    const ms = Date.now() - t0;
    t("冻结后自愈成功（不再 PAGE_CONTEXT_TIMEOUT）", p.ok, p.ok ? `${ms}ms` : `实际 ${p.code}，耗时 ${ms}ms`);
    // 耗时说明：第一次 scripting 调用必须先耗完 13s 超时才轮到解冻，所以 13s 上下是**正常**的，
    // 不要断言「很快」——那会写成假红。真正的证据是**下一次调用回到毫秒级**（说明真解冻了）。
    t("自愈耗时符合「一次 13s 超时 + 解冻」（< 30s）", p.ok && ms < 30000, `${ms}ms`);

    const t1 = Date.now();
    const q = await err(() => rpc.ev(tabId, "1+1"));
    const qms = Date.now() - t1;
    t("自愈后求值恢复且值正确", q.ok && q.value === 2, q.ok ? JSON.stringify(q.value) : `[${q.code}]`);
    t("自愈后响应回到毫秒级（证明真解冻，不是碰巧）", q.ok && qms < 3000, `${qms}ms`);
  }

  // ── 5. 交替操作不累积故障 ──
  console.log("\n== 5. 兜底 / 截图 / ev 交替 2 轮不劣化 ==");
  {
    let ok = 0, lastErr = null;
    for (let i = 0; i < 2; i++) {
      const e1 = await err(() => rpc.ev(tabId, `${i}+100`));
      const e2 = await err(() => rpc.call("page.evaluate", { tabId, expression: `${i}*2` }, 20000));
      const e3 = await err(() => rpc.call("page.screenshot", { tabId, format: "jpeg", quality: 60 }, 25000));
      if (e1.ok && e2.ok && e3.ok) ok++;
      else lastErr = [e1, e2, e3].find((x) => !x.ok);
    }
    t("2 轮全部成功", ok === 2, `${ok}/2${lastErr ? ` last=[${lastErr.code}] ${String(lastErr.message).slice(0, 100)}` : ""}`);
  }
} finally {
  await rpc.detach(tabId);
  await rpc.closeQuietly(tabId);
  server.close();
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
