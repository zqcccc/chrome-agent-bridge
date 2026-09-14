---
name: agent-browser-bridge
description: 驱动用户的真实 Chrome 浏览器（本地扩展 + 本地桥）完成任务——**用户在浏览器上能做的任何事，本 skill 基本都能做**：网上查资料/搜信息、打开网页读取/查证内容、站内搜索并整理结果、抓取动态渲染或登录后页面的数据、点击/输入/滚动/截图/执行 JS/下载文件，以及登录后业务操作（填表提交、发消息、投递简历、下单、预订、管理后台操作）。最大优势：走真实 Chrome 环境与真实登录态，能进入普通自动化工具被反爬/风控拦截的页面（验证码、登录墙、无头浏览器指纹检测、滑块等），拿到登录后或动态渲染的内容——普通搜索工具拿不到的（小红书、BOSS 直聘、公众号后台、网银、论坛、需账号的站内搜索等）都从这里走。触发词：搜索、查找、检索、查询、查证、搜一下、抓取、爬数据、收集信息、调研口碑、避坑、打开某网页、读取网页内容、操作浏览器、在 Chrome 里点击/输入/滚动/截图、填表、提交、发消息、投递、下单、预订、下载、小红书、BOSS 直聘、NotebookLM、ChatGPT 网页版、登录后页面。执行规则：小红书/BOSS/ChatGPT/NotebookLM 等已有专项子技能，必须先读对应子技能 SKILL.md 并优先跑其 scripts/ 下现成脚本（自带风控防护），禁止自己从零写抓取脚本；缺功能时以现有脚本为模板改写并注明来源。登录约束：页面需要登录/授权/扫码/验证码时，必须先告知用户要访问的页面和原因，等待用户手动完成登录后再继续，不得替用户登录或绕过验证。若任务不需要真实登录态、通用搜索/抓取工具即可完成，优先用通用工具。
---

# Agent Browser Bridge —— 让 Agent 操作日常 Chrome

架构：Chrome 扩展（MV3）↔ 本地桥 host（relay/host.js，:8778）↔ Agent 客户端（HTTP/WS JSON-RPC）。

```
你的 Chrome（真实登录态）──native messaging / ws──▶ 本地桥 host(:8778) ◀──HTTP POST /rpc── Agent
```

## 这个 skill 是干什么的（核心定位）

**一句话：用户在浏览器上能做的任何事，本 skill 基本都能做。** 它驱动的是用户日常在用的真实 Chrome——真实登录态、真实指纹、真实环境，不是无头模拟器或远程浏览器。普通工具做不了的事（过风控、进登录墙、拿动态内容）正是它的主场。

| 任务类型 | 例子 |
|---|---|
| 查资料 / 查证 | 打开某网页读取内容、站内搜索并整理结果、核实某个说法、比较商品与价格 |
| 抓取数据 | 动态渲染页面、登录后才能看到的内容、普通搜索工具拿不到的站（小红书、BOSS 直聘、公众号后台、网银、论坛等） |
| 操作页面 | 点击、输入、滚动、截图、执行 JS、下载文件、查看媒体 |
| 登录后业务操作 | 填表提交、发消息、投递简历、下单、预订、管理后台操作 |

**什么时候不用它**：任务不需要真实登录态、通用搜索/抓取工具就能拿到结果时，优先用通用工具（更快、更省、不打扰用户的浏览器）。

## 第一原则：先查子技能，用现成脚本（禁止重造）

**这是本 skill 的硬性执行规则，优先级高于「快速开始」里的任何命令。**

这些站点的风控是按行为特征判定的（请求频率、并发标签数、滚动节奏、DOM 遍历方式）。子技能里的 `scripts/*.mjs` 是踩过坑以后调出来的参数：内置限速与随机抖动、并发 tab 控制、验证码/404/「Security Verification」自动拦截退出、`tabs.prepare` 静默注入、受控组件的正确 setter、以及该站专属的坑（如 BOSS 的 PUA 薪资字体、chatgpt.com 的 CSP 禁止 `page.evaluate`）。**自己临时写的裸脚本没有这些防护，几轮就会把账号/会话打到风控里，而且报错信息往往看不出是被风控还是脚本 bug。**

### 执行流程（命中站点时必须照做）

