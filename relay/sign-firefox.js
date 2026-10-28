// 用 AMO 自分发（unlisted）通道给 Firefox 版扩展签名，产出可在正式版 Firefox 永久安装的 .xpi。
//
// 凭据：AMO 的 API key / secret（https://addons.mozilla.org/developers/addon/api/key/）。
// 读取顺序：环境变量 WEB_EXT_API_KEY / WEB_EXT_API_SECRET → ~/.chrome-agent-bridge/amo-credentials。
// 凭据文件是 dotenv 格式、权限必须 600；不接受命令行传入（会出现在 `ps` 输出里）。
//
// AMO 不接受重复版本号：签过的版本再签会被拒，发新版前先升 extension/manifest.json 的 version。
//
// 用法：node relay/sign-firefox.js
// 产物：dist/firefox-signed/agent_browser_bridge-<version>.xpi
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");
const { spawnSync } = require("child_process");
const { build } = require("./build-firefox");

// 固定版本：签名工具会把扩展代码上传给 Mozilla，不用浮动的 latest
const WEB_EXT = "web-ext@10.7.0";
const CREDENTIALS_FILE = path.join(os.homedir(), ".chrome-agent-bridge", "amo-credentials");
const ARTIFACTS_DIR = path.join(__dirname, "..", "dist", "firefox-signed");

function fail(code, message) {
  console.error(`[sign-firefox] FATAL code=${code}\n  ${message}`);
  process.exit(2);
}

function loadCredentials() {
  if (process.env.WEB_EXT_API_KEY && process.env.WEB_EXT_API_SECRET) {
    return { WEB_EXT_API_KEY: process.env.WEB_EXT_API_KEY, WEB_EXT_API_SECRET: process.env.WEB_EXT_API_SECRET };
  }
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    fail("AMO_CREDENTIALS_MISSING",
      `没有 AMO 凭据：设置环境变量 WEB_EXT_API_KEY / WEB_EXT_API_SECRET，或写入 ${CREDENTIALS_FILE}（chmod 600）：\n` +
      "  WEB_EXT_API_KEY=user:12345678:123\n  WEB_EXT_API_SECRET=<secret>");
  }
  const mode = fs.statSync(CREDENTIALS_FILE).mode & 0o777;
  if (mode & 0o077) fail("AMO_CREDENTIALS_INSECURE", `${CREDENTIALS_FILE} 权限为 ${mode.toString(8)}，必须是 600：chmod 600 ${CREDENTIALS_FILE}`);
  const env = util.parseEnv(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
  if (!env.WEB_EXT_API_KEY || !env.WEB_EXT_API_SECRET) {
    fail("AMO_CREDENTIALS_MISSING", `${CREDENTIALS_FILE} 里缺少 WEB_EXT_API_KEY 或 WEB_EXT_API_SECRET`);
  }
  return { WEB_EXT_API_KEY: env.WEB_EXT_API_KEY, WEB_EXT_API_SECRET: env.WEB_EXT_API_SECRET };
}

function main() {
  const creds = loadCredentials();
  const r = build();
  console.log(`签名 ${r.geckoId} v${r.version}（${r.outDir}）`);
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const res = spawnSync("npx", ["--yes", WEB_EXT, "sign", "--channel", "unlisted", "--source-dir", r.outDir, "--artifacts-dir", ARTIFACTS_DIR], {
    stdio: "inherit",
    env: { ...process.env, ...creds },
  });
  if (res.status !== 0) fail("AMO_SIGN_FAILED", `web-ext sign 退出码 ${res.status}（重复版本号会被拒：先升 extension/manifest.json 的 version）`);
  const xpis = fs.readdirSync(ARTIFACTS_DIR).filter((f) => f.endsWith(".xpi") && f.includes(r.version));
  if (!xpis.length) fail("AMO_SIGN_FAILED", `签名命令成功但 ${ARTIFACTS_DIR} 里没有 v${r.version} 的 .xpi`);
  console.log(`\n已签名: ${path.join(ARTIFACTS_DIR, xpis[0])}`);
  console.log(`安装: open -a Firefox "${path.join(ARTIFACTS_DIR, xpis[0])}"，在 Firefox 弹窗里点「添加」`);
}

main();
