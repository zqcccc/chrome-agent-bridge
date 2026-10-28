---
name: agent-browser-bridge
description: 用真实 Chrome 打开、读取、操作任意网页——**拿到 http(s) 链接要读内容时默认用本技能，不要先试 curl / wget / WebFetch 赌它是静态页**：前端渲染的站点（SPA / React / Vue / 动态加载）用 curl 只能拿到空壳 HTML，正文一个字都没有，而且**不会报错**，会静默给出错误结论。覆盖：读网页正文与价格/文档/列表数据、站内搜索、抓取动态渲染或登录后数据、点击输入滚动截图、执行 JS、下载文件、填表提交发消息投递下单预订、管理后台操作。走用户日常 Chrome 与真实登录态，可进入被反爬 / 风控拦截（验证码、登录墙、无头指纹、滑块）与需登录页面：小红书、知乎、大众点评、BOSS 直聘、公众号后台、网银、论坛等。已有专项子技能（xhs / boss / chatgpt / notebooklm / linkedin / debug / captcha）必须先读其 SKILL.md 并优先复用 scripts/ 下现成脚本与 scripts/lib/bridge.mjs；遇到页面改版、结构变动或未收录站点时，通过 page.inspect 实时探查并灵活应变；任务中验证通过的新站点配方、改版适配与通用经验必须在收尾时沉淀回子技能、scripts/ 或 KNOWN_ISSUES.md。需要登录 / 授权 / 扫码 / 验证码时，必须先告知用户要访问的页面与原因并等待用户手动完成，不得替用户登录或绕过验证。判断口径：**只要任务是「从某个网址拿到内容」或「在网页上做操作」，就是本技能**，不存在「先用通用工具试、失败再切过来」的降级层。
---

# Agent Browser Bridge —— 让 Agent 操作日常 Chrome

架构：Chrome 扩展（MV3）↔ 本地桥 host（`127.0.0.1:8778`）↔ Agent 客户端（HTTP/WS JSON-RPC）。驱动用户日常 Chrome（真实登录态、真实指纹、真实环境）。

**也支持 Firefox**：同一套 RPC 方法、参数、返回结构与错误码，host 端口为 `8779`。设环境变量 `BRIDGE_BROWSER=firefox`（或 `BRIDGE_PORT=8779`）后，`scripts/` 下全部入口都连 Firefox；不设时连 Chrome。前置条件与差异见 `firefox/SKILL.md`。

## 路径约定

| 记号 | 含义 |
| --- | --- |
| `<skill 目录>` | 本 `SKILL.md` 所在目录（子技能文档里的 `<skill 目录>` 指子技能自己的目录，根目录是它的上一级） |
| `<bb>` | `node <skill 目录>/scripts/bb.mjs`，skill 自带的命令行入口，token 自动读取，不依赖 cwd |

这些位置可由加载路径推导，不要用 `find ~` 之类全盘搜索定位。

## 四种调用入口（能力相同，按场景选）

| 入口 | 适用场景 | 起手 |
| --- | --- | --- |
| MCP 工具 `browser_*` | 当前会话已注册本桥的 MCP server（工具列表里有 `browser_read` 等） | 直接调用；没覆盖的能力用 `browser_rpc` |
| `<bb>` 命令行 | 单步操作、探查、临时读页 | `<bb> read <url>`；不带参数列出全部命令 |
| `scripts/lib/bridge.mjs` | 多步流程、批量脚本 | `import { Rpc } from "<skill 目录>/scripts/lib/bridge.mjs"` |
| 裸 HTTP | 其他语言 | `POST http://127.0.0.1:8778/rpc`，见 `reference/core.md` 开头 |

**查有哪些方法**：`<bb> methods [方法名]`，或 RPC `bridge.methods`（别名 `help`）；离线索引见 `reference/rpc.md`。方法名写错时 `UNKNOWN_METHOD` 的 `error.details.suggestions` 给出最接近的方法名。

