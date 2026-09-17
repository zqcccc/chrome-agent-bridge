#!/usr/bin/env node
/**
 * check-skill-consumers —— 桥外部的 skill 脚本「契约守卫」。
 *
 * 为什么需要它：桥（relay/ + extension/）的语义变更会影响**本仓库之外的** skill 脚本。
 * 这些脚本不在 `relay/` 里，`npm test` 的其它测试看不见它们，而它们会真的点按钮、发消息。
 * 历史上就出过这类事故（v0.3.11）：
 *   · 桥新增 `AGENT_STOPPED`（用户点「停止 Agent」）→ BOSS 脚本把桥错误静默吞成 `{}`，
 *     把「用户叫停」误报成「元素不存在 / 未送达」，且重试循环继续点击；
 *   · 脚本拿到 `/tabs/claim` 租约后从不释放 → 该 tab 被锁 120 秒，下个 Agent 拿到 TAB_LEASED。
 *
 * 本脚本把「外部消费者必须遵守的桥契约」变成可执行检查，而不是靠人记得同步文档。
 *
 * 检查两类东西：
 *   A. 外部消费者不变量（扫描仓库外的 skill 树）：
 *      1. 调 `/rpc` 的脚本不得静默吞掉 `ok:false`（旧 bug 写法 `ok === false ? null`）
 *      2. 会做**写操作**的脚本必须识别 `AGENT_STOPPED`
 *      3. claim 了 Tab 租约的脚本必须 release（否则锁 120 秒）
 *      4. 顶层 await 的脚本必须同时接管 unhandledRejection + uncaughtException
 *         （实测：顶层 await 的 reject 走 uncaughtException，只注册前者会漏）
 *   B. 双份副本一致性（同一脚本在本仓库与外部 skill 各有一份）：
 *      桥交互逻辑的关键符号必须在两份里都存在（防止只改一边）。
 *
 * 用法：
 *   node relay/check-skill-consumers.js
 *   node relay/check-skill-consumers.js --verbose
 *
 * 退出码：0 = 全部满足；1 = 发现违规（会指出文件与缺什么）。
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.homedir();
const REPO = path.join(__dirname, "..");

// 需要扫描的外部 skill 根目录（不存在就跳过，便于换机器/换人）。
const EXTERNAL_ROOTS = [
  path.join(HOME, ".agents", "skills"),
  path.join(HOME, ".workbuddy", "skills"),
  path.join(HOME, ".claude", "skills"),
  path.join(HOME, ".pi", "agent", "skills"),
];

// 判定「这个文件在用桥」的信号
const BRIDGE_SIGNALS = [/127\.0\.0\.1:8778/, /agent-browser-bridge/, /lib\/bridge\.mjs/];

// 写操作信号（会真的改变页面/浏览器状态）
const WRITE_SIGNALS = [
  /page\.click/, /page\.type/, /page\.press/, /page\.navigate/, /page\.scroll/,
  /page\.select/, /page\.hover/, /page\.reload/, /tabs\.create/, /tabs\.close/,
  /Input\.dispatch/, /\.click\(\)/, /btn-send/,
];

/**
 * 一条不变量：name + 适用条件 + 断言。
 * appliesTo(src) 为真时才检查 check(src)。
 */