1. **先查子技能索引**（下表）。任务站点/目标命中任一行 → **先读取对应子技能的 `SKILL.md`**，再动浏览器。
2. **优先直接跑它给的脚本**：子技能的 `scripts/*.mjs` 自包含（不依赖 CLI / 不依赖 cwd），按文档给的命令行直接跑，不要退化成自己拼 HTTP / 自己写 `page.evaluate`。
3. **脚本不完全贴合时，先改参数，再改脚本**：绝大多数情况改 `--max-scrolls` / `--max-results` / `--channel` / `--filter` / 选择器就够了。
4. **确实没有的功能才自己写**，且必须满足三点：
   - 以同类子技能脚本为**模板复制改写**（继承它的限速、拦截检测、静默 prepare、单 tab 内操作）；
   - 沿用它的 RPC 调用方式与等待策略，不要回退成固定 `sleep`；
   - 在交付说明里注明「子技能 X 未覆盖 Y，故基于 `scripts/Z.mjs` 改写」。
5. **任何站点行为异常（取不到内容、数量不对、404、疑似风控）** → 读 `debug/SKILL.md`，先 `page.inspect` 探查再下结论，不要凭猜重试。

### 子技能索引（命中即必须加载）

| 站点 / 目标 | 子技能 | 现成脚本（`<skill 目录>/scripts/`） |
| --- | --- | --- |
| **小红书 xiaohongshu.com**（搜笔记、抓笔记正文、**全量评论含楼中楼二级回复**、搜用户、用户主页笔记、点点 AI 问答） | `xhs/SKILL.md` | `extract-xhs-comments.mjs`、`xhs-search-inpage.mjs`、`xhs-note-full.mjs`、`xhs-search-user.mjs`、`xhs-user-notes.mjs`、`xhs-ask-diandian.mjs` |
| **BOSS 直聘 zhipin.com**（搜职位、筛选、读 JD、打招呼投递） | `boss/SKILL.md` | `boss-send-chat.mjs`、`boss-batch-apply.mjs`、`boss-verify-helpers.mjs` |
| **ChatGPT chatgpt.com**（网页端提问、读回复、选模型、生图） | `chatgpt/SKILL.md` | `chatgpt-ask.mjs`、`cdp-eval.mjs`（**该站 CSP 严格，`page.evaluate` 不可用，一律走 CDP**） |
| **NotebookLM**（新建笔记本、上传来源、提问、Studio 产物） | `notebooklm/SKILL.md` | `notebooklm/upload.mjs`、`notebooklm/ask.mjs`、`notebooklm/scripts/*.mjs`、`scripts/cdp-upload.mjs` |
| **任何站点：页面异常 / 结构陌生 / 交付前验证** | `debug/SKILL.md` | `browser-debug.mjs`（首选仍是插件内置 `page.inspect` / `page.record`） |

> 通用能力也可复用：`scripts/cdp-eval.mjs`（强 CSP 站点求值）、`scripts/cdp-upload.mjs`（注入文件上传）、`scripts/type-text.mjs`（受控组件输入）。

## 路径约定（读本 skill 任何命令前先看这里）

本 skill 在仓库里位于 `skills/<本目录名>/`。**所有路径都相对本 skill 目录给出**，这样 clone 到任何机器、放到任何目录都成立；**不要在文档里写死某台机器的绝对路径，也不要用 `find ~` 之类全盘搜索去定位本 skill 或 CLI**——位置是可推导的，不需要搜。

| 记号 | 含义 | 解析方式 |
| --- | --- | --- |
| `<skill 目录>` | 本 skill 目录（`SKILL.md` 所在目录） | 由读取者自行替换；若是 symlink 请用解析后的真实路径 |
| `<仓库根>` / `$ROOT` | 仓库根 = `<skill 目录>/../..` | `ROOT="$(cd -P <skill 目录> && pwd)/../.."`（`-P` 解引用 symlink，不能省） |
| `<cli>` | 主 CLI `agent/cli.mjs` 的绝对路径 | `"$ROOT/agent/cli.mjs"` |
| `scripts/xxx.mjs` | 本 skill 目录内的开箱脚本 | `<skill 目录>/scripts/xxx.mjs`，**不依赖 CLI** |

说明：
- 主 CLI 与子 skill 脚本是两套东西：子 skill 的 `scripts/*.mjs` 自包含、不依赖 `agent/cli.mjs`，**能直接用就用（强制首选）**，不要退化成裸 HTTP / 裸 `page.evaluate` 重造——见上方「第一原则：先查子技能，用现成脚本（禁止重造）」。
- `<cli>` 是纯 HTTP 客户端，**不依赖 cwd**，给绝对路径即可，无需 `cd` 到仓库根。
- 子 skill 文档（「专项实战」列出的各 `*/SKILL.md`）沿用本表记号。

