// 回归测试：LinkedIn 公共层生成「页面内 JS 表达式」时不得被模板字符串转义坑坏掉。
//
// 背景（实测踩到的真 bug）：
//   `lib/linkedin.mjs` 用模板字符串拼页面内执行的 JS。模板字符串里的 `\n` 是**真实换行**，
//   不是两个字符 `\` + `n`。所以写 `split('\n')` 拼出来的表达式会当场断成两行：
//
//     var html = String(v).split('
//     ').map(...)          ← 语法错误：Unexpected token 'var'
//
//   实测影响 `fillField` 的富文本分支 —— **任何多行富文本写入都是坏的**（About、项目描述）。
//   这与本仓库已记录的「单反斜杠被吃成 d」（`\d` → `d`，正则静默失配）是同一类坑：
//   **不要在模板字符串里直接写正则/转义符**，要么用字符串切分，要么用 JSON.stringify 注入。
//
// 本测试不碰网络、不碰浏览器：它把 mock rpc 接到公共层上，抓出真正会发给页面的表达式，
// 然后用 `new Function` 当解析器逐个验证语法。这类错误在真实使用里表现为
// 「脚本报语法错但看起来莫名其妙」，用解析器断言能在毫秒内定位。
//
// 用法: node relay/test-linkedin-expr.mjs
import { fillField, fillHeadline, readSection, fieldExpr, langParams, withQuery, normalizeSlug } from "../skills/agent-browser-bridge/linkedin/scripts/lib/linkedin.mjs";

let pass = 0, fail = 0;
const t = (n, c, e = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, e); } };

/** 抓取公共层真正发给页面的表达式（不执行，只收集）。 */
function mockRpc() {
  const seen = [];
  return {
    seen,
    ev: async (_tabId, expr) => { seen.push(expr); return "1"; },
    evJson: async (_tabId, expr) => { seen.push(expr); return { ok: true, len: 5, count: 0, items: [] }; },
    call: async () => ({}),
    clickReal: async () => {},
    attach: async () => {},
    detach: async () => {},
  };
}

/** 断言收集到的每个表达式都是合法 JS（用解析器，不是肉眼）。 */
function assertAllParse(seen, label) {
  const bad = [];
  seen.forEach((e, i) => {
    try { new Function("return (" + e + ")"); }
    catch (err) { bad.push({ i, err: err.message, snippet: e.slice(0, 200) }); }
  });
  t(`${label}：生成的表达式全部可解析（${seen.length} 个）`, bad.length === 0,
    bad.length ? `第 ${bad.map((b) => b.i).join(",")} 个失败: ${bad[0].err}\n${bad[0].snippet}` : "");
}