MCP server 位于仓库根 `mcp/server.mjs`（本机仓库的便利入口，依赖 `@modelcontextprotocol/sdk`）。用户要求接入时执行：

```bash
cd <chrome-agent-bridge 仓库根>/mcp && npm install
claude mcp add agent-browser-bridge -- node <chrome-agent-bridge 仓库根>/mcp/server.mjs
```

---

## 开工前必读（按顺序执行）

### 1. 读 `KNOWN_ISSUES.md` 与查子技能索引

任务命中下方任一行 → **先读对应子技能的 `SKILL.md`，优先直接运行现成脚本**。未命中时先看 `KNOWN_ISSUES.md` 了解行为红线与错误码。

| 站点 / 目标 | 子技能 | 现成脚本（`<skill 目录>/scripts/`） |
| --- | --- | --- |
| **小红书 xiaohongshu.com**（搜笔记、抓正文、**全量评论含楼中楼二级回复**、搜用户、用户主页、问点点 AI） | `xhs/SKILL.md` | `extract-xhs-comments.mjs`、`xhs-search-inpage.mjs`、`xhs-note-full.mjs`、`xhs-search-user.mjs`、`xhs-user-notes.mjs`、`xhs-ask-diandian.mjs`、`xhs-dismiss-softblock.mjs` |
| **BOSS 直聘 zhipin.com**（搜职位、筛选、读 JD、打招呼投递） | `boss/SKILL.md` | `boss-send-chat.mjs`、`boss-batch-apply.mjs`、`boss-verify-helpers.mjs` |
| **ChatGPT chatgpt.com**（网页端提问、读回复、选模型、生图；严格 CSP 禁 `page.evaluate`） | `chatgpt/SKILL.md` | `chatgpt-ask.mjs`、`cdp-eval.mjs` |
| **NotebookLM**（新建笔记本、上传来源、提问、Studio 产物） | `notebooklm/SKILL.md` | `notebooklm/upload.mjs`、`notebooklm/ask.mjs`、`notebooklm/scripts/*.mjs`、`scripts/cdp-upload.mjs` |
| **LinkedIn linkedin.com**（读档案、改 Headline/About、增删改经历与项目、中英双语档案） | `linkedin/SKILL.md` | `linkedin/scripts/linkedin-read.mjs`、`linkedin/scripts/linkedin-edit.mjs`、`linkedin/scripts/lib/linkedin.mjs` |
| **脉脉 maimai.cn**（捞远程招聘帖当信源：动态/职言搜索、帖子详情、微信邮箱提取；桌面网页无求职者职位库） | `maimai/SKILL.md` | 无现成脚本：按 `maimai/SKILL.md` 配方用 `scripts/lib/bridge.mjs` 实现 |
| **Cloudflare 挑战页 / 人机验证**（`Just a moment...`、Turnstile、`/cdn-cgi/challenge-platform/`） | `captcha/SKILL.md` | `captcha/scripts/cf-wait.mjs` |
| **任何站点：页面异常 / 结构陌生 / 交付前验证** | `debug/SKILL.md` | 内置 `page.inspect` / `page.record` RPC；兜底 `browser-debug.mjs` |
| **在 Firefox 里操作**（`BRIDGE_BROWSER=firefox`、`BIDI_UNAVAILABLE`、`CDP_UNSUPPORTED`） | `firefox/SKILL.md` | 同上全部脚本（设 `BRIDGE_BROWSER=firefox`） |

### 2. 开工体检：`scripts/preflight.mjs`

```bash
node <skill 目录>/scripts/preflight.mjs                 # 人类可读体检：版本、通道、可用标签页
node <skill 目录>/scripts/preflight.mjs --json          # 机器可读
TAB=$(node <skill 目录>/scripts/preflight.mjs --pick github)  # 直接拿匹配的可用 tabId（无匹配退出码 3）
```