**什么时候必须用它（从 agent-browser 降级）**：主流 UGC 站点（小红书、知乎、大众点评、脉脉、淘宝、京东、Reddit 等）有严格反爬（验证码滑块、强制扫码登录、封禁无头指纹）。**一旦 `agent-browser` 打不开、被拦截、跳转登录页或内容被折叠截断，立即无缝切到本 skill**，借真实 Chrome 环境继续；不要在原工具上重试加码。前置检查在本文件「前置条件」一节。

## 前置条件（每个任务开始前必须检查）

先按「第一原则」的子技能索引确认是否命中专项（命中则先读子技能、优先跑脚本），再检查下面这些。

0. **登录由用户主导**：目标页面需要登录/授权/扫码/验证码时，必须先向用户说明要访问哪个页面、为什么需要登录，然后等待用户手动完成登录、确认登录成功后再继续。禁止替用户登录、绕过登录墙或静默跳过验证。用户未登录前不要继续执行后续步骤。
1. **扩展已加载**：chrome://extensions 里有 "Agent Browser Bridge"（已解压；ID 以你本机 `chrome://extensions` 中显示的为准），开关为 On。
2. **host 存活**：`curl -s http://127.0.0.1:8778/status` 返回 `{"ok":true,...}`。
   - **推荐 Native 模式**：不要手动 `npm start`。注册 native host 后，Chrome 按需拉起 host 进程，该进程监听 8778，Agent 连 8778 即同一进程。Chrome 关闭时进程自动退出。`status` 返回 `mode:native`。
   - **standalone WS 模式（二选一）**：`cd "$ROOT/relay" && npm start`（`$ROOT` 见下方「快速开始」）,host 常驻 8778，扩展用 `ws://127.0.0.1:8778/agent` 连入。`status` 返回 `mode:standalone`。
   - **两种模式不要同时运行**：standalone 占着 8778 时，native 拉起的进程会因端口占用退出，扩展 `auto` 通道会回退到 WS（不透明）。推荐只用 Native。
3. **扩展已连上 host**：status 输出 `extConnected:true`。扩展 reload 或 Chrome 重启后几秒内自动重连。

## 快速开始（CLI）

> ⚠️ **先回头看「第一原则」的子技能索引**：小红书 / BOSS 直聘 / ChatGPT / NotebookLM 有专项子技能与现成脚本，**命中就先跑脚本，不要从这里开始手写裸 RPC / 裸 `page.evaluate` 抓数据**（会触发风控）。通用站点或不涉及数据抓取的单点操作才用下面这些命令。
>
> **CLI 就在本 skill 目录旁的仓库里（`<仓库根>/agent/cli.mjs`），用上表「路径约定」的 `$ROOT` 直接引用，不要去文件系统里搜索它。**
>
> ```bash
> ROOT="$(cd -P <skill 目录> && pwd)/../.."   # 仓库根 = skill 目录的上两级
> node "$ROOT/agent/cli.mjs" status
> ```
>
> 命令：`status / tabs / active / open / snap / shot / eval / click / type / press / scroll / cursor / listen`（跑 `node "$ROOT/agent/cli.mjs"` 无参数可打印这份列表）。
> 它只是 HTTP 客户端，**不依赖 cwd**，给绝对路径即可，无需 `cd` 到仓库根。
>
> 自包含的等价调用（RPC / HTTP）见下方「编程调用」与「HTTP 直调」——任何环境都能用，不依赖 CLI 的存在。

```bash
export BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token)   # 每次 shell 都要
ROOT="$(cd -P <skill 目录> && pwd)/../.."                # 仓库根 = skill 目录的上两级
CLI="$ROOT/agent/cli.mjs"                                # 下文的 <cli>

node "$CLI" status              # host 状态 + 扩展连接
node "$CLI" tabs                # 列出所有标签页（拿 tabId，用户操作会变，用前必查）
node "$CLI" open <url>          # ⚠️ 慎用：新标签页打开。优先在现有 tab 内 page.navigate；确需新开时用完立即 tabs.close
node "$CLI" eval <tabId> "<js>" # 在页面执行 JS（同步求值）
node "$CLI" wait <tabId> ready|url|selector <match|选择器> [timeoutMs]  # 增强等待（v0.3.3+，取代固定 sleep）
node "$CLI" click <tabId> <css选择器>
node "$CLI" type <tabId> <sel> <text>
node "$CLI" press <tabId> <key>
node "$CLI" scroll <tabId> <sel> <dir>
node "$CLI" snap <tabId>        # 页面快照（a11y 树+元素清单）
node "$CLI" shot <tabId>        # 页面截图（保存当前目录）
node "$CLI" inspect <tabId> [overview|links|media|scroll|modal|sel:<css>]  # 内置页面探查
node "$CLI" record <tabId> start|stop|status|get|clear [types:nav,modal,err,dom,console]  # 会话记录时间线
node "$CLI" listen              # 订阅页面事件
```