console.log("== 1. 多行文本写入（曾经被 \\n 转义坑坏） ==");
{
  const rpc = mockRpc();
  const multi = "第一行\n第二行\n\n第四行";
  await fillField(rpc, 1, "描述", multi);
  assertAllParse(rpc.seen, "fillField 多行");

  // 关键断言：生成的多行处理必须用「转义后的换行」而不是真实换行
  const joined = rpc.seen.join("\n---\n");
  t("表达式中出现的是转义换行 \\n 而非真实换行", joined.includes('split("\\n")') || joined.includes("split('\\n')"),
    joined.includes('split("\\n")') ? "" : "未找到 split 转义写法");
  // 反向断言：不应存在「split(' 后面直接换行」这种断行
  t("没有把表达式断成两行的 split", !/split\('[^']*$/.test(joined) || !/split\('\s*$/m.test(joined), "");
}

console.log("\n== 2. Headline 写入（无 aria-label 的 TipTap 字段） ==");
{
  const rpc = mockRpc();
  await fillHeadline(rpc, 1, "标题一\n标题二");
  assertAllParse(rpc.seen, "fillHeadline");
}

console.log("\n== 3. 区块读取（id 解析不能依赖被吃坏的正则） ==");
{
  const rpc = mockRpc();
  await readSection(rpc, 1, { slug: "https://www.linkedin.com/in/example", section: "experience" });
  assertAllParse(rpc.seen, "readSection");

  // 关键断言：id 解析必须用字符串切分（本仓库踩过 \d 被吃成 d 的坑）
  const expr = rpc.seen.join("\n");
  t("id 解析用字符串切分而非正则", expr.includes("split('/edit/forms/')"), "");
  t("没有出现被吃坏的裸 d+ 正则", !/\/\^d\+\$\//.test(expr), "疑似 \\d 被吃成 d");
}

console.log("\n== 4. fieldExpr 的转义（含正则的表达式） ==");
{
  const rpc = mockRpc();
  const e = fieldExpr("项目名称");
  try { new Function("return (" + e + ")"); t("fieldExpr 输出可解析", true); }
  catch (err) { t("fieldExpr 输出可解析", false, err.message); }
  // 标签文本必须被 JSON.stringify 安全注入（防引号/换行注入破坏表达式）
  const weird = fieldExpr('a"b\nc');
  try { new Function("return (" + weird + ")"); t("含引号与换行的标签文本仍可解析", true); }
  catch (err) { t("含引号与换行的标签文本仍可解析", false, err.message); }
}

console.log("\n== 5. 富文本必须写 innerHTML（而不是 innerText） ==");
{
  const rpc = mockRpc();
  await fillField(rpc, 1, "关于", "line1\nline2");
  const expr = rpc.seen.join("\n");
  t("富文本分支使用 innerHTML", expr.includes("el.innerHTML = html"), "");
  t("富文本分支派发 InputEvent", expr.includes("InputEvent"), "");
  t("富文本内容包在 <p> 里（ProseMirror 需要文档结构）", expr.includes("<p>"), "");
}

console.log("\n== 6. 语言档案 URL 拼接（曾经拼出双问号，静默回退到主档案） ==");
{
  // 实测坑：About 的表单路径自带查询串 `?profileFormEntryPoint=GUIDANCE_CARD`，
  // 若直接再拼 `?language=en`，会拼出**双问号**的非法 URL，LinkedIn 把后一个参数
  // 当成前一个参数值的一部分（`...GUIDANCE_CARD%3Flanguage%3Den`）→ **静默回退到主档案**。
  // 现象：请求英文档案，读到的是中文，且不报任何错。
  const ABOUT = "/edit/forms/summary/new/?profileFormEntryPoint=GUIDANCE_CARD";
  const merged = withQuery(ABOUT, langParams("en"));

  t("合并后只有一个问号", (merged.match(/\?/g) || []).length === 1, merged);
  t("语言参数用 & 接在后面", merged.includes("?profileFormEntryPoint=GUIDANCE_CARD&language=en"), merged);
  t("与 LinkedIn 实际链接一致", merged === "/edit/forms/summary/new/?profileFormEntryPoint=GUIDANCE_CARD&language=en&country=US", merged);
  t("没有双问号", !merged.includes("?language") || !/\?.+\?/.test(merged), merged);

  // 不带查询串的路径仍要用 `?`
  const intro = withQuery("/edit/intro/", langParams("en"));
  t("无查询串路径用 ? 拼接", intro === "/edit/intro/?language=en&country=US", intro);
  // primary 不拼任何参数
  t("primary 不拼参数", withQuery(ABOUT, langParams("primary")) === ABOUT, "");
  t("normalizeSlug 去掉已有查询串", normalizeSlug("https://www.linkedin.com/in/abc/?x=1") === "https://www.linkedin.com/in/abc", "");
}

console.log("\n== 7. linkedin-edit.mjs 参数解析（防「把旗标当成值」） ==");
{
  const { spawnSync } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(here, "../skills/agent-browser-bridge/linkedin/scripts/linkedin-edit.mjs");
  const URL_ = "https://www.linkedin.com/in/example";

  // 这些路径在碰到桥之前就会退出（参数校验阶段），所以不需要浏览器
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 15000 });

  // 关键回归：旗标不得被当成值。旧解析器 `out.headline = argv[++i]` 会把
  // `--headline --dry-run` 里的 `--dry-run` 当成标题文本（于是把 "--dry-run" 写进档案！），
  // 且 `--headline` 后面什么都不跟时静默拿到 `undefined` 继续跑。
  const flagAsValue = run([URL_, "--headline", "--dry-run"]);
  t("--headline 后跟旗标 → 报错退出码 2（不把旗标当值）", flagAsValue.status === 2, `实际 ${flagAsValue.status}`);

  // 缺值必须报错退出（而不是静默拿到 undefined 继续跑）
  const noVal = run([URL_, "--headline"]);
  t("--headline 缺值 → 退出码 2", noVal.status === 2, `实际 ${noVal.status}`);
  const noVal2 = run([URL_, "--about", "x", "--lang"]);
  t("--lang 缺值 → 退出码 2", noVal2.status === 2, `实际 ${noVal2.status}`);
  const noUrl = run(["--headline", "x"]);
  t("缺档案 URL → 退出码 2", noUrl.status === 2, `实际 ${noUrl.status}`);

  // 合法形式不得误报（防止为了防旗标而把所有值都拒了）
  // 注：这里用不存在的文件，因为需要文件内容的断言要跑浏览器；这里只验证不报「缺值」。
  const withFile = run([URL_, "--about", "--file", "/nonexistent-xyz.md", "--dry-run"]);
  const out = (withFile.stdout || "") + (withFile.stderr || "");
  t("--about --file <路径> 不报缺值", !out.includes("缺少值"), out.slice(0, 120));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
