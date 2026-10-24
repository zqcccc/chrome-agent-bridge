#!/usr/bin/env node
// Cloudflare 挑战页等待器 —— 识别挑战 → 停止驱动 → 保证前台渲染 → 等待自动通过 → 超时交给用户
//
// 背景（2026-10，依据 Cloudflare 官方文档与实测）：
//   - 真实 Chrome + 真实登录态下，多数 Managed Challenge 会自动通过。官方口径：
//     "Most visitors will pass Challenges automatically without interaction."
//   - 后台标签页的 requestAnimationFrame 被完全暂停，timer 被压到每分钟一次，
//     挑战脚本因此可能停在半途。page.ensureActive 只切标签页、不聚焦窗口，能恢复渲染。
//   - 挑战页可能是 HTTP 200，也可能是 403。判定顺序是「先看是不是挑战页，再看状态码」。
//   - 通过后 cf_clearance 默认 30 分钟；2026 年起的 Precursor 会话级验证可以在 cookie
//     未过期时再次挑战，所以每次导航都要重新检测。
//
// 用法:
//   node cf-wait.mjs <tabId> [--auto-timeout 30] [--human-timeout 120] [--human] [--shot <png 路径>]
//     --auto-timeout   自动等待秒数（默认 30）
//     --human-timeout  人工等待秒数（默认 120）
//     --human          跳过自动等待，直接进入人工流程
//     --shot           人工流程截图的保存路径（默认存到 ~/.chrome-agent-bridge/captcha-shots/）
//
// 退出码:
//   0  本来就没有挑战，或挑战已通过
//   1  桥/页面异常（RPC 失败、tab 不可用、用户叫停等）
//   2  页面仍需用户处理：未指定 --human 时自动等待超时，或指定 --human 后人工等待超时
//
// 输出:
//   stdout 单行 JSON：{tabId, challenge, cType, solved, attempts, waitedMs, title, url}
//   challenge 表示最近一次检测是否仍在挑战页；solved 表示是否已通过。详细提示写 stderr。
//   复核恢复时看 solved 之外，还要读一次业务目标元素，确认页面真的到了目标态。
//
// 策略:
//   1. 初始检测：没有挑战直接退出 0。
//   2. 有挑战：先 page.ensureActive（后台标签页会拖慢挑战脚本），每 1.5 秒轮询一次。
//   3. 带 --human：跳过自动阶段，tabs.activate 把页面交给用户、截图留现场，轮询到 --human-timeout。
//      未带 --human：自动等待超时即截图取证后以退出码 2 结束，不转人工、不挂起。
//   4. 全程只读页面状态，不刷新、不点击、不导航。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Rpc, BridgeRpcError, sleep } from "../../scripts/lib/bridge.mjs";

const USAGE =
  "usage: node cf-wait.mjs <tabId> [--auto-timeout 30] [--human-timeout 120] [--human] [--shot <png 路径>]";

const POLL_INTERVAL_MS = 1500;
const MAX_CONSECUTIVE_UNKNOWN = 5;