## 编程调用（推荐用于多步流程）

```js
import { Bridge } from "./agent/client.mjs";   // 或直接 HTTP
const bridge = new Bridge({
  port: 8778,
  token: process.env.BRIDGE_TOKEN,
  agentId: process.env.AGENT_ID || `agent-${process.pid}`,
});
await bridge.register();
const tabs = await bridge.list();
// 多 Agent 协作时，操作前先取得 Tab 租约
await bridge.claimTab(tabs[0].id, 120000);
await bridge.rpc("page.waitForReady", { tabId, timeoutMs: 30000 });   // 等 readyState（v0.3.3+）
await bridge.rpc("page.waitForUrl", { tabId, match: "search_result", timeoutMs: 15000 });
await bridge.rpc("page.waitForSelector", { tabId, selector: ".card", timeoutMs: 30000 });
await bridge.rpc("tabs.prepare", { tabId });  // 静默准备：注入 content script + 防后台冻结，不切激活 tab / 不聚焦窗口（v0.3.0+）
await bridge.rpc("tabs.list");
await bridge.rpc("page.navigate", { tabId, url });
await bridge.rpc("page.evaluate", { tabId, expression: "..." , awaitPromise: false });
await bridge.rpc("page.click", { tabId, selector: "..." });
await bridge.rpc("page.type", { tabId, selector: "...", text: "..." });
// 内置页面探查（不需要写 JS！遇到页面异常/陌生结构/交付前验证时先调这个）
await bridge.rpc("page.inspect", { tabId, focus: "overview" });            // 页面概览
await bridge.rpc("page.inspect", { tabId, focus: "links", limit: 6 });     // 列表卡片链接+可见性（防点隐藏链接）
await bridge.rpc("page.inspect", { tabId, focus: "media" });               // 图片/视频/live/blob
await bridge.rpc("page.inspect", { tabId, focus: "scroll" });              // 可滚动容器
await bridge.rpc("page.inspect", { tabId, focus: "modal" });               // 弹窗详情
await bridge.rpc("page.inspect", { tabId, focus: "sel", selector: ".foo" }); // 任意选择器 dump
// 会话记录（Clarity 式变化时间线）：先 start，页面变化被记录，事后 get 分析过程
await bridge.rpc("page.record.start", { tabId });        // 开始记录（content 监听 DOM/导航/弹窗/异常文本/console）
await bridge.rpc("page.record.status", { tabId });       // 运行状态 + 各类型事件计数
await bridge.rpc("page.record.get", { tabId, types: ["nav","modal","err","dom","console"], since: 0, limit: 500 }); // 拉时间线
await bridge.rpc("page.record.stop", { tabId });         // 停止记录
await bridge.rpc("page.record.clear", { tabId });        // 清空时间线
```

HTTP 直调：`POST http://127.0.0.1:8778/rpc`，头 `Authorization: Bearer <token>`，体 `{"method":"...","params":{...},"timeoutMs":20000}` → `{"ok":true,"result":{...}}`。注意 **page.evaluate 的返回值在 `result.result` 里是 JSON 字符串**，需要再 JSON.parse 一次。

## 报错排查：先看 host.log，别看 chrome://extensions

排查任何桥相关报错，**第一站是 `~/.chrome-agent-bridge/host.log`**（带时间戳 / method / tabId / 耗时 / 错误码，可统计）：

```bash
cd ~/.chrome-agent-bridge
grep -o "code=[A-Z_]*" host.log | sort | uniq -c | sort -rn                              # 报错码分布
grep "code=UNKNOWN_METHOD" host.log | grep -o "method=[a-zA-Z.]*" | sort | uniq -c | sort -rn
grep "code=TIMEOUT" host.log | grep -o "method=[a-zA-Z.]*" | sort | uniq -c | sort -rn
grep "tab=<id>" host.log | grep -E "TIMEOUT|note=dispatch" | head -20                   # 单 tab 时间线
```

原因：chrome://extensions 的 errors 面板**只留最近若干条、不能滚动**，且混着大量预期失败噪音；它还是 `chrome://` 协议，桥既不能注入也不能截图。

**当前标签页操作报 `PAGE_CONTEXT_TIMEOUT`**（页面上下文失效，如扩展刚重载过、标签页被冻结）时，先 `tabs.prepare` 重新注入，或 `tabs.reload` 刷新页面；该错误是快速失败，不会挂死。

## 实战踩坑清单（务必先读）

