// 真机回归：Firefox 版扩展 + CDP→BiDi 翻译层。
//
// 自己准备前置条件，不碰用户日常 Firefox：
//   独立 profile（relay/.firefox-e2e/profile）+ 独立 BiDi 端口 + 独立 host 端口，跑完关掉这个实例。
// 断言的是「Agent 视角与 Chrome 一致」：同样的 RPC、同样的返回形状、同样的错误码。
//
// 用法: node relay/test-firefox-e2e.mjs
// 前置: 已执行 bash relay/install-host.sh --browser firefox（注册 native host）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Rpc } from "../skills/agent-browser-bridge/scripts/lib/bridge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK_DIR = path.join(HERE, ".firefox-e2e");
const PROFILE = path.join(WORK_DIR, "profile");
const HOST_PORT = Number(process.env.FF_E2E_HOST_PORT || 8790);
const BIDI_PORT = Number(process.env.FF_E2E_BIDI_PORT || 9223);
const FIREFOX_BIN = process.env.FIREFOX_BIN || "/Applications/Firefox.app/Contents/MacOS/firefox";
const NATIVE_MANIFEST = path.join(process.env.HOME, "Library/Application Support/Mozilla/NativeMessagingHosts/com.agentbrowser.bridge.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, c, e = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, e); } };
const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } };

function killTestFirefox() {
  try { execFileSync("pkill", ["-f", `profile ${PROFILE}`]); } catch (e) { /* 没有在跑 */ }
}

async function status() {
  try {
    const r = await fetch(`http://127.0.0.1:${HOST_PORT}/status`);
    return await r.json();
  } catch (e) {
    return null;
  }
}

async function waitFor(pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await pred();
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`等待超时(${timeoutMs}ms): ${label}`);
}

// ---------- 前置条件 ----------
if (!fs.existsSync(NATIVE_MANIFEST)) {
  console.error(`缺少 Firefox native host 注册: ${NATIVE_MANIFEST}\n先执行: bash relay/install-host.sh --browser firefox`);
  process.exit(2);
}
killTestFirefox();
await sleep(1000);
fs.mkdirSync(PROFILE, { recursive: true });
// 关掉首次启动页与默认浏览器检查，避免抢占第一个 tab
fs.writeFileSync(path.join(PROFILE, "user.js"), [
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  'user_pref("browser.aboutwelcome.enabled", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
].join("\n") + "\n");
const launch = spawnSync(process.execPath, [path.join(HERE, "firefox-launch.js"), "--profile", PROFILE, "--bidi-port", String(BIDI_PORT)], {
  env: { ...process.env, AGENT_BRIDGE_PORT: String(HOST_PORT) }, encoding: "utf8", timeout: 60000,
});
process.stdout.write(launch.stdout);
if (launch.status !== 0) {
  console.error(launch.stderr);
  process.exit(2);
}
await waitFor(async () => { const s = await status(); return s && s.extConnected; }, 20000, "扩展连上 host");

const rpc = new Rpc({ port: HOST_PORT, agentId: "ff-e2e", agentName: "FirefoxE2E" });

// ---------- 本地测试页 ----------
const FORM_PAGE = `<!doctype html><meta charset="utf-8"><title>ff-e2e</title>
<body style="height:3000px">
<form id="f"><input id="inp"><textarea id="ta"></textarea><div id="ce" contenteditable="true" style="min-height:20px;border:1px solid"></div>
<input id="file" type="file"></form>
<button id="btn" style="position:absolute;left:40px;top:200px;width:120px;height:40px">click</button>
<script>
  window.__log = [];
  document.getElementById("btn").addEventListener("click", (e) => __log.push(["click", e.isTrusted]));
  document.addEventListener("keydown", (e) => __log.push(["keydown", e.key, e.isTrusted]));
  document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); __log.push(["submit"]); });
</script></body>`;
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/csp")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self'" });
    res.end(`<!doctype html><meta charset="utf-8"><title>CSP</title><h1>csp</h1>`);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(FORM_PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const UPLOAD_FILE = path.join(WORK_DIR, "upload-sample.txt");
fs.writeFileSync(UPLOAD_FILE, "hello firefox\n");

const ev = (tabId, expr) => rpc.ev(tabId, expr);
// 需要原样的 RPC 结果（不经 Rpc 的解包、自动 attach 与异常转换）时直接走 HTTP。
async function raw(method, params, timeoutMs = 20000) {
  const res = await fetch(`http://127.0.0.1:${HOST_PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${rpc.token}`, "X-Agent-Id": "ff-e2e" },
    body: JSON.stringify({ method, params, timeoutMs }),
  });
  const json = await res.json();
  if (!json.ok) throw Object.assign(new Error(json.error.message), { code: json.error.code });
  return json.result;
}
const log = (tabId) => ev(tabId, "window.__log");

