#!/usr/bin/env node
// Agent Browser Bridge 的 MCP server（stdio）。把桥最常用的能力暴露为带参数 schema 的工具，
// Agent 不必自己拼 curl、读 token、处理多层解包；未覆盖的能力用 browser_rpc 直通（bridge.methods 查清单）。
// 注册：claude mcp add browser-bridge -- node <chrome-agent-bridge 仓库根>/mcp/server.mjs
// 环境变量与 scripts/lib/bridge.mjs 相同：BRIDGE_BROWSER=chrome|firefox、BRIDGE_PORT、BRIDGE_TOKEN。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Rpc, BridgeRpcError } from "../skills/agent-browser-bridge/scripts/lib/bridge.mjs";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const LINKS_IN_READ = 30;
const SCROLL_DIRECTIONS = ["up", "down", "left", "right"];
const INSPECT_FOCUS = ["overview", "links", "media", "scroll", "modal", "sel"];
const WAIT_KINDS = { ready: "page.waitForReady", url: "page.waitForUrl", selector: "page.waitForSelector" };

// 错误码 → 下一步该怎么做。只收录 Agent 最常遇到、且处理方式固定的码。
const ERROR_HINTS = {
  AGENT_STOPPED: "用户在页面上点了「停止 Agent」：立即停止一切写操作，向用户汇报进度并等待指示，不要自行 agent.resume。",
  STALE_ELEMENT_REF: "元素编号已失效（页面重渲染）：重新调 browser_snapshot 取新编号。",
  NOT_FOUND: "元素不存在：先 browser_snapshot 或 browser_inspect 看当前页面结构。",
  TAB_GONE: "标签页已关闭：用 browser_open 重新打开。",
  TAB_UNHEALTHY: "该标签页连续失败已熔断：用 browser_open 换一个标签页。",
  PAGE_CONTEXT_TIMEOUT: "页面上下文失效（导航中或被冻结）：稍后重试，或 browser_rpc tabs.prepare。",
  TAB_LEASED: "标签页被另一个 Agent 占用：换一个标签页。",
  UNKNOWN_METHOD: "方法名不存在：browser_rpc 调 bridge.methods 查看清单。",
  CONNECTION_REFUSED: "连不上本地桥：确认 Chrome 在运行且扩展已启用。",
};

const rpc = new Rpc({ agentId: `mcp-${process.pid}`, agentName: process.env.AGENT_NAME || "MCP" });
const server = new McpServer({ name: "agent-browser-bridge", version: pkg.version });

const text = (s) => ({ content: [{ type: "text", text: s }] });
const json = (v) => text(JSON.stringify(v, null, 2));

function fail(e) {
  const code = e instanceof BridgeRpcError ? e.code : "INTERNAL";
  const lines = [e instanceof BridgeRpcError ? e.message : String((e && e.stack) || e)];
  if (e && e.details) lines.push(`details: ${JSON.stringify(e.details)}`);
  if (ERROR_HINTS[code]) lines.push(`下一步: ${ERROR_HINTS[code]}`);
  return { isError: true, content: [{ type: "text", text: lines.join("\n") }] };
}

// 所有工具统一出错格式：错误码、details、下一步建议
function tool(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return await handler(args);
    } catch (e) {
      return fail(e);
    }
  });
}

const tabId = z.number().int().describe("标签页 id（browser_open / browser_tabs 返回）");
const target = z.string().describe("CSS 选择器，或 browser_snapshot 给出的元素编号如 @e3");
const READ_ONLY = { readOnlyHint: true, openWorldHint: true };

tool(
  "browser_read",
  {
    title: "读网页",
    description:
      "读取网页正文、标题、主链接，并诊断阻断（验证码 / 登录墙 / Cloudflare）。传 url 时自动复用或静默新开后台标签页，读完关闭本次新建的标签页。" +
      "前端渲染的站点也能读到内容，读网页一律用它而不是 curl / fetch。blocker 非空时按提示停手交给用户。",
    inputSchema: {
      url: z.string().optional().describe("网址；与 tabId 二选一"),
      tabId: tabId.optional().describe("读取已打开的标签页"),
      maxLength: z.number().int().optional().describe("正文最大字符数，默认 20000"),
      keepOpen: z.boolean().optional().describe("保留本次新建的标签页以便后续操作，默认 false"),
    },
    annotations: READ_ONLY,
  },
  async ({ url, tabId: id, maxLength, keepOpen }) => {
    if (!url && id === undefined) throw new BridgeRpcError("BAD_PARAMS", "url 与 tabId 至少给一个", "browser_read");
    const r = await rpc.readPage({ url, tabId: id, maxLength, keepOpen, maxLinks: LINKS_IN_READ });
    const out = [
      `# ${r.title || "(无标题)"}`,
      `${r.url}  tab=${r.tabId}${r.closed ? "（已关闭）" : ""}  正文 ${r.textLength} 字${r.truncated ? "（已截断）" : ""}`,
    ];
    if (r.blocker) out.push(`⚠ 阻断: ${JSON.stringify(r.blocker)}`);
    out.push("", r.text || "");
    if (r.links && r.links.length) out.push("", "## 链接", ...r.links.map((l) => `- ${l.text} → ${l.href}`));
    return text(out.join("\n"));
  }
);