1. **host 可能随时死**：开工前、长流程中途，都 `curl /status` 确认；死了就重启，token 不变。
2. **刚 reload 扩展前的旧标签页 content script 不注入**：`page.evaluate` 报 "Cannot access contents of the page"。解决：先 `tabs.prepare`（静默注入，不抢焦点）再操作，见下方「静默模式」。只有**被 OneTab 冻结 / 被浏览器丢弃（discarded）的标签**才必须 `tabs.activate` 唤醒（激活会自动重载页面）。
3. **`chrome://` 等受保护页面**不能注入/截图（需 activeTab 授权，点一次扩展图标即可）。
4. **eval 是同步求值**：表达式里有 `await`/Promise 必须传 `awaitPromise:true`，否则返回空对象。
5. **受控组件（React/Vue）输入**：`el.value=x` 无效。用 native setter + InputEvent：
   ```js
   const setter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText').set; // textarea 用 'value'
   setter.call(el, text);
   el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text}));
   ```
   输完检查发送/提交按钮是否从 disabled 变 enabled，再点它。
6. **截图的静默策略**：`page.screenshot` 默认走 CDP（后台 tab 也可用，不抢焦点）。CDP 失败时**默认不再自动激活窗口**，返回 `SCREENSHOT_FAILED`；若可接受浏览器跳到前台，用 `page.activateAndShot` 或传 `allowActivate:true`。确实需要用户观看/系统级截图时再显式激活。
7. **激活/准备后 tabId 不变**，但用户手动开/关标签会变——多步流程每步都重新 `tabs` 确认。
8. **导航等待**：导航必须用 `page.navigate`（走 `chrome.tabs.update`），**禁止用 `page.evaluate` 改 `location.href`/`location.assign`/`history.go`**——后者会销毁执行上下文，导致 RPC 无法返回、Host 超时。`page.navigate` 后可调 `page.waitForUrl`/`page.waitForSelector`/`page.waitForReady` 按条件等待，不要用固定 sleep。
9. **视觉指示器**：Agent 操作时页面会显示幽灵光标 + 点击涟漪 + 「停止 Agent」按钮（默认开启）。用户可随时点停止打断。
10. **停止按钮实现**：background 的 dispatch() 只对真实交互操作（click/type/press/scroll/hover/focusEl/select/waitFor）显示停止按钮；只读/导航（navigate/info/evaluate/snapshot/waitLoad/waitForUrl/waitForSelector/waitForReady）不被 indicator 阻塞，indicator 失败也不影响主 RPC。如需默认关闭改 background.js 的 INTERACTIVE_METHODS。

## 静默模式（后台操作不抢焦点，扩展 v0.3.0+）

默认情况下，桥的读/写/点击/截图都**不会**把浏览器窗口拉到前台、也不会切换激活 tab——用户在用别的应用时不会被抢焦点。需要用户眼睛的步骤（登录、验证码、扫码、选文件、最终核对）才由 Agent 显式 `tabs.activate` / `page.focus` / `page.activateAndShot`。

### 操作前准备：`tabs.prepare`

保证 content script 已注入 + 目标 tab 不被浏览器后台冻结/回收（`autoDiscardable:false`）；**不切激活 tab、不聚焦窗口**。多步流程第一步用它代替 `tabs.activate`。

- 调用：`POST /rpc`，体 `{"method":"tabs.prepare","params":{"tabId":<id>},"timeoutMs":15000}`
- 参数：

  | 参数 | 类型 | 必填 | 说明 |
  |---|---|---|---|
  | tabId | number | 是 | 目标标签页 ID |

- 返回：`{"ok":true,"tabId":<id>}`
- 失败：`UNSUPPORTED_URL`（chrome:// 等不可注入页）/ `TAB_GONE` / `TAB_DISCARDED`（tab 已被 OneTab/浏览器冻结丢弃，静默无法唤醒，改用 `tabs.activate`）/ `PAGE_CONTEXT_TIMEOUT`（注入失败）
- 提示：`tabs.list` / `tabs.get` 返回的 tab 带 `discarded` 字段，选目标 tab 时先避开 `discarded:true` 的（或预判需要 `tabs.activate`）。
- 最小可用示例：

  ```js
  await b.rpc("tabs.prepare", { tabId }, 15000);   // 静默准备，全程不抢焦点
  await b.rpc("page.evaluate", { tabId, expression: "location.href" }); // 后台 tab 直接可用
  ```

- **版本要求**：扩展 v0.3.0+。旧版（返回 `UNKNOWN_METHOD`）兜底：直接跳下一步——`page.*` 内容调用内部自带 `ensureInjected`，会自动注入 content script，唯一损失是「防后台冻结」不生效；被 OneTab / 浏览器丢弃冻结的 tab 仍需 `tabs.activate`。