const INVARIANTS = [
  {
    name: "不静默吞掉桥错误",
    // 旧 bug 写法：把 ok:false 变成 null/{}，真实错误码被掩盖
    appliesTo: (src) => /\/rpc/.test(src),
    check: (src) => !/resp\?\.ok === false \? null|\.ok === false \? null : /.test(src),
    detail: "发现 `ok === false ? null` 这类写法：桥错误会被静默吞成空值，"
      + "真实原因（用户叫停 / 租约被占 / 超时）被误报成「元素不存在 / 未送达」。"
      + "改成显式抛出（参考 boss-send-chat.mjs 的 assertOk）。",
  },
  {
    name: "写操作脚本识别 AGENT_STOPPED",
    appliesTo: (src) => /\/rpc/.test(src) && WRITE_SIGNALS.some((re) => re.test(src)),
    check: (src) => /AGENT_STOPPED/.test(src),
    detail: "该脚本会做写操作，但完全没提 AGENT_STOPPED。用户点「停止 Agent」后它会"
      + "把停止当成普通失败（甚至重试继续点）。必须识别该错误码并立即终止，不得重试。",
  },
  {
    name: "claim 租约必须 release",
    appliesTo: (src) => /tabs\/claim/.test(src),
    check: (src) => /tabs\/release/.test(src),
    detail: "脚本 claim 了 Tab 租约但从不 release：异常退出会把该 tab 锁 120 秒，"
      + "下一个 Agent 拿到 TAB_LEASED 却不知道是谁占的。所有退出路径都要释放。",
  },
  {
    name: "顶层 await 的两个进程级 hook",
    // 顶层 await 的脚本：reject 走 uncaughtException（不是 unhandledRejection）
    appliesTo: (src) => /^await /m.test(src),
    check: (src) => /process\.on\("unhandledRejection"/.test(src) && /process\.on\("uncaughtException"/.test(src),
    detail: "脚本用了顶层 await，但没同时注册 unhandledRejection 与 uncaughtException。"
      + "实测：顶层 await 的 reject 走 **uncaughtException**，只注册前者会漏 —— "
      + "表现为用户叫停时打出 Node 堆栈、退出码不是约定的 3。",
  },
];

// ---------- B. 双份副本：桥交互逻辑的关键符号必须在两份里都存在 ----------
// key: 仓库内相对路径；values: 外部副本的绝对路径候选
//
// ⚠ 这里断言的是**行为契约**，不是实现细节。
// 例如「识别用户叫停」用 `code === "AGENT_STOPPED"` 判定，而**不是**某个专用错误类名：
// send-chat 用普通 Error 带 .code，batch-apply 用 AgentStoppedError，两者都对。
// （第一版写成必须含 `AgentStoppedError`，结果误报了自己 —— 检查器要断言行为。）
const MIRRORED_SCRIPTS = [
  {
    repo: "skills/agent-browser-bridge/scripts/boss-send-chat.mjs",
    external: [path.join(HOME, ".agents", "skills", "boss-zhipin-apply", "scripts", "send-chat.mjs")],
    mustHave: [
      /function assertOk\(/,
      /code === "AGENT_STOPPED"/,
      /async function checkStop\(/,
      /async function releaseLease\(/,
      /tabs\/release/,
      /process\.on\("uncaughtException"/,
      /agent\.stopStatus/,
    ],
  },
  {
    repo: "skills/agent-browser-bridge/scripts/boss-batch-apply.mjs",
    external: [path.join(HOME, ".agents", "skills", "boss-zhipin-apply", "scripts", "batch-apply.mjs")],
    mustHave: [
      /function assertOk\(/,
      /code === "AGENT_STOPPED"/,
      /async function checkStop\(/,
      /async function releaseLease\(/,
      /tabs\/release/,
      /process\.on\("uncaughtException"/,
      /agent\.stopStatus/,
    ],
  },
];

// ---------- 扫描 ----------
const VERBOSE = process.argv.includes("--verbose");
const problems = [];
const checked = [];

function walk(dir, out = [], depth = 0) {
  if (depth > 5) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "state") continue;
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;         // 链接会指回仓库，仓库内由别的测试覆盖
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (e.isFile() && /\.(mjs|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

function isExternal(realPath) {
  const repoReal = fs.realpathSync(REPO);
  return !realPath.startsWith(repoReal + path.sep);
}

// ---- A. 外部消费者不变量 ----
const externalFiles = [];
for (const root of EXTERNAL_ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const f of walk(root)) {
    let real;
    try { real = fs.realpathSync(f); } catch (e) { continue; }
    if (!isExternal(real)) continue;                       // 仓库内的文件不在这里管
    let src;
    try { src = fs.readFileSync(real, "utf8"); } catch (e) { continue; }
    if (!BRIDGE_SIGNALS.some((re) => re.test(src))) continue;
    externalFiles.push(real);
    for (const inv of INVARIANTS) {
      if (!inv.appliesTo(src)) continue;
      checked.push(`${path.relative(HOME, real)} :: ${inv.name}`);
      if (!inv.check(src)) {
        problems.push({ file: path.relative(HOME, real), invariant: inv.name, detail: inv.detail });
      }
    }
  }
}

// ---- B. 双份副本一致性 ----
for (const m of MIRRORED_SCRIPTS) {
  const repoPath = path.join(REPO, m.repo);
  if (!fs.existsSync(repoPath)) continue;
  const repoHas = m.mustHave.every((re) => re.test(fs.readFileSync(repoPath, "utf8")));
  if (!repoHas) {
    problems.push({
      file: m.repo, invariant: "仓库版自身缺少桥契约符号",
      detail: "仓库版脚本缺少 assertOk / checkStop / releaseLease / 进程 hook 等之一，"
        + "外部副本无从同步。先修仓库版。",
    });
    continue;
  }
  for (const ext of m.external) {
    if (!fs.existsSync(ext)) continue;                     // 没装这个 skill 就跳过
    const src = fs.readFileSync(ext, "utf8");
    const missing = m.mustHave.filter((re) => !re.test(src));
    checked.push(`${path.relative(HOME, ext)} :: 与仓库版桥逻辑一致`);
    if (missing.length) {
      problems.push({
        file: path.relative(HOME, ext),
        invariant: "双份副本桥逻辑不同步",
        detail: `与仓库版 ${m.repo} 相比缺少 ${missing.length} 个桥契约符号。`
          + "两份是独立文件（外部那份含个人 PII，不能合并），"
          + "所以**改桥交互逻辑时必须同步改两份**；否则会出现「一边被停止拦住、另一边还在点」。",
      });
    }
  }
}

// ---------- 输出 ----------
console.log("== 桥外部消费者契约检查 ==");
console.log(`扫描根目录：${EXTERNAL_ROOTS.filter((r) => fs.existsSync(r)).map((r) => r.replace(HOME, "~")).join("  ")}`);
console.log(`发现外部消费者脚本：${externalFiles.length} 个`);
for (const f of externalFiles) console.log(`  · ${path.relative(HOME, f)}`);
if (VERBOSE) {
  console.log(`\n已检查的不变量（${checked.length} 项）：`);
  for (const c of checked) console.log(`  ✓ ${c}`);
}

if (problems.length === 0) {
  console.log(`\n✓ 全部满足（${checked.length} 项不变量）。`);
  process.exit(0);
}

console.log(`\n✗ 发现 ${problems.length} 个问题：\n`);
for (const p of problems) {
  console.log(`  ✗ ${p.file}`);
  console.log(`    不变量：${p.invariant}`);
  console.log(`    ${p.detail}\n`);
}
console.log("提示：桥的语义变更会影响仓库外的 skill 脚本。改完桥之后，"
  + "用 `node relay/check-skill-consumers.js` 确认外部消费者跟上了。");
process.exit(1);
