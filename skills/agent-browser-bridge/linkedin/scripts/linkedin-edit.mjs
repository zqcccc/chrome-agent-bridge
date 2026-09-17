#!/usr/bin/env node
// linkedin-edit —— 改 LinkedIn 档案的 Headline / About（带回读验证）。
//
// 安全设计（写公开档案是对外可见的动作，不可撤销）：
//   - `--dry-run` 只读现状并打印「将要写什么」，不写任何东西。**建议先跑它。**
//   - 写完一律回读验证（saveAndVerify 的三重验证 + 表单重新打开核对）。
//   - 默认不覆盖非空字段：要覆盖必须显式加 `--force`，避免误把现有内容冲掉。
//   - 改公开档案前建议先用 linkedin-read.mjs 看清现状。
//
// 用法:
//   BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node linkedin-edit.mjs <档案URL或slug> [选项]
//
// 选项:
//   --headline <文本>   写 Headline（个人简介标题）
//   --about <文本>      写 About（关于）
//   --file <路径>       从文件读正文（与 --about 搭配，避免长文本塞进命令行）
//   --lang <en|primary> 写哪个语言档案（默认 primary；Headline 不可本地化，见 SKILL.md）
//   --dry-run           只读现状并打印将写的内容，不修改任何东西
//   --force             允许覆盖非空字段（默认遇到非空值会拒绝）
//
// 示例:
//   node linkedin-edit.mjs xxx --headline "前端工程师 · ..." --dry-run
//   node linkedin-edit.mjs xxx --about "正文..." 
//   node linkedin-edit.mjs xxx --about --file ./about-en.md --lang en
//
// 前置: 桥已就绪，用户已在浏览器登录 linkedin.com。
import fs from "node:fs";
import { withProfile, ev, gotoForm, fillField, fillHeadline, saveAndVerify } from "./lib/linkedin.mjs";

// 实测的 URL（不要猜，见 SKILL.md「四个 URL」）
const ABOUT_PATH = "/edit/forms/summary/new/?profileFormEntryPoint=GUIDANCE_CARD";
const INTRO_PATH = "/edit/intro/";

function parseArgs(argv) {
  const out = { url: null, headline: null, about: null, file: null, lang: null, dryRun: false, force: false };
  const rest = [];
  // 已知的旗标名。`--about` 后面可以直接跟另一个旗标（`--about --file x.md`），
  // 这时 `--about` 不应把 `--file` 吃成自己的值——否则 `--file` 的路径就被当成正文了。
  // （实测踩过：`--about --file /tmp/x.md` 报「没有给文件路径」。）
  const FLAGS = new Set(["--headline", "--about", "--file", "--lang", "--dry-run", "--force", "-h", "--help"]);
  let i = 0;
  const takeValue = (name) => {
    const v = argv[++i];
    if (v === undefined || FLAGS.has(v)) {
      // 不合法：缺值，或后一个就是旗标。报错而不是静默拿到一个旗标字符串当值。
      console.error(`错误：${name} 缺少值`);
      process.exit(2);
    }
    return v;
  };
  for (i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--headline") out.headline = takeValue("--headline");
    else if (a === "--about") {
      // `--about` 的值可选：后面跟旗标时视为「从 --file 读」
      const nxt = argv[i + 1];
      out.about = nxt === undefined || FLAGS.has(nxt) ? "--file" : argv[++i];
    }
    else if (a === "--file") out.file = takeValue("--file");
    else if (a === "--lang") out.lang = takeValue("--lang");
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else rest.push(a);
  }
  out.url = rest[0] || null;
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.url || (!args.headline && !args.about)) {
  console.log(`用法: node linkedin-edit.mjs <档案URL或slug> [--headline <文本>] [--about <文本>|--about --file <路径>] [--lang en|primary] [--dry-run] [--force]

选项:
  --headline <文本>   写 Headline（不可本地化）
  --about <文本>      写 About
  --file <路径>       从文件读正文（与 --about 搭配）
  --lang <en|primary> 语言档案（默认 primary）
  --dry-run           只读现状并打印将写的内容，不修改
  --force             允许覆盖非空字段（默认拒绝覆盖非空）

示例:
  node linkedin-edit.mjs xxx --headline "前端工程师 · ..." --dry-run
  node linkedin-edit.mjs xxx --about --file ./about-en.md --lang en`);
  process.exit(args.help ? 0 : 2);
}