const argv = process.argv.slice(2);
let tabId = null;
let autoTimeoutSec = 30;
let humanTimeoutSec = 120;
let forceHuman = false;
let shotPath = null;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--auto-timeout") autoTimeoutSec = Number(argv[++i]);
  else if (arg === "--human-timeout") humanTimeoutSec = Number(argv[++i]);
  else if (arg === "--human") forceHuman = true;
  else if (arg === "--shot") shotPath = argv[++i];
  else if (arg === "--help" || arg === "-h") {
    console.error(USAGE);
    process.exit(0);
  } else if (!arg.startsWith("--") && tabId === null) tabId = Number(arg);
  else fail(`未知参数: ${arg}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!Number.isInteger(tabId) || tabId <= 0) fail(USAGE);
if (!Number.isFinite(autoTimeoutSec) || autoTimeoutSec < 0) fail("--auto-timeout 需要大于等于 0 的秒数");
if (!Number.isFinite(humanTimeoutSec) || humanTimeoutSec < 0) fail("--human-timeout 需要大于等于 0 的秒数");
if (shotPath !== null && !shotPath) fail("--shot 需要一个文件路径");

let rpc;
try {
  rpc = new Rpc({ agentId: `cf-wait-${process.pid}`, agentName: "cf-wait" });
} catch (e) {
  fail(`无法初始化桥客户端：${e.message}`);
}

// 页面内同步求值，返回一个对象。page.evaluate 默认在 MAIN world 执行，可以直接读 window._cf_chl_opt。
const DETECT_EXPR = `(() => ({
  title: document.title,
  url: location.href,
  hasCfOpt: !!window._cf_chl_opt,
  cType: window._cf_chl_opt?.cType ?? null,
  cTplC: window._cf_chl_opt?.cTplC ?? null,
  hasChlScript: !!document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]'),
  hasTurnstile: !!document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]'),
  hasLegacy: !!document.querySelector('.cf-browser-verification')
}))()`;

// 挑战判定：任一 marker 命中即视为挑战。标题文案可能被自定义模板改写，所以文案只作补充判据。
function isChallenge(state) {
  if (!state || typeof state !== "object") return false;
  // hasChlScript 不参与判定：JS Detections 的注入片段是同一路径前缀（Bot Fight Mode 默认开启），
  // 正常页面也会带该脚本，误判会白等整个自动轮询窗口。它只作为辅助信息透传。
  if (state.hasCfOpt || state.hasTurnstile || state.hasLegacy) return true;
  if (/^Just a moment|^Checking your browser/.test(String(state.title || ""))) return true;
  const url = String(state.url || "");
  return url.includes("/cdn-cgi/challenge-platform/") || url.includes("__cf_chl_rt_tk");
}

// 页面导航瞬间可能读不到上下文，这类错误按「本轮未知」处理，连续多次才判失败。
const TRANSIENT_CODES = new Set(["PAGE_CONTEXT_TIMEOUT", "NAV_TIMEOUT", "TIMEOUT", "TAB_BUSY"]);

const stats = { attempts: 0, startedAt: Date.now(), last: null };

async function detectOnce() {
  const out = await rpc.call(
    "page.evaluate",
    { tabId, expression: DETECT_EXPR, awaitPromise: false },
    20000
  );
  if (!out || typeof out !== "object") {
    throw new BridgeRpcError("BAD_DETECT", `页面返回了非对象结果: ${JSON.stringify(out)}`, "page.evaluate");
  }
  return out;
}

async function tryDetect() {
  try {
    return await detectOnce();
  } catch (e) {
    if (e instanceof BridgeRpcError && e.code === "AGENT_STOPPED") throw e;
    if (e instanceof BridgeRpcError && TRANSIENT_CODES.has(e.code)) return null;
    throw e;
  }
}

function emit({ solved }) {
  const last = stats.last;
  console.log(
    JSON.stringify({
      tabId,
      challenge: last ? isChallenge(last) : null,
      cType: last ? last.cType ?? null : null,
      solved,
      attempts: stats.attempts,
      waitedMs: Date.now() - stats.startedAt,
      title: last ? last.title ?? null : null,
      url: last ? last.url ?? null : null,
    })
  );
}

async function ensureVisible() {
  const r = await rpc.ensureActive(tabId, { restoreAfterMs: 60000 });
  if (r && r.activated) {
    console.error("挑战页在后台标签页，已临时切到前台以恢复渲染（不聚焦窗口）。");
  }
}

function defaultShotPath() {
  return path.join(os.homedir(), ".chrome-agent-bridge", "captcha-shots", `cf-${tabId}-${Date.now()}.png`);
}

async function saveSceneShot() {
  try {
    const shot = await rpc.call("page.screenshot", { tabId, format: "png" }, 30000);
    const dataUrl = shot && shot.image;
    if (!dataUrl || !dataUrl.startsWith("data:image/")) throw new Error("截图返回里没有 dataURL");
    const target = path.resolve(shotPath || defaultShotPath());
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
    console.error(`已保存现场截图：${target}`);
  } catch (e) {
    console.error(`现场截图失败（不影响等待）：${e.message}`);
  }
}

async function handOffToHuman() {
  // 清掉之前「借前台」的记录：tabs.activate 已把窗口带到前台并让该 tab 成为活动页，
  // 留着 borrowedActive 会让空闲计时器到时把用户刚解完验证码的标签页切回原页。
  await rpc.restoreActive(tabId).catch(() => {});
  await rpc.call("tabs.activate", { tabId }, 20000);
  await sleep(400);
  await saveSceneShot();
  console.error("等待用户完成人机验证……");
}

// 超时后补充现场信息：Ray ID 便于用户向站点反馈，也便于判断是不是同一类挑战。
async function reportForensics() {
  try {
    const info = await rpc.call(
      "page.evaluate",
      {
        tabId,
        expression: `(() => ({
          cRay: window._cf_chl_opt?.cRay ?? null,
          textRay: (document.body && document.body.innerText.match(/Ray ID:\\s*([0-9a-f]+)/i) || [])[1] || null
        }))()`,
        awaitPromise: false,
      },
      10000
    );
    const ray = info && (info.cRay || info.textRay);
    console.error(ray ? `Ray ID: ${ray}` : "页面上没有读到 Ray ID。");
  } catch (e) {
    console.error(`读取 Ray ID 失败：${e.message}`);
  }
}

async function waitUntilSolved(deadline) {
  let consecutiveUnknown = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const state = await tryDetect();
    stats.attempts++;
    if (!state) {
      consecutiveUnknown++;
      if (consecutiveUnknown >= MAX_CONSECUTIVE_UNKNOWN) {
        throw new BridgeRpcError(
          "DETECT_FAILED",
          `连续 ${MAX_CONSECUTIVE_UNKNOWN} 次读不到页面状态（页面可能持续导航或上下文失效）`,
          "page.evaluate"
        );
      }
      continue;
    }
    consecutiveUnknown = 0;
    stats.last = state;
    if (!isChallenge(state)) return true;
  }
  return false;
}

async function main() {
  stats.last = await detectOnce();
  stats.attempts = 1;

  if (!isChallenge(stats.last)) {
    emit({ solved: true });
    return 0;
  }

  const first = stats.last;
  console.error(
    `检测到 Cloudflare 挑战（cType=${first.cType ?? "未知"}，title="${first.title}"）。停止驱动，开始等待。`
  );
  await ensureVisible();

  if (forceHuman) {
    console.error("按 --human 进入人工接管。");
  } else {
    const autoDeadline = Date.now() + autoTimeoutSec * 1000;
    if (await waitUntilSolved(autoDeadline)) {
      emit({ solved: true });
      return 0;
    }
    console.error(`自动等待 ${autoTimeoutSec}s 未通过；未指定 --human，不转人工，保留现场后退出。`);
    emit({ solved: false });
    await saveSceneShot();
    await reportForensics();
    return 2;
  }

  await handOffToHuman();

  const humanDeadline = Date.now() + humanTimeoutSec * 1000;
  if (await waitUntilSolved(humanDeadline)) {
    emit({ solved: true });
    return 0;
  }

  emit({ solved: false });
  console.error(`人工等待 ${humanTimeoutSec}s 仍未通过。页面保持原样，请用户处理后重新运行本脚本。`);
  await reportForensics();
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    const message = e instanceof BridgeRpcError ? `${e.code}: ${e.message}` : String((e && e.message) || e);
    console.error(`cf-wait 失败：${message}`);
    emit({ solved: false });
    process.exitCode = 1;
  });