tool(
  "browser_open",
  {
    title: "打开网址",
    description: "打开网址并返回 tabId：复用用户没在看的同类标签页，否则静默新开后台标签页（不抢前台）。用完调 browser_close 关闭自己开的标签页。",
    inputSchema: {
      url: z.string(),
      match: z.enum(["host", "origin", "exact"]).optional().describe("复用标签页的匹配方式，默认 host"),
    },
    annotations: { openWorldHint: true },
  },
  async ({ url, match }) => {
    const r = await rpc.call("tabs.resolve", { url, match: match || "host", waitLoad: true }, 45000);
    return json({ tabId: r.tabId, reused: r.reused, navigated: r.navigated, url: r.tab && r.tab.url, title: r.tab && r.tab.title });
  }
);

tool(
  "browser_navigate",
  {
    title: "标签页内跳转",
    description: "在已有标签页内跳转到新网址并等待加载。",
    inputSchema: { tabId, url: z.string() },
    annotations: { openWorldHint: true },
  },
  async ({ tabId: id, url }) => json(await rpc.call("page.navigate", { tabId: id, url, waitLoad: true }, 45000))
);

tool(
  "browser_tabs",
  { title: "列出标签页", description: "列出所有标签页（id、标题、url、是否活动）。", annotations: READ_ONLY },
  async () => {
    const { tabs } = await rpc.call("tabs.list");
    return text(tabs.map((t) => `${t.active ? "*" : " "} ${t.id}  ${t.title}  ${t.url}`).join("\n"));
  }
);

tool(
  "browser_close",
  { title: "关闭标签页", description: "关闭标签页。只关自己用 browser_open 新开的。", inputSchema: { tabId } },
  async ({ tabId: id }) => json(await rpc.call("tabs.close", { tabId: id }))
);

tool(
  "browser_snapshot",
  {
    title: "页面元素快照",
    description: "列出页面可见的交互元素，每个带编号如 [e3]。编号可直接作为 browser_click / browser_type 的 target（写成 @e3）。页面变化后编号可能失效，重新快照即可。",
    inputSchema: { tabId, includeText: z.boolean().optional().describe("附带页面正文，默认 false") },
    annotations: READ_ONLY,
  },
  async ({ tabId: id, includeText }) => {
    const s = await rpc.snapshotCompact(id, { includeText: !!includeText });
    const out = [`${s.url}  (${s.title})  元素 ${s.elementCount} 个`, s.compact || ""];
    if (s.text) out.push("", "## 正文", s.text);
    return text(out.join("\n"));
  }
);

tool(
  "browser_click",
  {
    title: "点击",
    description:
      "点击元素或坐标，返回 delta（urlChanged / modalOpened / mutationCount 等）用于判断是否生效。" +
      "默认真实鼠标事件（React / Vue 组件要求）；mode=dom 用 el.click()（少数按钮只认它）。后台标签页会被临时切为活动页（不聚焦窗口，空闲后归还）。",
    inputSchema: {
      tabId,
      target: target.optional(),
      x: z.number().optional().describe("视口坐标，与 target 二选一"),
      y: z.number().optional(),
      mode: z.enum(["real", "dom"]).optional().describe("默认 real"),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ tabId: id, target: sel, x, y, mode }) => {
    if (mode === "dom") {
      if (!sel) throw new BridgeRpcError("BAD_PARAMS", "mode=dom 需要 target", "browser_click");
      return json(await rpc.call("page.click", { tabId: id, selector: sel }));
    }
    if (sel) return json(await rpc.clickReal(id, sel));
    if (x === undefined || y === undefined) throw new BridgeRpcError("BAD_PARAMS", "需要 target 或 x / y", "browser_click");
    return json(await rpc.clickReal(id, x, y));
  }
);

tool(
  "browser_type",
  {
    title: "输入文本",
    description:
      "向输入框写入文本（先清空），返回 verified 表示回读确认已写入。默认 CDP 受控输入（React / Vue / 富文本编辑器可用）；mode=dom 直接设置 value。pressEnter=true 输入后回车。",
    inputSchema: {
      tabId,
      target,
      text: z.string(),
      pressEnter: z.boolean().optional(),
      clear: z.boolean().optional().describe("先清空，默认 true"),
      mode: z.enum(["real", "dom"]).optional().describe("默认 real"),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ tabId: id, target: sel, text: value, pressEnter, clear, mode }) => {
    if (mode === "dom") {
      const r = await rpc.call("page.type", { tabId: id, selector: sel, text: value, clear });
      if (pressEnter) await rpc.call("page.press", { tabId: id, selector: sel, key: "Enter" });
      return json(r);
    }
    return json(await rpc.typeReal(id, sel, value, { pressEnter: !!pressEnter, clear }));
  }
);

