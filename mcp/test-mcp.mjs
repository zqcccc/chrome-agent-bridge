// 真机回归：用官方 MCP 客户端经 stdio 驱动 server.mjs，覆盖工具清单、读页、快照 → 按编号点击 / 输入、截图与错误格式。
// 本地起页面，不依赖外网。用法：node mcp/test-mcp.mjs（需要桥在运行）
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let pass = 0, fail = 0;
const t = (n, c, e = "") => { if (c) { pass++; console.log("  ✓", n); } else { fail++; console.log("  ✗", n, e); } };

const PAGE = `<!doctype html><meta charset="utf-8"><title>mcp-test</title>
<h1>MCP 测试页</h1><p>这是一段用于 browser_read 的正文，长度要超过八十个字符，否则读取逻辑会判定为后台渲染未完成并尝试激活标签页重读。再补一句凑够长度。</p>
<input id="q" placeholder="搜索"><button id="go" onclick="document.body.dataset.clicked=document.querySelector('#q').value">搜索</button>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${server.address().port}/?mcp=${process.pid}`;

const client = new Client({ name: "mcp-test", version: "0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [new URL("./server.mjs", import.meta.url).pathname],
  env: { ...process.env, AGENT_NAME: "McpTest" },
  stderr: "inherit",
}));
const call = (name, args) => client.callTool({ name, arguments: args });
const txt = (r) => (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

let tabId;
try {
  console.log("== 工具清单 ==");
  const { tools } = await client.listTools();
  const names = tools.map((x) => x.name);
  t("包含核心工具", ["browser_read", "browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_rpc"].every((n) => names.includes(n)), names.join(","));
  t("工具带参数 schema", tools.find((x) => x.name === "browser_click").inputSchema.properties.target !== undefined);

  console.log("\n== 打开 / 读取 ==");
  const opened = JSON.parse(txt(await call("browser_open", { url: URL_, match: "exact" })));
  tabId = opened.tabId;
  t("browser_open 返回 tabId", Number.isInteger(tabId), JSON.stringify(opened));
  const read = await call("browser_read", { tabId });
  t("browser_read 读到正文", !read.isError && /MCP 测试页/.test(txt(read)), txt(read).slice(0, 120));

  console.log("\n== 快照 → 按编号输入与点击 ==");
  const snap = txt(await call("browser_snapshot", { tabId }));
  const inputRef = (snap.match(/\[(e\d+)\] textbox/) || [])[1];
  const btnRef = (snap.match(/\[(e\d+)\] button/) || [])[1];
  t("快照给出输入框与按钮编号", inputRef && btnRef, snap.slice(0, 200));
  const typed = await call("browser_type", { tabId, target: `@${inputRef}`, text: "bridge" });
  t("browser_type verified", !typed.isError && JSON.parse(txt(typed)).verified === true, txt(typed).slice(0, 160));
  const clicked = await call("browser_click", { tabId, target: `@${btnRef}` });
  t("browser_click 成功", !clicked.isError, txt(clicked).slice(0, 160));
  // 不用 document.title 判定：指示器会改写标题（「● [Agent] 接管中 | 原标题」）
  const clickedVal = JSON.parse(txt(await call("browser_eval", { tabId, expression: "document.body.dataset.clicked || ''" })));
  t("点击生效（按钮读到了输入值）", clickedVal === "bridge", clickedVal);

  console.log("\n== 截图 ==");
  const shot = await call("browser_screenshot", { tabId });
  t("返回 png 图像内容", shot.content && shot.content[0].type === "image" && shot.content[0].data.length > 100);

  console.log("\n== 错误格式 ==");
  const bad = await call("browser_rpc", { method: "page.eval", params: { tabId } });
  t("isError=true", bad.isError === true);
  t("含错误码、suggestions 与下一步建议", /UNKNOWN_METHOD/.test(txt(bad)) && /suggestions/.test(txt(bad)) && /下一步/.test(txt(bad)), txt(bad));
  const stale = await call("browser_click", { tabId, target: "@e99999" });
  t("失效编号报错带建议", stale.isError === true && /下一步/.test(txt(stale)), txt(stale));
} finally {
  if (tabId) await call("browser_close", { tabId }).catch(() => {});
  await client.close();
  server.close();
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
