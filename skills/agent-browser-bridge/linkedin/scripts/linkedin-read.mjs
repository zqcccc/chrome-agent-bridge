#!/usr/bin/env node
// linkedin-read —— 只读读取 LinkedIn 档案（默认安全，不改任何东西）。
//
// 为什么先有这个脚本：改动档案前必须先看清现状（「变更前先读，变更后回读」是本仓库约束零）。
// 而且只读脚本没有副作用，可以先跑通确认桥/登录态/档案 URL 都对，再动写操作。
//
// 用法:
//   BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node linkedin-read.mjs <档案URL或slug> [选项]
//
// 选项:
//   --section <name>   读指定区块: experience | projects | education | skills | certifications
//   --lang <en|primary> 读哪个语言档案（默认 primary 主档案）
//   --json             输出原始 JSON（默认人类可读）
//   --all              读所有常见区块（较慢）
//
// 示例:
//   node linkedin-read.mjs https://www.linkedin.com/in/xxx/
//   node linkedin-read.mjs xxx --section experience --lang en
//   node linkedin-read.mjs xxx --all --json
//
// 前置: 桥已就绪（host 存活 + 扩展已连接），用户已在浏览器登录 linkedin.com。
import { withProfile, readSection, readIntro } from "./lib/linkedin.mjs";

const SECTIONS = ["experience", "projects", "education", "skills", "certifications", "courses"];

function parseArgs(argv) {
  const out = { url: null, section: null, lang: null, json: false, all: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--section") out.section = argv[++i];
    else if (a === "--lang") out.lang = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--all") out.all = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else rest.push(a);
  }
  out.url = rest[0] || null;
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.url) {
  console.log(`用法: node linkedin-read.mjs <档案URL或slug> [--section <name>] [--lang en|primary] [--all] [--json]

区块: ${SECTIONS.join(" | ")}

示例:
  node linkedin-read.mjs https://www.linkedin.com/in/xxx/
  node linkedin-read.mjs xxx --section experience --lang en
  node linkedin-read.mjs xxx --all --json`);
  process.exit(args.help ? 0 : 2);
}

const targetSections = args.all ? SECTIONS : args.section ? [args.section] : ["experience", "projects", "education", "skills"];

const result = await withProfile(
  args.url,
  async (tabId, rpc, slug) => {
    const intro = await readIntro(rpc, tabId, { slug, lang: args.lang });
    const sections = {};
    for (const s of targetSections) {
      sections[s] = await readSection(rpc, tabId, { slug, section: s, lang: args.lang });
    }
    return { slug, lang: args.lang || "primary", intro, sections };
  },
  { keepOpen: false }
);

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`档案: ${result.slug}   语言: ${result.lang}`);
  console.log(`姓名: ${result.intro.name || "(未读到)"}`);
  if (result.intro.headline) console.log(`Headline: ${result.intro.headline.slice(0,160)}`);
  if (result.intro.top) console.log(`顶部: ${result.intro.top.replace(/\n/g, " | ").slice(0, 200)}`);
  console.log("");
  for (const [name, sec] of Object.entries(result.sections)) {
    const items = (sec && sec.items) || [];
    console.log(`── ${name}（${items.length} 条）`);
    for (const it of items) {
      const one = it.text.replace(/\s*\n\s*/g, " · ").slice(0, 160);
      console.log(`   • ${one}${it.editId ? `   [id=${it.editId}]` : ""}`);
    }
    console.log("");
  }
}

process.exit(0);