- 版本低于 `scripts/lib/bridge.mjs` 要求的最低版本时报 `BRIDGE_TOO_OLD`，按 `INSTALL.md` 更新。
- 若从未安装过（无 `~/.chrome-agent-bridge/token`）：读 `INSTALL.md`，向用户说明并获同意后再安装。
- 登录由用户主导：目标页需要登录 / 扫码 / 验证码 / 2FA 时，必须先告知用户并等待其手动完成，禁止代登录或绕过验证。

### 3. 多步流程用 `scripts/lib/bridge.mjs`

只依赖 Node 内置模块。内置：返回值解包、坏 tab 连续 3 次上下文错误熔断（`TAB_UNHEALTHY`）、进程退出自动释放 CDP 会话与 Tab 租约、用户点「停止 Agent」（`AGENT_STOPPED`）以退出码 3 终止。

```js
import { Rpc } from "<skill 目录>/scripts/lib/bridge.mjs";
const rpc = new Rpc({ agentName: "MyTask" });
await rpc.preflight();

// 读网页：自动打开/复用后台 tab、处理后台未渲染、提取正文与链接、关闭本次新建的 tab
const page = await rpc.readPage("https://example.com/pricing");
if (page.blocker) throw new Error(`页面受阻: ${JSON.stringify(page.blocker)}`);

// 多步交互：选 tab + 等就绪 + 验可注入；结束自动关掉本次新建的 tab
await rpc.withPage("https://example.com/", async (tabId) => {
  const snap = await rpc.snapshotCompact(tabId);          // "[e1] textbox \"搜索\"\n[e2] button \"搜索\"" 形式
  const t = await rpc.typeReal(tabId, "@e1", "hello");    // CDP 受控输入，t.verified 为回读结果
  if (!t.verified) throw new Error(`输入未生效: ${t.value}`);
  const c = await rpc.clickReal(tabId, "@e2");            // 真实鼠标点击；后台 tab 自动临时激活
  console.log(c.delta);                                   // { urlChanged, modalOpened, mutationCount, ... }
  const title = await rpc.ev(tabId, "document.title");    // CDP 求值，不受页面 CSP 限制
});
```

### 4. 后台标签页的两条规则

`tabs.resolve` / `page.read` 默认在后台标签页工作，不抢用户前台。后台标签页有两个限制：

1. **渲染暂停**：rAF 为 0，懒加载 / 瀑布流不推进，表现为「页面打开了但列表是空的」。滚动加载用 `rpc.scrollLoad()`（或 `page.scroll {checked:true}` 收到 `recoverable:true` 后 `page.ensureActive`）。
2. **不处理 CDP 鼠标与按键事件（仅 Chrome；Firefox 经 BiDi 派发不受影响）**：`page.clickReal` 与带 `pressEnter` 的 `page.typeReal` 报 `TAB_HIDDEN`。`rpc.clickReal` / `rpc.typeReal` 与 MCP 工具会自动 `ensureActive` 后重试；裸 RPC 调用方需自己处理。

`page.ensureActive` 只切标签页、不聚焦窗口，空闲 20s 后自动把活动页还给用户。

---

## 核心工作原则与四条安全红线

### 第一原则：优先复用 → 临场应变 → 持续沉淀

