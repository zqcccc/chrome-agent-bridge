// 由 extension/（Chrome 版，唯一源码）生成 Firefox 版扩展目录 dist/firefox/。
// 源码不分叉：两边共用同一份 background.js / content.js，浏览器差异在运行时按能力判断；
// 这里只改 manifest（Firefox MV3 不支持 service_worker、没有 debugger 权限、需要 gecko id）。
// 用法：node relay/build-firefox.js [--out <dir>]
"use strict";

const fs = require("fs");
const path = require("path");

const GECKO_ID = "agent-browser-bridge@zqcccc";
// world:"MAIN" 需要 Firefox 128；AMO 要求的 data_collection_permissions 需要 140
const GECKO_MIN_VERSION = "140.0";
const CHROME_ONLY_PERMISSIONS = new Set(["debugger"]);

const SRC_DIR = path.join(__dirname, "..", "extension");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT_DIR = path.resolve(outIdx !== -1 ? args[outIdx + 1] : path.join(__dirname, "..", "dist", "firefox"));

function firefoxManifest(src) {
  const mf = { ...src };
  delete mf.minimum_chrome_version;
  mf.background = { scripts: [src.background.service_worker] };
  mf.permissions = src.permissions.filter((p) => !CHROME_ONLY_PERMISSIONS.has(p));
  delete mf.options_page;
  mf.options_ui = { page: src.options_page, open_in_tab: true };
  mf.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: GECKO_MIN_VERSION,
      data_collection_permissions: { required: ["none"] },
    },
  };
  return mf;
}

function build() {
  const src = JSON.parse(fs.readFileSync(path.join(SRC_DIR, "manifest.json"), "utf8"));
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.cpSync(SRC_DIR, OUT_DIR, { recursive: true, filter: (p) => path.basename(p) !== "manifest.json" || path.dirname(p) !== SRC_DIR });
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(firefoxManifest(src), null, 2) + "\n");
  return { outDir: OUT_DIR, version: src.version, geckoId: GECKO_ID };
}

if (require.main === module) {
  const r = build();
  console.log(`Firefox 扩展已生成: ${r.outDir}  (v${r.version}, id=${r.geckoId})`);
}

module.exports = { build, firefoxManifest, GECKO_ID, GECKO_MIN_VERSION };
