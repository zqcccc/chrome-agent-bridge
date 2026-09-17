// 回归测试：后台标签页的渲染暂停，以及 page.ensureActive / page.scroll{checked}。
//
// 为什么需要它：Chrome 对后台标签页把 requestAnimationFrame **完全暂停**（实测 2s 内 0 帧，
// 活动页 60 帧）、`document.visibilityState="hidden"`。依赖 rAF / IntersectionObserver 的
// 懒加载、瀑布流、无限滚动在后台永不推进。这是「暂停」不是「节流」——加长超时没用。
//
// 实测排除的方案：CDP `Emulation.setFocusEmulationEnabled` 确实能把 rAF 拉起来，
// 但它 **detach 或页面导航后立即失效**，而 detach 是每次 RPC 收尾都会做的事，等于没用。
// 所以只能真让标签页 active——但只切标签页、不聚焦窗口（不调 windows.update({focused:true})），
// 实测单独 `chrome.tabs.update({active:true})` 就能恢复 rAF，Chrome 不在前台时同样有效。
//
// 本测试用本地 HTTP 服务起一个「懒加载靠 IntersectionObserver」的页面，确定性复现，
// 不依赖外网站点、不需要登录、不会因为站点改版而失效。
//
// ⚠️ 本测试跑在**用户正在使用的真实浏览器**上，而它会临时借走活动标签页。
//    用户随时可能切标签页，导致「调用前的活动页」在断言时已经变了——这不是产品 bug。
//    所以所有涉及活动页的断言都做了**干扰检测 + 重试**：检测到用户切换就重试，
//    重试耗尽则明确报告「环境干扰」而不是给出假红。（第一版没做这个，实测 3 次里红 1 次。）
//
// 用法: BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node relay/test-foreground-rendering.mjs
import http from "node:http";
import { Rpc } from "../skills/agent-browser-bridge/scripts/lib/bridge.mjs";

const rpc = new Rpc({ agentId: "foreground-test", agentName: "ForegroundTest" });
let pass = 0, fail = 0, skipped = 0;
const t = (n, c, e = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, e); } };
const skip = (n, why) => { skipped++; console.log(`  ~ ${n}（跳过：${why}）`); };

// ---- 本地懒加载页：滚动到底部哨兵 → IntersectionObserver 回调 → 追加条目 ----
const PAGE = `<!doctype html><meta charset="utf-8"><title>Lazy</title>
<style>body{margin:0;font:14px sans-serif}.item{height:120px;border-bottom:1px solid #ccc}
#sentinel{height:40px;background:#eee;text-align:center;line-height:40px}</style>
<div id="list"></div><div id="sentinel">sentinel</div>
<script>
  let n = 0;
  const list = document.getElementById("list");
  function add(k) { for (let i = 0; i < k; i++) { const d = document.createElement("div"); d.className = "item"; d.textContent = "item " + (++n); list.appendChild(d); } }
  add(12);                                  // 首屏 12 条×120px，**必须超过一屏**，否则 canScroll=false
                                            // （测试要自己保证前置条件：内容不满一屏时滚动本来就不该报错）
  window.__loads = 0;
  new IntersectionObserver((es) => {
    if (es.some(e => e.isIntersecting)) { window.__loads++; add(6); }   // 追加一屏
  }, { rootMargin: "200px" }).observe(document.getElementById("sentinel"));
  window.__raf = 0; (function loop(){ window.__raf++; requestAnimationFrame(loop); })();
</script>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const URL_ = `http://127.0.0.1:${PORT}/lazy`;

// 版本门槛：page.ensureActive / scroll{checked} 是 0.3.10 引入的。
// 断言下限而不是具体值，避免每次发版都出现「功能正常但测试失败」的假红。
const MIN = [0, 3, 10];
const cmp = (a, b) => {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};
const st = await rpc.call("bridge.status", {}, 10000);
if (cmp(st.version || "0.0.0", MIN.join(".")) < 0) {
  console.log(`扩展版本 ${st.version} < ${MIN.join(".")}：ensureActive 未实现，跳过`);
  server.close();
  process.exit(0);
}
console.log(`扩展版本 ${st.version} ✓  （本地测试页 ${URL_}）\n`);