### 何时仍要显式激活

| 场景 | 用什么 |
|---|---|
| 登录 / 扫码 / 验证码 / 2FA / 选文件 | `tabs.activate`（或 `page.focus`），并告知用户 |
| 最终给用户核对的可视化结果 | `page.activateAndShot` |
| 被 OneTab / 浏览器丢弃冻结的 tab | `tabs.activate`（激活即唤醒重载） |
| 后台 tab 定时器被节流、页面"不反应" | 放宽等待仍不行再 `tabs.activate` |

### 截图行为变化（v0.3.0+）

`page.screenshot` 默认 CDP 静默截图（后台 tab 可用）；CDP 失败时**不再偷偷激活窗口**，报 `SCREENSHOT_FAILED`。显式传 `allowActivate:true` 或改用 `page.activateAndShot` 才会降级到 `captureVisibleTab`（该路径要求目标 tab 是窗口内激活 tab）。

### 后台节流注意

Chrome 会把后台 tab 的定时器压到 1 秒级、长闲后可能冻结：依赖 rAF/轮询渲染的页面（瀑布流、懒加载）可能看似无响应。处理：`page.waitForSelector` / `page.waitForUrl` 超时放宽到 30s+；仍无响应再 `tabs.activate`。

## 错误码（可诊断）

桥接层返回结构化错误，包含 code/method/tabId/channel/elapsedMs：

- `TIMEOUT` / `EXT_DISCONNECTED` / `SEND_FAILED`：扩展通道层。超时后会返回 method、tabId、channel、耗时，日志不含 token 与页面内容。
- `TAB_BUSY`：同 tab 请求串行队列中前序请求占用（一般等待而非报错；若恢复窗口内，短时间等待后重试）。
- `NAV_TIMEOUT`：导航/等待 URL/ready/selector 超时。
- `PAGE_CONTEXT_TIMEOUT`：页面上下文已销毁/无法注入 content script（导航中、chrome://、上下文崩溃）。
- `CONTENT_TIMEOUT`：content 调用（click/type 等）超时。
- `EXT_DISCONNECTED` 在扩展 WS/Native 断连时让所有 pending 请求确定结局，不无限挂起。
- `TAB_LEASED`：Tab 已被其他 Agent 占用。

HTTP 直调建议携带 `X-Agent-Id` 和 `X-Agent-Name`；WebSocket 订阅使用 `/bridge?...&agentId=<id>&name=<name>`。

## 多 Agent 并行、Tab 租约与身份标识

多个 Agent 可以共用一个 host。每个 Agent 必须使用唯一 `AGENT_ID`，不同 Tab 可以并行；操作某个 Tab 前建议先申请租约：

```bash
export AGENT_ID="boss-agent-1"
export AGENT_NAME="BOSS 投递"
```

```js
const bridge = new Bridge({
  agentId: process.env.AGENT_ID || `agent-${process.pid}`,
  agentName: process.env.AGENT_NAME || "豆包",
});
await bridge.register();
await bridge.claimTab(tabId, 120000);
// ...完成流程后释放
await bridge.releaseTab(tabId);
```

### 页面接管身份识别（支持同名 Agent 区分）
当 Agent 接管页面时，页面右上角胶囊条、Chrome 标签页标题及扩展徽标会实时显示具体接管的 Agent 身份：
- **同名 Agent 自动区分**：若多个 Agent 名字相同（例如都叫「豆包」或都叫「小红书采集」），系统会自动解析其实例短 ID 进行区分展示（例如显示为 `● [豆包 #101] 接管中` 与 `● [豆包 #102] 接管中`，右上角角标为 `接管: 豆包 #101`）；
- 底部停止按钮同步展示专属停止文案（例如 `停止 [豆包 #101]`）；
- 操作完毕空闲 12 秒后自动切换为「已放开: 豆包 #101」并恢复原标题；该「已放开」提示是过场态，展示约 2.6 秒后淡出移除（扩展 v0.3.2+），不会常驻页面右上角。若你的扩展版本较旧导致它一直挂着，到 `chrome://extensions` 刷新扩展即可。

租约默认 120 秒，最长 1 小时；异常退出会自动过期。其他 Agent 访问已占用 Tab 会收到 `TAB_LEASED`，不要绕过租约强行操作。

## 同 tab 串行与跨 tab 并行