1. **优先复用**：命中子技能索引时先跑现成 `scripts/*.mjs`（内置限速抖动、单 tab 复用、验证码退出、静默注入）；新流程基于 `scripts/lib/bridge.mjs` 构建，优先调命令行参数适配。
2. **随机应变**：遇到未收录站点、页面改版选择器失效或弹窗遮挡时，先调 `page.inspect`（`overview` / `links` / `scroll` / `modal` / `sel`）探查实时 DOM：
   - `page.evaluate` 报 CSP 错误 → 切 `page.evalCdp`（`rpc.ev()` / `bb eval` / MCP `browser_eval` 都走它）；
   - 点击无反应 → 先看返回的 `delta`（`mutationCount: 0` 且 `urlChanged: false` 即没生效），再在 `page.clickReal`（CDP 真实鼠标）与 `page.click` / `rpc.clickEl`（DOM 原生 `.click()`）间切换；
   - 后台标签页列表为空或 `SCROLL_NO_GROWTH`（`recoverable: true`）→ 调 `page.ensureActive` 或用 `rpc.scrollLoad`；
   - `overview.blocker` 为 `dismissible_modal`（提示型软弹窗）→ 点掉关闭按钮继续；为 `captcha` / `cloudflare` / `login_wall` → 按对应规约停手交用户。
3. **持续沉淀**：跑通新解法后回写对应 `scripts/*.mjs`、`<子技能>/SKILL.md` 或 `KNOWN_ISSUES.md`，并清理一次性临时探查脚本。

### 四条红线（所有站点必须遵守）

1. **拿到网址读内容默认走本技能，禁止先 `curl`**：现代 SPA/React/Vue 的 HTML 是空壳（HTTP 200 但 `body` 可见文本为 0）。除非目标是明确返回 JSON/XML/纯文本的接口或静态源码文件，凡是网页一律直接用 `page.read` 或 `withPage`。
2. **变更类操作必须回读验证**：删除 / 保存 / 提交 / 发布后，不仅看交互返回的 `delta`，还必须重新加载列表或详情页确认业务状态真变了（可用 `rpc.mutateAndVerify(mutate, verify)`：变更只执行一次，之后轮询回读直到确认或超时）。
3. **遇到硬风控 / 验证码立即停止，禁止重试**：出现验证码、滑块或连续 404 时立即停止该站点后续请求，告知用户处理（小红书 `.reds-alert`「我知道了」软弹窗除外，用 `scripts/xhs-dismiss-softblock.mjs` 点掉）。
4. **默认静默运行、少开标签页、收到 `AGENT_STOPPED` 立即停手**：
   - 打开网址用 `tabs.resolve`（不抢用户正在看的活动标签页），优先在单 tab 内跳转，自己新建的 tab 用完必关；
   - 用户按下页面上的「停止 Agent」后，所有写操作返回 `AGENT_STOPPED`，必须立即停止一切写操作并向用户汇报进度，禁止自动 `agent.resume` 后重试。

---

## 详细参考

- `reference/core.md`：`page.read`、快照与元素编号、原子 CDP 操作（`clickReal` / `typeReal` / `evalCdp` / `uploadFile`）、交互 delta、`tabs.resolve`、渲染保障与滚动检测、`page.inspect` 阻断诊断、`page.record`、`bridge.recentErrors`、`session.*` 的参数、返回结构与示例。
- `reference/rpc.md`：全部 RPC 方法与参数索引（与 `bridge.methods` 同源）。
- `KNOWN_ISSUES.md`：错误码速查与行为约束。
- `CHANGELOG.md`：各版本新增能力与「版本不匹配的典型症状」。

---

## 安全与隐私

- 本地桥仅监听 `127.0.0.1`，强制要求长度 ≥ 16 的随机 Bearer token（`~/.chrome-agent-bridge/token`，`0600` 权限；读取失败 fail-closed 拒绝启动）。
- 快照与增量状态对 `password`、`hidden`、信用卡及验证码输入值自动脱敏为 `[value redacted]`。
- 使用痕迹：操作中的页面标题会加上 `● [<agentName>] 接管中 |` 前缀，`<html>` 下有指示器节点（`#agent-bridge-*`），页面脚本都能读到。Firefox 另有整个浏览器生效的痕迹（地址栏远程控制样式、`navigator.webdriver === true`），见 `firefox/SKILL.md`「使用痕迹」。
- 执行投递、发消息、修改公开档案、下单等对外或不可逆动作前，必须先经用户确认（或先跑 `--dry-run`）。