tool(
  "browser_press",
  {
    title: "按键",
    description: "向焦点元素（或 target）派发按键：Enter / Escape / Tab / ArrowDown 等。",
    inputSchema: { tabId, key: z.string(), target: target.optional() },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ tabId: id, key, target: sel }) => json(await rpc.call("page.press", { tabId: id, key, ...(sel ? { selector: sel } : {}) }))
);

tool(
  "browser_scroll",
  {
    title: "滚动",
    description: "滚动页面。loadMore=true 用于懒加载列表：确认页面真的变高，后台标签页渲染暂停时自动临时激活后重试；到底了会报 SCROLL_NO_GROWTH。",
    inputSchema: {
      tabId,
      direction: z.enum(SCROLL_DIRECTIONS).optional().describe("默认 down"),
      target: target.optional().describe("滚动到该元素"),
      loadMore: z.boolean().optional(),
    },
    annotations: { openWorldHint: true },
  },
  async ({ tabId: id, direction, target: sel, loadMore }) => {
    if (sel) return json(await rpc.call("page.scroll", { tabId: id, selector: sel }));
    if (loadMore) return json(await rpc.scrollLoad(id, { direction: direction || "down", expectGrowth: true }));
    return json(await rpc.call("page.scroll", { tabId: id, direction: direction || "down" }));
  }
);

tool(
  "browser_eval",
  {
    title: "执行 JS",
    description: "在页面执行 JS 表达式并取回值（经 CDP，不受页面 CSP 限制）。表达式可返回 Promise。用于抽取结构化数据；能用 browser_read / browser_snapshot 解决的不要写 JS。",
    inputSchema: { tabId, expression: z.string() },
    annotations: { openWorldHint: true },
  },
  async ({ tabId: id, expression }) => json(await rpc.ev(id, expression, { awaitPromise: true }))
);

tool(
  "browser_inspect",
  {
    title: "页面探查",
    description: "只读探查页面结构：overview（阻断诊断 blocker、弹窗、可滚动容器、搜索框）| links | media | scroll | modal | sel（按 selector 采样）。",
    inputSchema: {
      tabId,
      focus: z.enum(INSPECT_FOCUS).optional().describe("默认 overview"),
      selector: z.string().optional().describe("focus=sel 时必填"),
      limit: z.number().int().optional(),
    },
    annotations: READ_ONLY,
  },
  async ({ tabId: id, focus, selector, limit }) => json(await rpc.call("page.inspect", { tabId: id, focus: focus || "overview", selector, limit }))
);

tool(
  "browser_wait",
  {
    title: "等待",
    description: "等待条件满足：ready（页面就绪）| url（URL 包含 value）| selector（元素出现）。代替固定 sleep。",
    inputSchema: {
      tabId,
      kind: z.enum(Object.keys(WAIT_KINDS)),
      value: z.string().optional().describe("kind=url 时为 URL 子串，kind=selector 时为选择器"),
      timeoutMs: z.number().int().optional().describe("默认 30000"),
    },
    annotations: READ_ONLY,
  },
  async ({ tabId: id, kind, value, timeoutMs }) => {
    const params = { tabId: id, timeoutMs };
    if (kind === "url") params.match = value;
    if (kind === "selector") params.selector = value;
    return json(await rpc.call(WAIT_KINDS[kind], params, (timeoutMs || 30000) + 5000));
  }
);

tool(
  "browser_screenshot",
  {
    title: "截图",
    description: "静默截取标签页可见区域（不切前台）。fullPage=true 截整页。",
    inputSchema: { tabId, fullPage: z.boolean().optional() },
    annotations: READ_ONLY,
  },
  async ({ tabId: id, fullPage }) => {
    const r = await rpc.call("page.screenshot", { tabId: id, format: "png", captureBeyondViewport: !!fullPage }, 30000);
    return { content: [{ type: "image", data: String(r.image).split(",")[1], mimeType: "image/png" }] };
  }
);

tool(
  "browser_upload",
  {
    title: "上传文件",
    description: "给 <input type=file> 注入本地文件（绝对路径）。",
    inputSchema: { tabId, files: z.array(z.string()), selector: z.string().optional().describe('默认 input[type="file"]') },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ tabId: id, files, selector }) => json(await rpc.uploadFile(id, selector, files))
);

tool(
  "browser_rpc",
  {
    title: "调用任意桥方法",
    description:
      "直通桥的任意 RPC 方法（上面的工具没覆盖时用）。先调 method=bridge.methods 查看全部方法与参数，或传 params={name:\"page.record.get\"} 只看一个。",
    inputSchema: {
      method: z.string(),
      params: z.record(z.string(), z.any()).optional(),
      timeoutMs: z.number().int().optional().describe("默认 30000"),
    },
    annotations: { openWorldHint: true },
  },
  async ({ method, params, timeoutMs }) => json(await rpc.callRaw(method, params || {}, timeoutMs || 30000))
);

const transport = new StdioServerTransport();
await server.connect(transport);

// 客户端断开时释放本进程持有的调试会话与标签页租约
const shutdown = async () => {
  await rpc.cleanup();
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