// `--about` 的取值有两种形式：
//   --about "正文..."           直接给文本
//   --about --file ./about.md   从文件读（长文本用这个，避免命令行转义与长度问题）
// 注意：`--about` 后面直接跟 `--file` 时，解析循环会把 args.about 设成字符串 "--file"
// （它只是下一个 argv）。所以这里要同时看 file 是否给出。
let aboutText = args.about;
if (args.about !== null && args.about !== undefined) {
  const looksLikeFileFlag = args.about === "--file" || args.about === "";
  if (looksLikeFileFlag) {
    if (!args.file) {
      console.error("错误：--about 后面是 --file，但没有给文件路径");
      process.exit(2);
    }
    aboutText = fs.readFileSync(args.file, "utf8").trim();
  } else if (args.file) {
    // 同时给了文本与文件：文件优先（更明确），但提醒一下避免误解
    console.error("注意：同时给了 --about 文本与 --file，以文件内容为准");
    aboutText = fs.readFileSync(args.file, "utf8").trim();
  }
}

const report = { slug: null, lang: args.lang || "primary", dryRun: args.dryRun, actions: [] };

await withProfile(
  args.url,
  async (tabId, rpc, slug) => {
    report.slug = slug;

    // ── Headline ──
    if (args.headline !== null && args.headline !== undefined) {
      await gotoForm(rpc, tabId, { slug, path: INTRO_PATH, timeoutMs: 45000 });
      const before = await ev(rpc, tabId, `(() => { var e=document.querySelector('dialog [contenteditable=true]'); return e ? String(e.innerText||'') : null; })()`);
      const item = { field: "headline", before: before ? before.slice(0, 120) : null, after: args.headline.slice(0, 120) };

      if (args.dryRun) {
        item.action = "would-write";
        report.actions.push(item);
      } else if (before && before.trim() && !args.force && before.trim() !== args.headline.trim()) {
        // 默认不覆盖非空字段：写公开档案不可撤销，静默覆盖是危险的默认值
        item.action = "refused-non-empty";
        item.hint = "目标字段非空。确认要覆盖请加 --force";
        report.actions.push(item);
      } else {
        const w = await fillHeadline(rpc, tabId, args.headline);
        const s = await saveAndVerify(rpc, tabId, {});
        item.action = "wrote";
        item.write = w;
        item.save = s;
        report.actions.push(item);
      }
    }

    // ── About ──
    if (aboutText !== null && aboutText !== undefined) {
      await gotoForm(rpc, tabId, { slug, path: ABOUT_PATH, lang: args.lang, timeoutMs: 45000 });
      const before = await ev(rpc, tabId, `(() => { var e=document.querySelector('dialog [contenteditable=true]'); return e ? String(e.innerText||'') : null; })()`);
      const item = { field: "about", lang: args.lang || "primary", beforeLen: before ? before.length : null, afterLen: String(aboutText).length };

      if (args.dryRun) {
        item.action = "would-write";
        item.preview = String(aboutText).slice(0, 200);
        report.actions.push(item);
      } else if (before && before.trim() && !args.force) {
        item.action = "refused-non-empty";
        item.hint = "About 非空。确认要覆盖请加 --force";
        report.actions.push(item);
      } else {
        const w = await fillField(rpc, tabId, "关于", aboutText);
        const s = await saveAndVerify(rpc, tabId, {});
        item.action = "wrote";
        item.write = w;
        item.save = s;
        report.actions.push(item);
      }
    }

    return report;
  },
  { keepOpen: false }
);

console.log(JSON.stringify(report, null, 2));

// 退出码：有任何一项没写成（被拒 / 保存失败）就非 0，方便脚本判断
const failed = report.actions.some(
  (a) => a.action === "refused-non-empty" || (a.action === "wrote" && (!a.write || a.write.ok === false || !a.save || a.save.ok === false))
);
process.exit(failed ? 1 : 0);
