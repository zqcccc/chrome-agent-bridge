#!/usr/bin/env node
/**
 * version-guard —— 版本号一致性守卫。
 *
 * 为什么需要它：版本号散落在多处（manifest、README 发布命令、CHANGELOG 表格），
 * 手工维护必然漏改。历史上就出过 host 自己维护 VERSION=0.3.0 从不跟着涨，
 * 导致 agent 从 /status 读到 0.3.0、误判 tabs.resolve 等能力不可用。
 *
 * 本脚本把「版本号只有一个事实来源」这件事变成可执行的检查：
 *   - 事实来源：extension/manifest.json 的 version
 *   - 所有其它位置必须与它一致，否则报错退出
 *
 * 用法：
 *   node relay/version-guard.js           # 检查（CI / 发布前跑）
 *   node relay/version-guard.js --fix     # 自动把可安全替换的位置改成当前版本
 *
 * 退出码：0 = 一致；1 = 发现漂移。
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MANIFEST = path.join(ROOT, "extension", "manifest.json");

function currentVersion() {
  return JSON.parse(fs.readFileSync(MANIFEST, "utf8")).version;
}

/**
 * 需要与 manifest 保持一致的「当前版本」位置。
 * 只收录**表达当前版本**的地方；「某能力从 vX 开始支持」这类历史事实不在其中
 * （它们描述的是过去，永不改变，改动反而会造成错误）。
 */
function checks(version) {
  return [
    {
      file: "README.md",
      desc: "clawhub publish 的 --version",
      // 匹配 --version 0.3.9
      re: /--version\s+(\d+\.\d+\.\d+)/,
      replace: (m) => m.replace(/(--version\s+)\d+\.\d+\.\d+/, `$1${version}`),
    },
    {
      file: "relay/package.json",
      desc: "npm 包的 version 字段",
      // 匹配顶层 "version": "0.2.0"（只改第一个，即包版本）
      re: /"version"\s*:\s*"(\d+\.\d+\.\d+)"/,
      replace: (m) => m.replace(/"version"(\s*:\s*")[^"]+(")/, `"version"$1${version}$2`),
    },
    {
      file: "skills/agent-browser-bridge/CHANGELOG.md",
      desc: "「当前版本」表里的扩展版本",
      // 匹配表格行：| 扩展 | **0.3.9** | ...
      re: /\|\s*扩展\s*\|\s*\*\*(\d+\.\d+\.\d+)\*\*\s*\|/,
      replace: (m) => m.replace(/(\|\s*扩展\s*\|\s*\*\*)\d+\.\d+\.\d+(\*\*\s*\|)/, `$1${version}$2`),
    },
  ];
}

/** 这些位置描述「某能力从哪个版本开始有」，是历史事实，**不应**随版本号变动。 */
const HISTORICAL_PATTERNS = [
  { file: "skills/agent-browser-bridge/CHANGELOG.md", desc: "症状→最低版本对照表", re: /^\|\s*.+\|\s*\d+\.\d+\.\d+\s*\|$/ },
  { file: "skills/agent-browser-bridge/CHANGELOG.md", desc: "版本历史小节标题", re: /^###\s+\d+\.\d+\.\d+/ },
  { file: "skills/agent-browser-bridge/SKILL.md", desc: "能力的最低版本标注", re: /v?\d+\.\d+\.\d+\+/ },
  { file: "skills/agent-browser-bridge/KNOWN_ISSUES.md", desc: "能力的最低版本标注", re: /v?\d+\.\d+\.\d+\+/ },
  { file: "skills/agent-browser-bridge/scripts/lib/bridge.mjs", desc: "能力门槛（gte 判定）", re: /gte\(version,\s*"\d+\.\d+\.\d+"\)/ },
];

function main() {
  const fix = process.argv.includes("--fix");
  const version = currentVersion();
  const problems = [];
  const fixed = [];

  console.log(`事实来源：extension/manifest.json → ${version}\n`);

  for (const c of checks(version)) {
    const p = path.join(ROOT, c.file);
    let text;
    try {
      text = fs.readFileSync(p, "utf8");
    } catch (e) {
      problems.push({ ...c, found: `读不到文件：${e.message}` });
      continue;
    }
    const m = text.match(c.re);
    if (!m) {
      problems.push({ ...c, found: "找不到该位置（可能已被改写，请人工确认）" });
      continue;
    }
    const found = m[1];
    if (found === version) {
      console.log(`  ✓ ${c.file}  ${c.desc} = ${found}`);
    } else {
      console.log(`  ✗ ${c.file}  ${c.desc} = ${found}（应为 ${version}）`);
      if (fix) {
        fs.writeFileSync(p, c.replace(text), "utf8");
        fixed.push(c.file);
        console.log(`      → 已修正为 ${version}`);
      } else {
        problems.push({ ...c, found });
      }
    }
  }

  // 反向检查：manifest 版本是否出现在「历史事实」区被误改
  console.log("\n历史事实区（不应随版本变动，仅提示）：");
  for (const h of HISTORICAL_PATTERNS) {
    const p = path.join(ROOT, h.file);
    let text;
    try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
    const n = text.split("\n").filter((l) => h.re.test(l)).length;
    console.log(`  · ${h.file}  ${h.desc}：${n} 处`);
  }

  if (fix && fixed.length) {
    console.log(`\n✓ 已自动修正 ${fixed.length} 处：${fixed.join(", ")}`);
    console.log("  请 review 后提交。");
    return 0;
  }
  if (problems.length) {
    console.log(`\n✗ 发现 ${problems.length} 处版本漂移。运行 node relay/version-guard.js --fix 可自动修正。`);
    process.exit(1);
  }
  console.log("\n✓ 版本号一致。");
  return 0;
}

if (require.main === module) main();
module.exports = { currentVersion, checks };