- 同一 tab 的 `page.*` / `tabs.get|activate|prepare|close|reload` / `session.*` 请求在 host 端**严格串行**（按 tabId 维护队列），避免 BOSS 重型 SPA 下 navigate/snapshot/evaluate 互相堆积导致超时。
- 跨 tab 请求并行。
- 单个请求超时不会让同 tab 后续所有请求雪崩：超时后该 tab 进入短恢复窗口（约 500ms），后续请求重试而非级联失败。

## 增强等待 API（BOSS SPA，不依赖固定 sleep）

- `page.waitForUrl` `{ tabId, match?/equals?, timeoutMs?, intervalMs? }`：等 URL 变化。
- `page.waitForReady` `{ tabId, timeoutMs? }`：等 `document.readyState` 为 complete。
- `page.waitForSelector` `{ tabId, selector, by?, timeoutMs?, intervalMs? }`：等选择器出现。
- `page.waitLoad` `{ tabId, timeoutMs? }`：等加载完成（webNavigation + 轮询兑底）。

## CDP 直通：`session.send`（未封装的底层能力都从这里走）

桥暴露了一条通用 CDP 通道，很多只有 DevTools Protocol 才有的能力（设备模拟、精确截图、性能指标、网络拦截等）都用它，不必自己装 Playwright。

```js
await b.rpc("session.attach", { tabId }, 15000);                       // 先挂上
const r = await b.rpc("session.send", {
  tabId,
  method: "Page.captureScreenshot",                                    // 任意 CDP 方法
  params: { format: "png", captureBeyondViewport: true,
            clip: { x: 0, y: scrollY, width: 390, height: 800, scale: 2 } },
}, 30000);
fs.writeFileSync(out, Buffer.from(r.result.data, "base64"));           // 返回在 r.result
await b.rpc("session.detach", { tabId }, 10000).catch(() => {});       // 收工记得卸
```

> 注意 `session.*` 也走同 tab 串行队列；报错时先确认 `session.attach` 成功再 `send`。

### 实用配方：真机尺寸的移动端核查（改页面/查响应式必用）

`page.screenshot` 截的是**浏览器窗口**，不是模拟视口——窗口大、页面窄时，图里只有左边一条有内容。要拿到真机视角必须走 CDP：

```js
await b.rpc("session.send", { tabId, method: "Emulation.setDeviceMetricsOverride",
  params: { width: 390, height: 844, screenWidth: 390, screenHeight: 844,
            deviceScaleFactor: 2, mobile: true } }, 20000);
// 此时 document.documentElement.clientWidth === 390，真实触发 @media
// 再用上面的 Page.captureScreenshot + clip{x:0,y:scrollY,width:390,...} 截图
```

**判定横向溢出（响应式的硬指标）**——别看 `window.innerWidth`，布局视口会因内容超宽被撑大而掩盖问题：

```js
const de = document.documentElement;
const hasHScroll = de.scrollWidth > de.clientWidth;   // 真正的判据
```

定位元凶时要**排除已被横滚容器吸收的子元素**（否则全是假阳性）：向上遍历祖先，若某祖先 `overflow-x` 为 `auto/scroll/hidden` 就跳过该元素。修完在 320/360/390/430/…/1024 各宽度跑一遍，全部 `hasHScroll === false` 才算干净。

**常见元凶**：`<table>` 里的 `th{white-space:nowrap}` / `td{white-space:nowrap}`——列一多，表格最小内容宽度就顶破 `.card`，进而把整个页面撑出横向滚动条。**修法是给表格套一层 `overflow-x:auto` 容器**（不要给 `.card` 加，会把圆角和内边距一起卷进去）。
另附两个高频低级坑：CSS 里写成 `media(...)` 漏掉 `@`（整块规则静默失效，DevTools 都不报错）、写了不存在的属性如 `.dest{cards}`。

## Agent 行为约束（所有任务、所有网站，必须遵守）

1. **遇到风控/安全验证 → 立即停止，禁止疯狂重试**：页面跳转到验证码页（如小红书 `website-login/captcha` /「Security Verification」）、滑块验证、人机校验，或大量 404 /「页面不见了」时，**立即停止该站点的所有后续请求**。不要换参数重试、不要加大滚动轮数、不要重新批量打开页面、不要换个 tab 再试。停下来向用户说明，等待用户手动完成验证或风控解除后再继续。疯狂重试会加重风控，导致账号/会话被更长时间限制。桥本身（host/扩展）几乎从不是这类问题的原因：先 `/status` 确认 `extConnected:true`，桥正常则归因于站点侧风控。
   - **例外：小红书「`.reds-alert` 软风控弹窗」不算入本条**（2026-09-14 补充）。这类弹窗（`操作太频繁，请稍后再试` / `网络异常点此重试` / `系统繁忙` / `广告屏蔽插件提示` 等）只有「我知道了」按钮，点一下就过，**不是**需要人验的硬风控。识别与一键关掉工具：`xhs/scripts/xhs-dismiss-softblock.mjs`（软风控退出码 0；硬风控退出码 2 才停下来等用户）。详见 `xhs/SKILL.md`「软风控弹窗一键处理」与 `KNOWN_ISSUES.md` 约束一·例外。