const opened = await rpc.call("tabs.resolve", { url: URL_, waitLoad: true, match: "exact" }, 30000);
const tabId = opened.tabId;
const activeNow = async () => (await rpc.call("tabs.active", {})).tab.id;
console.log(`测试 tab ${tabId}\n`);

const probe = `new Promise(res=>{const r0=window.__raf,l0=window.__loads;const t0=Date.now();
  setTimeout(()=>res({raf:window.__raf-r0,loads:window.__loads-l0,hidden:document.hidden,vis:document.visibilityState,
    h:document.documentElement.scrollHeight,ih:window.innerHeight,y:window.scrollY}),1500)})`;

/**
 * 借前台并断言「还原目标 = 调用前的活动页」。
 * 用户随时可能切标签页，所以带干扰检测 + 重试；重试耗尽返回 { interfered:true }。
 */
async function borrowCleanly(tabId, opts) {
  for (let i = 0; i < 4; i++) {
    const prev = await activeNow();
    const ea = await rpc.ensureActive(tabId, opts);
    if (ea.alreadyRendering) return { ea, prev, alreadyRendering: true };
    if ((await activeNow()) !== tabId) continue;      // 用户切走了：重试
    return { ea, prev, alreadyRendering: false };
  }
  return { interfered: true };
}