try {
  console.log("\n== 1. 状态：host 与扩展都报告 firefox ==");
  {
    const s = await status();
    t("/status browser=firefox", s.browser === "firefox", s.browser);
    const b = await rpc.call("bridge.status", {}, 10000);
    t("bridge.status cdp=bidi", b.cdp === "bidi" && b.browser === "firefox", `${b.browser}/${b.cdp}`);
  }

  const { tabId } = await rpc.call("tabs.resolve", { url: `${ORIGIN}/form?t=${process.pid}`, waitLoad: true, match: "exact" }, 30000);
  console.log(`\n测试页 tab ${tabId}`);

  console.log("\n== 2. 求值 ==");
  {
    const a = await attempt(() => rpc.call("page.evaluate", { tabId, expression: "6*7" }, 15000));
    t("page.evaluate（scripting MAIN world）", a.ok && a.value === 42, JSON.stringify(a.ok ? a.value : a));
    const b = await attempt(() => ev(tabId, "({a:1,b:[1,'x',null],c:undefined,d:{e:true}})"));
    t("Runtime.evaluate returnByValue 结构与 CDP 一致", b.ok && JSON.stringify(b.value) === '{"a":1,"b":[1,"x",null],"d":{"e":true}}', JSON.stringify(b.value || b));
    const c = await attempt(() => ev(tabId, "(async () => 5)()"));
    t("awaitPromise=false 时返回 Promise 对象（与 CDP 一致）", c.ok && JSON.stringify(c.value) === "{}", JSON.stringify(c.value || c));
    const d = await attempt(() => rpc.ev(tabId, "Promise.resolve(9)", { awaitPromise: true }));
    t("awaitPromise=true 取到 Promise 结果", d.ok && d.value === 9, JSON.stringify(d.value || d));
    // CDP 异常时 result 是错误对象（subtype=error，description 含消息与堆栈），两种浏览器一致。
    // 直接走 session.send 检查翻译层形状；rpc.ev 会把它转成 EVAL_ERROR 抛出
    await rpc.attach(tabId);
    const e = await attempt(async () => (await raw("session.send", { tabId, method: "Runtime.evaluate", params: { expression: "throw new Error('boom-ff')", returnByValue: true } })).result);
    t("页面异常返回 error 对象且 description 带原始消息", e.ok && e.value.result.subtype === "error" && /boom-ff/.test(e.value.result.description) && !!e.value.exceptionDetails, JSON.stringify(e.ok ? e.value : e).slice(0, 200));
    await rpc.detach(tabId);
    const e2 = await attempt(() => ev(tabId, "throw new Error('boom-ff')"));
    t("rpc.ev 对页面异常抛 EVAL_ERROR", !e2.ok && e2.code === "EVAL_ERROR" && /boom-ff/.test(e2.message), JSON.stringify(e2));
    const f = await attempt(() => rpc.call("page.evalCdp", { tabId, expression: "location.pathname" }, 15000));
    t("page.evalCdp", f.ok && f.value === "/form", JSON.stringify(f.ok ? f.value : f));
  }

  console.log("\n== 3. 严格 CSP 页：page.evaluate 兜底到 BiDi ==");
  {
    const csp = await rpc.call("tabs.resolve", { url: `${ORIGIN}/csp?t=${process.pid}`, waitLoad: true, match: "exact" }, 30000);
    const r = await attempt(() => rpc.call("page.evaluate", { tabId: csp.tabId, expression: "6*7" }, 20000));
    t("CSP 页 page.evaluate 经 CDP 兜底成功", r.ok && r.value === 42, JSON.stringify(r.ok ? r.value : r));
    await rpc.call("tabs.close", { tabId: csp.tabId }, 10000);
  }

  console.log("\n== 4. 真实点击 / 输入 / 上传 ==");
  {
    const c = await attempt(() => rpc.call("page.clickReal", { tabId, selector: "#btn" }, 20000));
    t("page.clickReal 成功", c.ok, `[${c.code}] ${c.message || ""}`);
    const l1 = await log(tabId);
    t("页面收到 isTrusted=true 的 click", l1.some(([k, trusted]) => k === "click" && trusted === true), JSON.stringify(l1));

    const text = "你好 Firefox 🎉";
    const a = await attempt(() => raw("page.typeReal", { tabId, selector: "#inp", text }));
    t("page.typeReal 输入 CJK + emoji 并回读校验", a.ok && a.value.verified === true && a.value.value === text, JSON.stringify(a.value || a));
    const ta = await attempt(() => rpc.call("page.typeReal", { tabId, selector: "#ta", text: "第一行\n第二行" }, 20000));
    const taVal = await ev(tabId, "document.getElementById('ta').value");
    t("textarea 中 \\n 是换行而不是回车提交", ta.ok && taVal === "第一行\n第二行", JSON.stringify(taVal));
    const ce = await attempt(() => raw("page.typeReal", { tabId, selector: "#ce", text: "可编辑区" }));
    t("contenteditable 输入", ce.ok && ce.value.verified === true, JSON.stringify(ce.value || ce));

    await ev(tabId, "window.__log = []");
    const en = await attempt(() => rpc.call("page.typeReal", { tabId, selector: "#inp", text: "x", pressEnter: true }, 20000));
    const l2 = await log(tabId);
    t("pressEnter 产生 isTrusted 的 Enter 且只按一次", en.ok && l2.filter(([k, key, tr]) => k === "keydown" && key === "Enter" && tr).length === 1, JSON.stringify(l2));
    t("Enter 触发表单提交", l2.some(([k]) => k === "submit"), JSON.stringify(l2));

    const u = await attempt(() => rpc.call("page.uploadFile", { tabId, selector: "#file", files: [UPLOAD_FILE] }, 30000));
    const name = await ev(tabId, "document.getElementById('file').files[0] && document.getElementById('file').files[0].name");
    t("page.uploadFile 设置文件", u.ok && name === "upload-sample.txt", `${JSON.stringify(u.value || u)} name=${name}`);
  }

  console.log("\n== 5. session.send 直连 CDP 方法 ==");
  {
    await ev(tabId, "document.getElementById('inp').value=''; document.getElementById('inp').focus()");
    for (const type of ["keyDown", "keyUp"]) {
      await rpc.call("session.send", { tabId, method: "Input.dispatchKeyEvent", params: { type, key: "a", text: "a" } }, 10000);
    }
    t("Input.dispatchKeyEvent keyDown/keyUp 输入一个字符", (await ev(tabId, "document.getElementById('inp').value")) === "a");
    await rpc.call("session.send", { tabId, method: "Input.insertText", params: { text: "bc" } }, 10000);
    t("Input.insertText 追加到焦点元素", (await ev(tabId, "document.getElementById('inp').value")) === "abc");

    const doc = await rpc.call("session.send", { tabId, method: "DOM.getDocument", params: { depth: -1 } }, 10000);
    const all = await rpc.call("session.send", { tabId, method: "DOM.querySelectorAll", params: { nodeId: doc.root.nodeId, selector: "input" } }, 10000);
    t("DOM.querySelectorAll 返回 nodeIds", all.nodeIds.length === 2 && all.nodeIds.every((n) => n > 0), JSON.stringify(all));
    const none = await rpc.call("session.send", { tabId, method: "DOM.querySelector", params: { nodeId: doc.root.nodeId, selector: "#nope" } }, 10000);
    t("DOM.querySelector 未命中返回 nodeId 0（与 CDP 一致）", none.nodeId === 0, JSON.stringify(none));

    const w0 = await ev(tabId, "window.innerWidth");
    await rpc.call("session.send", { tabId, method: "Emulation.setDeviceMetricsOverride", params: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } }, 10000);
    t("Emulation.setDeviceMetricsOverride 改变视口", (await ev(tabId, "window.innerWidth")) === 390);
    await rpc.detach(tabId);
    t("detach 后视口覆盖失效（与 CDP 一致）", (await ev(tabId, "window.innerWidth")) === w0);

    const un = await attempt(() => rpc.call("session.send", { tabId, method: "Network.enable", params: {} }, 10000));
    t("不支持的 CDP 方法报 CDP_UNSUPPORTED", !un.ok && un.code === "CDP_UNSUPPORTED", `[${un.code}] ${un.message}`);
  }

  console.log("\n== 6. 后台标签页截图 ==");
  {
    const other = await rpc.call("tabs.create", { url: "about:blank", active: true }, 15000);
    const hidden = await ev(tabId, "document.hidden");
    const s = await attempt(() => rpc.call("page.screenshot", { tabId, format: "png" }, 30000));
    t("测试页已在后台", hidden === true);
    t("后台截图静默成功（captureMode=cdp）", s.ok && s.value.captureMode === "cdp" && s.value.image.startsWith("data:image/png;base64,") && s.value.image.length > 2000, s.ok ? s.value.captureMode : `[${s.code}] ${s.message}`);
    const j = await attempt(() => rpc.call("page.screenshot", { tabId, format: "jpeg", quality: 60, captureBeyondViewport: true }, 30000));
    t("整页 jpeg 截图", j.ok && j.value.image.startsWith("data:image/jpeg;base64,"), j.ok ? "" : `[${j.code}] ${j.message}`);
    const c = await attempt(() => rpc.call("page.clickReal", { tabId, selector: "#btn" }, 20000));
    t("后台标签页上的真实点击", c.ok, `[${c.code}] ${c.message || ""}`);
    await rpc.call("tabs.close", { tabId: other.tab ? other.tab.id : other.tabId }, 10000);
  }

  console.log("\n== 7. 停止闸门对 session.send 的 Input.* 生效 ==");
  {
    await rpc.call("agent.stop", { tabId, reason: "ff-e2e" }, 10000);
    const s = await attempt(() => rpc.call("session.send", { tabId, method: "Input.insertText", params: { text: "zz" } }, 10000));
    t("停止后 Input.insertText 被拒（AGENT_STOPPED）", !s.ok && s.code === "AGENT_STOPPED", `[${s.code}]`);
    const r = await attempt(() => rpc.call("session.send", { tabId, method: "Runtime.evaluate", params: { expression: "1", returnByValue: true } }, 10000));
    t("停止后观察类 Runtime.evaluate 仍放行", r.ok, `[${r.code}]`);
    await rpc.call("agent.resume", { tabId }, 10000);
  }

  console.log("\n== 8. host 被 SIGTERM 后由 Firefox 重新拉起，BiDi 会话可再建立 ==");
  {
    const before = await status();
    process.kill(before.pid, "SIGTERM");
    const after = await waitFor(async () => { const s = await status(); return s && s.pid !== before.pid && s.extConnected ? s : null; }, 30000, "新 host 就绪");
    t("新 host 已由扩展重连拉起", after.pid !== before.pid);
    rpc._attached.clear();
    const r = await attempt(() => ev(tabId, "1+2"));
    t("新 host 上 BiDi 会话正常（旧 host 退出前已 session.end）", r.ok && r.value === 3, `[${r.code}] ${r.message || ""}`);
  }

  console.log("\n== 9. 关闭标签页后会话随之失效 ==");
  {
    await rpc.call("tabs.close", { tabId }, 10000);
    await sleep(500);
    // 走裸 HTTP：Rpc 会对未登记的 tab 先自动 attach（那样报的是 TAB_GONE），这里要测的是扩展侧会话随 tab 关闭清理
    const r = await attempt(() => raw("session.send", { tabId, method: "Runtime.evaluate", params: { expression: "1" } }, 10000));
    t("已关闭 tab 的 session.send 报 SESSION_NOT_ATTACHED", !r.ok && r.code === "SESSION_NOT_ATTACHED", `[${r.code}] ${r.message}`);
    const a = await attempt(() => rpc.call("session.attach", { tabId }, 10000));
    t("已关闭 tab 的 session.attach 报 TAB_GONE", !a.ok && a.code === "TAB_GONE", `[${a.code}] ${a.message}`);
  }
} finally {
  await rpc.cleanup().catch(() => {});
  server.close();
  killTestFirefox();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