2. **优先页面内跳转/点开，少开标签页**：目标站点的内容本身就能在页面内点开（如小红书每个笔记都是可点开的页面内弹窗），**优先在当前 tab 内 `page.navigate` 跳转或直接点开内容，不要为每条内容新开标签页**。确需新开时，用完立即 `tabs.close`。同一任务同时打开的 tab 控制在个位数，确需保留的只有搜索/列表页本身。大量并发 tab = 大量并发请求 = 更容易触发风控，也让快照/截图/tab 管理混乱。

## 专项实战：子技能详解

> **索引与强制使用规则见上文「第一原则：先查子技能，用现成脚本（禁止重造）」——命中站点必须先读子技能再动手。** 本节是各子技能的能力说明。

- **小红书（笔记 + 全部评论深度抓取）** → `xhs/SKILL.md`。含站内搜索/筛选/频道切换、搜用户、用户主页全部笔记、问点点 AI 问答；一键脚本 `scripts/extract-xhs-comments.mjs`（全量滚动 + 递归展开楼中楼二级回复）、`xhs-search-inpage.mjs`、`xhs-note-full.mjs`、`xhs-search-user.mjs`、`xhs-user-notes.mjs`、`xhs-ask-diandian.mjs`。**核心规约：进笔记必须展开全部评论（含二级回复）；脚本内置验证码/404 拦截自动退出。禁止自己写小红书抓取脚本。**
- **ChatGPT 网页版（问答/选模型/生图）** → `chatgpt/SKILL.md`。脚本 `scripts/chatgpt-ask.mjs`（一键提问读回复）、`scripts/cdp-eval.mjs`（CDP 求值）。**注意：chatgpt.com 有严格 CSP，`page.evaluate` 不可用，一切页面内 JS 走 CDP（`cdp-eval.mjs` / `session.send`）。** 前置：用户已在浏览器登录 chatgpt.com。
- **BOSS 直聘（职位搜索/筛选/打招呼投递）** → `boss/SKILL.md`。脚本 `scripts/boss-send-chat.mjs`（单条消息发送 + 送达验证）、`scripts/boss-batch-apply.mjs`（批量投递模板）、`scripts/boss-verify-helpers.mjs`（送达验证纯逻辑模块）。覆盖搜索 URL 与薪资档位、职位卡片提取、薪资字体加密（PUA 码点，用窗口截图 OCR）、按简历画像评分与定制打招呼、3 条消息投递、每日沟通上限与风控停止规则。前置：用户已登录 zhipin.com，发送前须经用户确认。
- **NotebookLM**（新建笔记本、上传来源含视频/音频/图片/PDF、提问取回答、生成下载 Studio 产物）→ `notebooklm/SKILL.md`。脚本 `notebooklm/upload.mjs`、`notebooklm/ask.mjs`、`notebooklm/scripts/nblm-*.mjs`；文件上传走 CDP 注入。注意：网络出口需在开放地区（美国节点可用，香港/中国大陆不可用）。
- **临场 Debug（任何站点通用）** → `debug/SKILL.md`（工具 `scripts/browser-debug.mjs`）。页面行为异常（404/风控误判、取不到内容、数量不对、URL 打不开）、需要理解陌生页面结构、或交付前验证提取结果时读取。**先探查后假设、不猜类名、异常先查 DOM 再下结论、输出独立验证**。

---

## 安全

- host 只监听 127.0.0.1；Agent 调用需 Bearer token（首次启动随机生成，0600 权限）。
- 页面快照自动遮蔽敏感字段（密码、hidden、信用卡、验证码）为 `[value redacted]`。
- 发送消息/提交表单前，涉及不可逆动作（投递、发消息、下单）务必先给用户确认清单。
- 本 skill 位于仓库 `skills/<本目录名>/`，因此**仓库根可用相对路径确定**：`ROOT="$(cd -P <skill 目录> && pwd)/../.."`（`-P` 用于解引用 symlink）。文中所有 `$ROOT/...` 都指仓库根下的路径；`agent/cli.mjs` 是纯 HTTP 客户端、不依赖 cwd，给绝对路径即可运行。Native Messaging host 名 `com.agentbrowser.bridge`。
