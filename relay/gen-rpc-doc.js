// 从 methods.js 生成 skill 的 RPC 方法参考：skills/agent-browser-bridge/reference/rpc.md
// 用法：node relay/gen-rpc-doc.js           # 写文件
//       node relay/gen-rpc-doc.js --check   # 只比对，过期则退出码 1（test:unit-all 用）
"use strict";

const fs = require("fs");
const path = require("path");
const { METHODS, resolveMethod } = require("./methods");

const OUT = path.join(__dirname, "..", "skills", "agent-browser-bridge", "reference", "rpc.md");

const GROUPS = [
  ["桥自身", /^((bridge|extension)\.|help$)/],
  ["停止 / 恢复", /^agent\./],
  ["标签页", /^(tabs\.|page\.open$|page\.reload$)/],
  ["导航与等待", /^page\.(info|navigate|back|forward|focus|ensureActive|restoreActive|wait)/],
  ["读取与截图", /^page\.(read|snapshot|inspect|evaluate|evalCdp|screenshot|activateAndShot|record\.)/],
  ["交互（返回值带 delta）", /^page\.(click|clickReal|type|typeReal|press|select|hover|focusEl|scroll|uploadFile)$/],
  ["视觉指示器", /^page\.indicator\./],
  ["CDP 直通", /^session\./],
];

const esc = (s) => String(s).replace(/\|/g, "\\|");

function render() {
  const lines = [
    "<!-- 本文件由 relay/gen-rpc-doc.js 从 relay/methods.js 生成，不要手改。运行时也可调 bridge.methods 取同一份数据。 -->",
    "",
    "# RPC 方法参考",
    "",
    "调用格式：`POST http://127.0.0.1:8778/rpc`（Firefox 为 8779），请求头 `Authorization: Bearer <~/.chrome-agent-bridge/token>`，",
    "请求体 `{\"method\":\"<方法>\",\"params\":{...},\"timeoutMs\":20000}`。成功返回 `{ok:true,result}`，失败返回 `{ok:false,error:{code,message,details?}}`。",
    "",
    "运行时查询（与本文同源）：",
    "",
    "```bash",
    "curl -s -X POST http://127.0.0.1:8778/rpc -H \"Authorization: Bearer $(cat ~/.chrome-agent-bridge/token)\" \\",
    "  -H 'Content-Type: application/json' -d '{\"method\":\"bridge.methods\",\"params\":{\"name\":\"page.clickReal\"}}'",
    "```",
    "",
    "调用未登记的方法返回 `UNKNOWN_METHOD`，`error.details.suggestions` 给出最接近的方法名。",
    "",
  ];
  const names = Object.keys(METHODS);
  const used = new Set();
  for (const [title, re] of GROUPS) {
    const group = names.filter((n) => re.test(n) && !used.has(n));
    if (!group.length) continue;
    lines.push(`## ${title}`, "", "| 方法 | 说明 | 参数（* 为必填） |", "|---|---|---|");
    for (const n of group) {
      used.add(n);
      const m = resolveMethod(n);
      const desc = m.aliasOf ? `\`${m.aliasOf}\` 的别名` : esc(m.desc);
      const req = new Set(m.required || []);
      const params = m.aliasOf
        ? "同上"
        : Object.entries(m.params || {}).map(([k, v]) => `\`${k}${req.has(k) ? "*" : ""}\`: ${esc(v)}`).join("<br>") || "—";
      lines.push(`| \`${n}\` | ${desc} | ${params} |`);
    }
    lines.push("");
  }
  const orphan = names.filter((n) => !used.has(n));
  if (orphan.length) throw new Error(`gen-rpc-doc: 以下方法没有归入任何分组：${orphan.join(", ")}`);
  return lines.join("\n");
}

const content = render();
if (process.argv.includes("--check")) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (cur !== content) {
    console.error(`reference/rpc.md 已过期：改了 relay/methods.js 后运行 node relay/gen-rpc-doc.js`);
    process.exit(1);
  }
  console.log("reference/rpc.md 与 methods.js 一致");
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, content);
  console.log(`已生成 ${path.relative(process.cwd(), OUT)}`);
}
