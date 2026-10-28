// 以 Remote Agent（WebDriver BiDi）模式启动 Firefox，并把扩展装成临时扩展。
//
// 为什么需要它：Firefox 扩展没有 chrome.debugger，真实点击/输入/上传/截图要靠 BiDi，
// 而 BiDi 只在 Firefox 带 --remote-debugging-port 启动时才开。正式版 Firefox 只允许永久安装
// 签过名的扩展，临时扩展每次重启都要重新装——这一步也由本脚本经 BiDi webExtension.install 完成。
//
// 用法：
//   node relay/firefox-launch.js                    # 用默认 profile 启动（Firefox 须已退出）
//   node relay/firefox-launch.js --profile <dir>    # 用独立 profile 启动（可与日常 Firefox 并存）
//   node relay/firefox-launch.js --bidi-port 9222 --no-install
//   node relay/firefox-launch.js --no-install --install-xpi dist/firefox-signed/<文件名>.xpi
//     永久安装 AMO 签过名的 .xpi（BiDi 私有参数 moz:permanent，不弹安装确认框；未签名的包会被正式版拒绝）
// 环境变量：FIREFOX_BIN（Firefox 可执行文件）、AGENT_BRIDGE_PORT（host 端口，默认 8779）
"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { BidiClient } = require("./bidi-client");
const { build } = require("./build-firefox");

const DEFAULT_FIREFOX_BIN = "/Applications/Firefox.app/Contents/MacOS/firefox";
const DEFAULT_BIDI_PORT = 9222;
const STARTUP_TIMEOUT_MS = 30000;

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}
const BIDI_PORT = Number(argValue("--bidi-port") || DEFAULT_BIDI_PORT);
const PROFILE = argValue("--profile") ? path.resolve(argValue("--profile")) : null;
const INSTALL = !args.includes("--no-install");
const INSTALL_XPI = argValue("--install-xpi") ? path.resolve(argValue("--install-xpi")) : null;
const FIREFOX_BIN = process.env.FIREFOX_BIN || DEFAULT_FIREFOX_BIN;

function fail(code, message) {
  console.error(`[firefox-launch] FATAL code=${code}\n  ${message}`);
  process.exit(2);
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

function firefoxRunning() {
  let out = "";
  try { out = execFileSync("pgrep", ["-fl", FIREFOX_BIN], { encoding: "utf8" }); } catch (e) { return false; }
  const lines = out.split("\n").filter((l) => l.includes(FIREFOX_BIN) && !l.includes("plugin-container") && !l.includes("-contentproc"));
  // 指定 profile 时只关心用同一 profile 的实例；不指定时任何主进程都会拦下 Firefox 的二次启动
  return PROFILE ? lines.some((l) => l.includes(PROFILE)) : lines.length > 0;
}

async function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  if (!fs.existsSync(FIREFOX_BIN)) fail("FIREFOX_NOT_FOUND", `找不到 ${FIREFOX_BIN}（可用环境变量 FIREFOX_BIN 指定）`);

  if (await portOpen(BIDI_PORT)) {
    console.log(`Firefox Remote Agent 已在 127.0.0.1:${BIDI_PORT} 运行，跳过启动`);
  } else {
    if (firefoxRunning()) {
      fail("FIREFOX_ALREADY_RUNNING",
        "Firefox 已在运行但没有开启 Remote Agent。先退出 Firefox（Cmd+Q）再运行本命令；" +
        "或加 --profile <dir> 用独立 profile 另起一个实例。");
    }
    const ffArgs = [];
    if (PROFILE) {
      fs.mkdirSync(PROFILE, { recursive: true });
      ffArgs.push("-no-remote", "-profile", PROFILE);
    }
    ffArgs.push("--remote-debugging-port", String(BIDI_PORT));
    // native host 继承 Firefox 的环境变量：host 靠它知道 BiDi 端口
    const env = { ...process.env, AGENT_BRIDGE_BIDI_PORT: String(BIDI_PORT) };
    const child = spawn(FIREFOX_BIN, ffArgs, { detached: true, stdio: "ignore", env });
    child.unref();
    if (!(await waitPort(BIDI_PORT, STARTUP_TIMEOUT_MS))) {
      fail("BIDI_UNAVAILABLE", `Firefox 启动后 ${STARTUP_TIMEOUT_MS / 1000}s 内 Remote Agent 未就绪（127.0.0.1:${BIDI_PORT}）`);
    }
    console.log(`Firefox 已启动（pid ${child.pid}），Remote Agent: 127.0.0.1:${BIDI_PORT}${PROFILE ? `，profile: ${PROFILE}` : ""}`);
  }

  if (INSTALL_XPI) {
    if (!fs.existsSync(INSTALL_XPI)) fail("BAD_PARAMS", `找不到 ${INSTALL_XPI}`);
    const client = new BidiClient({ port: BIDI_PORT });
    try {
      await client.connect();
    } catch (e) {
      fail(e.code, `${e.message}\n  host 正持有 BiDi 会话时无法安装：先退出 Firefox，用 --no-install 重新启动后立即执行本命令。`);
    }
    try {
      const res = await client.send("webExtension.install", { extensionData: { type: "archivePath", path: INSTALL_XPI }, "moz:permanent": true });
      console.log(`扩展已永久安装: ${res.extension}（${INSTALL_XPI}）`);
    } finally {
      await client.end();
    }
  }

  if (INSTALL && !INSTALL_XPI) {
    const r = build();
    const client = new BidiClient({ port: BIDI_PORT });
    try {
      await client.connect();
    } catch (e) {
      fail(e.code, `${e.message}\n  若扩展已连上 host，host 正持有 BiDi 会话：此时扩展已装好，无需再装；要重新加载扩展请用 RPC extension.reload。`);
    }
    try {
      const res = await client.send("webExtension.install", { extensionData: { type: "path", path: r.outDir } });
      console.log(`扩展已作为临时扩展安装: ${res.extension} v${r.version}（${r.outDir}）`);
    } finally {
      await client.end();
    }
  }
  const hostPort = process.env.AGENT_BRIDGE_PORT || 8779;
  console.log(`就绪后 Agent 用 BRIDGE_BROWSER=firefox（或 BRIDGE_PORT=${hostPort}）连接；状态: curl http://127.0.0.1:${hostPort}/status`);
}

main().catch((e) => fail(e.code || "LAUNCH_FAILED", e.message));