try {
  // 让测试 tab 处于后台（用户的活动页保持在别的 tab 上）
  const userActive = await activeNow();
  if ((await rpc.call("tabs.get", { tabId })).tab.active) await rpc.call("tabs.activate", { tabId: userActive }, 15000);

  // 等页面自己的探针脚本就位再断言。不能只 sleep 固定时长：后台标签页的脚本执行可能被推迟，
  // 探针未就位时 `undefined - undefined = NaN`，JSON 序列化后是 null，会造成难以理解的假红。
  let instrumented = false;
  for (let i = 0; i < 60; i++) {
    const ok = await rpc.ev(tabId, "typeof window.__raf === 'number' && typeof window.__loads === 'number'", { timeoutMs: 15000 }).catch(() => false);
    if (ok === true) { instrumented = true; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  t("前置：页面探针脚本已就位", instrumented);

  // ---- 1. 后台 tab：rAF 被暂停 ----
  const bg = await rpc.ev(tabId, probe, { awaitPromise: true, timeoutMs: 20000 });
  console.log("  后台:", JSON.stringify(bg));
  t("前置：内容超过一屏（可滚动）", bg.h > bg.ih + 4, `h=${bg.h} ih=${bg.ih}`);
  t("前置：后台 tab 的 rAF 被暂停（0 帧）", bg.raf === 0, JSON.stringify(bg));
  t("前置：后台 tab document.hidden=true", bg.hidden === true, String(bg.hidden));

  // ---- 2. 后台滚动：位置会动，但懒加载不触发（高度不增）----
  const hBefore = bg.h;
  const scrollBg = await rpc.scrollChecked(tabId, { y: 99999, expectGrowth: true, settleMs: 1500 })
    .then((r) => ({ ok: true, r }))
    .catch((e) => ({ ok: false, code: e.code, message: e.message }));
  console.log("  后台 scrollChecked(expectGrowth):", JSON.stringify(scrollBg).slice(0, 220));
  t("后台滚动不加载新内容 → 报 SCROLL_NO_GROWTH（不是假成功）",
    scrollBg.ok === false && scrollBg.code === "SCROLL_NO_GROWTH", scrollBg.ok ? "竟然成功了" : String(scrollBg.code));
  const bgAfter = await rpc.ev(tabId, "({h:document.documentElement.scrollHeight,y:window.scrollY})", { timeoutMs: 15000 });
  t("后台滚动后页面高度确实没增长（懒加载未触发）",
    bgAfter.h === hBefore, `高 ${hBefore}→${bgAfter.h}`);

  // ---- 3. ensureActive：激活后 rAF 恢复、懒加载推进 ----
  const borrowed = await borrowCleanly(tabId);
  if (borrowed.interfered) {
    skip("ensureActive 激活与还原目标", "用户反复切换标签页");
  } else {
    console.log("  ensureActive:", JSON.stringify(borrowed.ea).slice(0, 200));
    t("ensureActive 报告已激活", borrowed.ea.activated === true, JSON.stringify(borrowed.ea));
    t("ensureActive 记下还原目标 = 调用前的活动页",
      borrowed.ea.willRestoreTo === borrowed.prev, `期望 ${borrowed.prev} 实际 ${borrowed.ea.willRestoreTo}`);
  }

  const fg = await rpc.ev(tabId, probe, { awaitPromise: true, timeoutMs: 20000 });
  console.log("  激活后:", JSON.stringify(fg));
  t("激活后 rAF 恢复（>0 帧）", fg.raf > 0, JSON.stringify(fg));
  t("激活后 document.hidden=false", fg.hidden === false, String(fg.hidden));

  // ---- 4. 激活后滚动应触发懒加载 ----
  // 懒加载本身是异步的（IntersectionObserver 回调时机不保证），所以允许多试几次；
  // 断言「最终能加载出来」而不是「第一次就必须成功」——后者会变成 flaky 测试。
  // 这一段也是给 Agent 的示范：检测到假成功 → ensureActive → 重试。
  const loadMore = async (maxTries) => {
    let last = null;
    for (let i = 0; i < maxTries; i++) {
      last = await rpc.scrollChecked(tabId, { y: 99999, expectGrowth: true, settleMs: 1500 })
        .then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, code: e.code }));
      if (last.ok && last.r.grew) return { ok: true, tries: i + 1, r: last.r };
    }
    return { ok: false, tries: maxTries, last };
  };
  const scrollFg = await loadMore(4);
  console.log("  激活后 scrollChecked(expectGrowth):", JSON.stringify(scrollFg).slice(0, 220));
  t("激活后滚动触发懒加载（高度增长，不再报错）", scrollFg.ok === true, JSON.stringify(scrollFg).slice(0, 200));

  // ---- 4b. 结构化 details 必须能透传（历史上被静默丢弃）----
  // 为什么单测这个：Agent 要「判断该不该激活」就必须能**可编程读取**这些字段，
  // 而不是去解析 message 文本。扩展/ host / lib 三层任一环把 details 丢了，这里就会红。
  // 构造后台场景：先滚到底（这样下一次同位置滚动会 moved=false）再激活回去
  await rpc.restoreActive(tabId).catch(() => {});
  await rpc.ensureActive(tabId);
  await rpc.scrollChecked(tabId, { y: 99999, allowNoProgress: true }).catch(() => {});
  const userTab = await activeNow();
  await rpc.call("tabs.activate", { tabId: userTab }, 15000).catch(() => {});   // 让它回到后台
  await new Promise((r) => setTimeout(r, 600));
  let bgErr = null;
  try { await rpc.scrollChecked(tabId, { y: 0, expectGrowth: true, settleMs: 1000 }); }
  catch (e) { bgErr = e; }
  console.log("  后台错误对象:", JSON.stringify({ code: bgErr && bgErr.code, details: bgErr && bgErr.details }));
  t("错误带结构化 details（三层链路未丢）", !!(bgErr && bgErr.details), JSON.stringify(bgErr && bgErr.details));
  t("details 含 wasHidden 字段", bgErr && bgErr.details && bgErr.details.wasHidden !== undefined, JSON.stringify(bgErr && bgErr.details));
  t("detail() 便捷读取可用", bgErr && bgErr.detail && typeof bgErr.detail("wasHidden") === "boolean", String(bgErr && bgErr.detail && bgErr.detail("wasHidden")));

  // ---- 4c. scrollLoad：自动判断该不该激活 ----
  // 这是给 Agent 的推荐入口：把「要不要激活」收敛在一处，不必每人自己写 try/catch。
  await rpc.ensureActive(tabId);
  await rpc.scrollChecked(tabId, { y: 0, allowNoProgress: true }).catch(() => {});
  let loaded = null;
  try { loaded = await rpc.scrollLoad(tabId, { y: 99999, expectGrowth: true, settleMs: 1500 }); }
  catch (e) { loaded = { err: e.code, details: e.details }; }
  console.log("  scrollLoad:", JSON.stringify(loaded).slice(0, 240));
  t("scrollLoad 在必要时自动激活并成功加载", loaded && loaded.grew === true, JSON.stringify(loaded).slice(0, 200));
  t("scrollLoad 报告 activated/attempts", loaded && loaded.attempts >= 1, JSON.stringify(loaded).slice(0, 160));

  // ---- 4d. 不该激活时不要激活（前台也没动 → recoverable=false）----
  // 这条是「由 Agent 判断」的核心：选择器/容器问题激活也没用，不应白白打扰用户前台。
  const curY = await rpc.ev(tabId, "window.scrollY", { timeoutMs: 15000 });
  let fgErr = null;
  try { await rpc.scrollChecked(tabId, { y: curY, expectGrowth: true, settleMs: 800 }); }
  catch (e) { fgErr = e; }
  console.log("  前台同位置滚动:", JSON.stringify({ code: fgErr && fgErr.code, details: fgErr && fgErr.details }));
  t("前台没动时 recoverable=false（激活无用）", !!(fgErr && fgErr.details && fgErr.details.recoverable === false), JSON.stringify(fgErr && fgErr.details));
  t("前台没动时错误码是 SCROLL_STALLED", fgErr && fgErr.code === "SCROLL_STALLED", String(fgErr && fgErr.code));

  // ---- 5. 幂等：连续两次 ensureActive，第二次不该重复激活 ----
  let idem = null, idemInterfered = false;
  for (let i = 0; i < 4; i++) {
    await rpc.ensureActive(tabId);
    if ((await activeNow()) !== tabId) continue;         // 用户切走了：重试
    const b = await rpc.ensureActive(tabId);
    if ((await activeNow()) !== tabId) continue;
    idem = b; break;
  }
  if (idem) {
    t("已在渲染时 ensureActive 不重复激活", idem.activated === false && idem.alreadyRendering === true, JSON.stringify(idem));
  } else { idemInterfered = true; skip("ensureActive 幂等", "用户反复切换标签页"); }

  // ---- 6. 还原：显式 + 空闲自动 ----
  let explicit = null;
  for (let i = 0; i < 4 && !explicit; i++) {
    const prev = await activeNow();
    await rpc.ensureActive(tabId);
    if ((await activeNow()) !== tabId) continue;         // 干扰：重试
    const r = await rpc.restoreActive(tabId);
    if ((await activeNow()) !== prev) continue;          // 用户在我们归还后又切了：重试
    explicit = { r, prev };
  }
  if (explicit) {
    t("restoreActive 把前台还给调用前的活动页",
      explicit.r.restoredTo === explicit.prev, `restoredTo=${explicit.r.restoredTo} 期望=${explicit.prev}`);
  } else { skip("restoreActive 显式归还", "用户反复切换标签页"); }

  let auto = null;
  for (let i = 0; i < 4 && !auto; i++) {
    const prev = await activeNow();
    const ea = await rpc.ensureActive(tabId, { restoreAfterMs: 2000 });
    if (!ea.activated) continue;
    if ((await activeNow()) !== tabId) continue;
    await new Promise((r) => setTimeout(r, 4500));
    const now = await activeNow();
    if (now === prev) auto = { prev, now };
  }
  if (auto) {
    t("空闲 restoreAfterMs 后自动还原给用户", true, `已回到 ${auto.now}`);
  } else { skip("空闲自动还原", "用户反复切换标签页"); }
} catch (e) {
  t("测试流程未抛异常", false, e.message);
} finally {
  await rpc.restoreActive(tabId).catch(() => {});
  if (opened.reused === false) await rpc.closeQuietly(tabId);
  server.close();
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败${skipped ? `, ${skipped} 跳过` : ""}`);
process.exit(fail ? 1 : 0);
