---
name: agent-browser-bridge
description: 用真实 Chrome 打开、读取、操作任意网页——**拿到 http(s) 链接要读内容时默认用本技能，不要先试 curl / wget / WebFetch 赌它是静态页**：前端渲染的站点（SPA / React / Vue / 动态加载）用 curl 只能拿到空壳 HTML，正文一个字都没有，而且**不会报错**，会静默给出错误结论。覆盖：读网页正文与价格/文档/列表数据、站内搜索、抓取动态渲染或登录后数据、点击输入滚动截图、执行 JS、下载文件、填表提交发消息投递下单预订、管理后台操作。走用户日常 Chrome 与真实登录态，可进入被反爬 / 风控拦截（验证码、登录墙、无头指纹、滑块）与需登录页面：小红书、知乎、大众点评、BOSS 直聘、公众号后台、网银、论坛等。已有专项子技能（xhs / boss / chatgpt / notebooklm / debug）必须先读其 SKILL.md 并优先跑 scripts/ 下现成脚本，禁止从零写抓取脚本。需要登录 / 授权 / 扫码 / 验证码时，必须先告知用户要访问的页面与原因并等待用户手动完成，不得替用户登录或绕过验证。判断口径：**只要任务是「从某个网址拿到内容」或「在网页上做操作」，就是本技能**，不存在「先用通用工具试、失败再切过来」的降级层。
---

# Agent Browser Bridge —— 让 Agent 操作日常 Chrome

## 开工前必读（三件事，按顺序）

**这三步是硬性前置，跳过它们会重复踩已知的坑。**

### 1. 先读 `KNOWN_ISSUES.md`（同目录）

它记录了**已知问题与行为约束**，很多「看起来像 bug」的现象在那里有现成答案（CSP 拦截、`PAGE_CONTEXT_TIMEOUT`、`DEBUGGER_BUSY`、风控识别等）。**不要凭猜重试。**

### 2. 查版本（判断能力是否可用）

```bash
curl -s http://127.0.0.1:8778/status | python3 -c 'import json,sys;d=json.load(sys.stdin);print("version:",d.get("version"),"| connected:",d.get("extConnected"))'
```

版本号是**统一的**：host 与扩展同属一个发布单元，共用 `extension/manifest.json` 里的版本。直接看 `version` 就行。

- `version` 为 `unknown` 时表示 host 读不到 `extension/manifest.json`（一般只在 skill 被单独拷贝时发生）；此时可调 `bridge.status` 拿扩展自报的版本。
- `UNKNOWN_METHOD` 一律是「版本不够新」，不是站点问题也不是脚本 bug——对照 `CHANGELOG.md` 末尾的症状表。

### 3. 多步流程用 `scripts/lib/bridge.mjs`，不要手写解包

```js
import { Rpc, openUrl, waitReady, sleep } from "./scripts/lib/bridge.mjs";
const rpc = new Rpc({ agentName: "MyTask" });
await rpc.preflight();                       // 版本 + 能力一次拿全

// 推荐入口：选 tab + 等就绪 + 验可注入 + 自动 detach + **自动关掉自己开的 tab**
await rpc.withPage("https://example.com/", async (tabId) => {
  const title = await rpc.ev(tabId, "document.title");   // CDP 求值，绕过 CSP，自动解包
  await rpc.clickReal(tabId, x, y);                      // 真实鼠标事件
  await rpc.clickEl(tabId, "document.querySelector('#x')"); // 某些按钮只认 el.click()
});
// 需要保留页面查看时传 { keepOpen: true }；复用的用户 tab 永不会被关。
```

它解决的正是反复踩的四类坑：**返回值解包层数不一致**、**点击方式二选一**、**异常漏 detach 拖死 host**、**在坏 tab 上盲试**。

**坏 tab 熔断（重要）**：同一个 tab 上连续 3 次「上下文/标签页级」错误（`PAGE_CONTEXT_TIMEOUT` / `TAB_GONE` / `UNSUPPORTED_URL` 等）后，`rpc.ev()` 会直接抛 `TAB_UNHEALTHY` 并**毫秒级失败**，不再每轮白等几十秒。
> 为什么加这个：host.log 实测某个 `status:"loading"` 的 SPA 上，agent 盲试了 **155 次** `PAGE_CONTEXT_TIMEOUT`（evaluate 失败 → prepare 失败 → 再 evaluate），把一个简单任务拖成了事故。
> 看到这个错误就**换 tab**（用 `tabs.resolve` / `rpc.withPage`），不要原地重试。

---

## 开工体检：`scripts/preflight.mjs`（建议每次任务开头跑一次）

一条命令拿到「桥是否可用 + 扩展能力缺不缺 + 哪些 tab 可用」：

```bash
node scripts/preflight.mjs                 # 人类可读
node scripts/preflight.mjs --json          # 机器可读
TAB=$(node scripts/preflight.mjs --pick github)   # 直接拿到可用 tab 的 id
```

它会**明确标出「不要选这些」**的 tab，并给出原因：

| 标记 | 含义 |
|---|---|
| `uninjectable` | `chrome://` 等受保护页，桥无法注入 |
| `discarded` | 已被浏览器丢弃，需 `tabs.activate` 唤醒（会重载页面） |
| `non-http` | 非网页（扩展页、about: 等） |
| `loading` | 长期 `status:"loading"` 的 SPA，注入易失败 |

> **为什么值得跑**：host.log 里 `PAGE_CONTEXT_TIMEOUT` 162 次、`UNSUPPORTED_URL` 53 次、`TAB_GONE` 33 次（近 24h）——绝大部分是「一开始就选错了 tab」，而这些在开工前一次性就能判定。
> `--pick` 匹配不到时会**报错退出（码 3）而不是静默给个不相干的 tab**——给错 tab 比不给更坑。

---

## 本文件之外的必读文档（同目录）

| 文件 | 什么时候读 |
|---|---|
| **`KNOWN_ISSUES.md`** | **开工前必读**。已知问题、行为约束、风控处理规则 |
| `CHANGELOG.md` | 拿到 `UNKNOWN_METHOD`、或要确认某能力的最低版本 |
| `debug/SKILL.md` | 页面行为异常（取不到内容 / 数量不对 / 疑似风控），先探查再下结论 |
| `AGENTS.md`（仓库根） | **只有改 bridge 代码时读**。改扩展/修 bug 的开发流程 |

---

## 三条最容易踩的硬约束（摘要，完整版见 `KNOWN_ISSUES.md`）

1. **变更类操作必须回读验证**。删除/保存/提交之后，重新加载列表页确认状态真的变了。
   > 历史教训：脚本打印了 `✓ 已删除`，回到列表页记录还在——按钮点了，请求没发出去。**不得以脚本自己打印的 ✓ 作为成功依据。**
2. **遇到风控/安全验证立即停止，不要重试**。疯狂重试会加重风控。识别特征与例外（小红书软风控弹窗不算）见 `KNOWN_ISSUES.md` 约束一。
3. **少开标签页**。优先在当前 tab 内跳转/点开，用完关掉。大量并发 tab = 更容易触发风控。

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

**什么时候用它**：凡是要在浏览器里真正操作网页就一律用它，没有例外，也不存在「先用通用工具试、失败再切过来」的降级层。浏览器任务归它一家：读页面、站内搜索、抓动态或登录后数据、点击输入提交、截图下载、执行 JS。

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

> 通用能力也可复用：`scripts/lib/bridge.mjs`（**统一封装：解包 / CDP 求值 / 点击双模式 / 坏 tab 熔断**）、`scripts/preflight.mjs`（开工体检）、`scripts/cdp-eval.mjs`（强 CSP 站点求值）、`scripts/cdp-upload.mjs`（注入文件上传）、`scripts/type-text.mjs`（受控组件输入）。

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

**反爬站点是本 skill 的主场，不是切换来的**：主流 UGC 站点（小红书、知乎、大众点评、脉脉、淘宝、京东、Reddit 等）有严格反爬（验证码滑块、强制扫码登录、封禁无头指纹）。这类站点**从一开始就走本 skill**，不要先用 `agent-browser` 或其它无头工具试一轮——它们会被拦截、跳转登录页或内容被折叠截断，那几轮纯属浪费。前置检查在本文件「前置条件」一节。

### 最常犯的错：拿到网址先 `curl`（务必看这一段）

**症状**：用户给一个链接让你读内容（价格页、文档页、产品页、列表页），你第一反应 `curl -sL <url>`，拿回几 KB 的 HTML，`<body>` 里几乎没文本；于是你去扒 `assets/index-xxxx.js` 里的字符串，或者干脆放弃说「抓不到」。

**这是本 skill 存在的首要原因，也是最典型的浪费。** 现代前端站点（React / Vue / SPA / 任何 `index-*.js` 的构建产物）的 HTML 是**空壳**，正文由 JS 在浏览器里渲染。`curl` 不执行 JS，所以：

- 拿到的是 `<!DOCTYPE html>` + 一堆 `<script>`，`body` 可见文本长度为 **0**；
- **关键陷阱：它不报错**。HTTP 200、内容非空（有 JS），`grep` 也能命中几个词——于是你以为读到了，实际正文一个字都没有，最后给出错误结论。
- 判断信号：HTML 里出现 `index-<hash>.js` / `main-<hash>.js` / `__toCdnUrl` / `vite` / `webpack` 之类的构建产物引用，且可见文本极少 → **立刻改用本 skill，不要再去扒 JS bundle**。

**正确动作**：拿到 http(s) 链接要读内容，**默认走本 skill 打开页面读 DOM**，不要先用 curl/wget/WebFetch 赌它是静态页。一次 `tabs.resolve` + `page.evaluate` 就能拿到渲染后的正文，成本远低于「curl → 发现是空壳 → 扒 JS → 猜」这条路。

```bash
# 一条命令看页面渲染后的正文（CLI，最省事）
node "$CLI" open "https://www.example.com/pricing/"   # 输出 tabId
node "$CLI" eval <tabId> "document.body.innerText"
```

```js
// 编程方式（推荐用于多步流程）
import { Rpc, openUrl, waitReady } from "./scripts/lib/bridge.mjs";
const b = new Rpc({ agentId: "read-page", agentName: "ReadPage" });
const { tabId } = await openUrl(b, "https://www.example.com/pricing/");  // tabs.resolve + 旧版降级
await waitReady(b, tabId);
const text = await b.call("page.evaluate", { tabId, expression: "document.body.innerText" });
console.log(text);
```

> 只有一种情况 curl 是对的：目标是**明确返回 JSON / XML / 纯文本的 API 或静态文件**（如 `api.example.com/v1/items.json`、`.md`、`.csv`、`robots.txt`）。只要目标是**给人看的网页**，就用本 skill。

## 前置条件（每个任务开始前必须检查）

先按「第一原则」的子技能索引确认是否命中专项（命中则先读子技能、优先跑脚本），再检查下面这些。

0. **登录由用户主导**：目标页面需要登录/授权/扫码/验证码时，必须先向用户说明要访问哪个页面、为什么需要登录，然后等待用户手动完成登录、确认登录成功后再继续。禁止替用户登录、绕过登录墙或静默跳过验证。用户未登录前不要继续执行后续步骤。
1. **扩展已加载**：chrome://extensions 里有 "Agent Browser Bridge"（已解压；ID 以你本机 `chrome://extensions` 中显示的为准），开关为 On。
2. **host 存活**：`curl -s http://127.0.0.1:8778/status` 返回 `{"ok":true,...}`。
   - **如果 host 根本起不来**：先看它是不是以 `FATAL code=TOKEN_UNAVAILABLE` 退出了。
     v0.3.11 起 token 读不到时**拒绝启动**（不再静默降级成一个固定密码）。常见成因是
     `~/.chrome-agent-bridge/` 权限不对（曾用 sudo 跑过）或磁盘满。修法：
     `mkdir -p ~/.chrome-agent-bridge && chmod 700 ~/.chrome-agent-bridge && chmod 600 ~/.chrome-agent-bridge/token`；
     或显式提供：`AGENT_BRIDGE_TOKEN=<够长的随机串>`。
     **不要**试图用猜的 token 绕过——桥不会接受弱凭据。
   - **推荐 Native 模式**：不要手动 `npm start`。注册 native host 后，Chrome 按需拉起 host 进程，该进程监听 8778，Agent 连 8778 即同一进程。Chrome 关闭时进程自动退出。`status` 返回 `mode:native`。
   - **standalone WS 模式（二选一）**：`cd "$ROOT/relay" && npm start`（`$ROOT` 见下方「快速开始」）,host 常驻 8778，扩展用 `ws://127.0.0.1:8778/agent` 连入。`status` 返回 `mode:standalone`。
   - **两种模式不要同时运行**：standalone 占着 8778 时，native 拉起的进程会因端口占用退出，扩展 `auto` 通道会回退到 WS（不透明）。推荐只用 Native。
3. **扩展已连上 host**：status 输出 `extConnected:true`。扩展 reload 或 Chrome 重启后几秒内自动重连。
4. **扩展版本够新**：拿 `bridge.status` 的 `result.version` 与 [`CHANGELOG.md`](CHANGELOG.md) 的「当前版本」比对。
   - **扩展不会自动更新**（未上架商店）。**拿到 `UNKNOWN_METHOD` 第一反应就该查版本**——它不是站点问题、也不是脚本 bug，就是扩展版本不够新。症状与最低版本的对照表在 `CHANGELOG.md` 末尾。
   - 版本落后时：向用户说明要更新到哪个版本、为什么（例如「你要用的 `tabs.resolve` 需要 0.3.9，现在是 0.3.8」），**得到同意后再执行** `git pull` + `install-host.sh` + `reload-ext`。不要自己动用户的 Chrome。

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
node "$CLI" open <url>          # 打开网址首选：复用「用户没在看」的同类 tab，没有才静默新开后台 tab（不抢焦点）
node "$CLI" open <url> --new    # 无条件新开（等同 tabs.create）；再加 --active 才切到该 tab
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
const opened = await bridge.open(url);    // 打开网址走这个：复用用户没在看的同类 tab，否则静默新开后台 tab
const tabId = opened.tabId;               // 返回 { tab, tabId, reused, navigated, reason }
// 已有 tab 且目标页就在上面时 reused=true / navigated=false，不要重复 navigate（会整页刷新）
if (!opened.reused || opened.navigated) await bridge.rpc("page.navigate", { tabId, url });
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

HTTP 直调：`POST http://127.0.0.1:8778/rpc`，头 `Authorization: Bearer <token>`，体 `{"method":"...","params":{...},"timeoutMs":20000}` → `{"ok":true,"result":{...}}`。

> ⚠️ **返回值解包层数随调用路径变化**，这是最容易踩的坑（实测三条路径三个层数）：
>
> | 调用路径 | 取值位置 |
> |---|---|
> | 裸 HTTP `POST /rpc` | `json.result.result.value` |
> | `client.mjs` 的 `bridge.rpc()` | `r.result.value` |
> | `client.mjs` 的 `bridge.evaluate()` | 返回 `{type, value}`，还要 `.value` |
>
> **别自己写解包。** 用 `scripts/lib/bridge.mjs` 的 `rpc.ev()` / `unwrap()`——它自适应三种层数并自动 `JSON.parse` 字符串结果。
> 历史教训：按错层数取到 `undefined`，连查三轮才发现不是页面问题。

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

> 下面第 11~16 条是**代价最高的六个坑**（都真实卡住过整个流程），优先看。完整已知问题见 `KNOWN_ISSUES.md`。

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
11. **返回值解包层数不一致** → 用 `scripts/lib/bridge.mjs` 的 `ev()`/`unwrap()`，别手写。详见「编程调用」一节的表格。
12. **`el.click()` 与真实鼠标事件不等价，同一流程可能两种都要用**：
    - 菜单/展开类、部分 React 按钮：需要 CDP 真实鼠标事件（`rpc.clickReal`）。
    - 另一些按钮（如 LinkedIn「删除项目」）：CDP 点了毫无反应，**只认 `el.click()`**（`rpc.clickEl`）。
    - 两者都试过再下结论；点完必须回读验证（见第 14 条）。
13. **同名按钮必须限定作用域**：表单底部和确认弹窗里可能都有「删除」。不要用 `[...buttons].filter(t==='删除').pop()` 靠顺序猜——要用 `closest('dialog')` + 弹窗文本特征（如 `/确定要删除/`）双重限定。
14. **变更类操作必须回读验证**：删除/保存/提交之后，**重新加载列表页**确认状态真的变了。
    > 历史教训：脚本打印 `✓ done`，回列表页记录还在——按钮点了，请求根本没发。**不得以脚本自己打印的 ✓ 作为成功依据。**
15. **`session.attach`/`detach` 会打断 CDP 点击序列**：`mousePressed` 与 `mouseReleased` 之间插入 detach/attach 会让点击静默失效（页面无变化且不报错）。一次点击的 down/up 必须在同一会话内完成；用 `rpc.withSession()` 或 `rpc.clickReal()` 规避。
16. **异常路径漏 detach 会拖死整个 host**：一次 60s TIMEOUT 之后 host 直接 `CONNECTION_REFUSED`，因为 debugger 会话没释放。所有 `attach` 都要配 `finally detach`——用 `rpc.withSession(tabId, fn)` 自动保证。
17. **站点表单 URL 没有统一规律，不要猜**：从页面抓 `href` 或 `aria-label`。例：LinkedIn 经历是 `/edit/forms/position/<id>/`、项目是 `/details/projects/edit/forms/<id>/`、技能是 `/skills/edit/forms/new/`；猜出来的路径会 404。
18. **版本号是统一的**：`/status` 的 `version` 就是扩展版本（host 与扩展共用 `extension/manifest.json`），不需要区分两个字段。

## 静默模式（后台操作不抢焦点，扩展 v0.3.0+）

默认情况下，桥的读/写/点击/截图都**不会**把浏览器窗口拉到前台、也不会切换激活 tab——用户在用别的应用时不会被抢焦点。需要用户眼睛的步骤（登录、验证码、扫码、选文件、最终核对）才由 Agent 显式 `tabs.activate` / `page.focus` / `page.activateAndShot`。

### 打开网址：`tabs.resolve`（v0.3.9+，首选入口）

**收到一个网址要打开时，用这个，不要自己 `tabs.list` 里挑 tab 再 `page.navigate`。**

规则：优先复用同类标签页，但**永不抢占用户正在看的页面**——聚焦窗口的活动标签页被排除在候选外；没有可用候选就**静默新开后台标签页**（`active:false`，不切标签、不聚焦窗口）。

- 调用：`POST /rpc`，体 `{"method":"tabs.resolve","params":{"url":"https://..."},"timeoutMs":45000}`
- 别名：`tabs.openUrl` / `page.open`（同一个实现）。`tabs.open` / `tabs.new` 是「无条件新开」的老别名，日常不要用。
- 参数：

  | 参数 | 类型 | 默认 | 说明 |
  |---|---|---|---|
  | url | string | 必填 | 目标网址（缺协议自动补 `https://`） |
  | match | `"host"`\|`"origin"`\|`"exact"` | `host` | 同类判定：同域名 / 同 origin / URL 完全相同 |
  | reuseActive | boolean | false | true 才允许复用用户正在看的活动 tab（一般不要开） |
  | includePinned | boolean | false | 是否允许复用固定标签页（默认跳过，避免动用户的常驻页） |
  | windowId | number | 不限 | 限定在某个窗口内复用/新开 |
  | waitLoad | boolean | true | 是否等页面加载完成 |
  | timeoutMs | number | 45000 | 导航等待超时 |

- 返回：`{ tab, tabId, reused, navigated, reason }`
  - `reused:true, navigated:false, reason:"reuse-existing-url"` → 目标页已在该 tab 打开，**不要重复 navigate**（会整页刷新、丢状态）
  - `reused:true, navigated:true` → 复用了后台同类 tab 并已跳转
  - `reused:false` → 静默新开后台 tab；`reason` 说明为什么没复用（最常见的就是「唯一同类标签页是用户正在看的」）
- 最小可用示例：

  ```js
  const r = await b.rpc("tabs.resolve", { url: "https://www.xiaohongshu.com/search_result?keyword=xx" }, 45000);
  const tabId = r.tabId;                       // 后续 page.* 全用这个
  if (r.navigated) await b.rpc("page.waitForReady", { tabId, timeoutMs: 30000 });
  ```

  CLI：`node "$CLI" open <url>`（等价调用，输出复用/新开原因）；`open <url> --new` 才无条件新开。
- **版本要求**：扩展 v0.3.9+。旧版返回 `UNKNOWN_METHOD` 时降级：`tabs.create({url, active:false})` 新开后台 tab（宁可多开一个，也不要去动用户当前页）。

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
| **滚动加载不推进 / 懒加载出不来内容** | **`page.ensureActive`（v0.3.10+）** |
| 需要前台时序（动画、依赖 rAF 的组件） | **`page.ensureActive`（v0.3.10+）** |

### 页面必须激活才能继续时：用 `page.ensureActive`，不要用 `tabs.activate`（v0.3.10+）

**Chrome 对后台标签页把 `requestAnimationFrame` 完全暂停**（实测 2s 内 **0 帧**，活动页 60 帧）、
`document.visibilityState="hidden"`。依赖 rAF / IntersectionObserver 的懒加载、瀑布流、无限滚动
在后台**永不推进**——滚动会返回 `{ok:true}`，但列表永远只有首屏那几条。

> 这是「暂停」不是「节流」，**加长超时完全没用**，别在这上面浪费轮次。

```js
await rpc.ensureActive(tabId);      // 需要页面真渲染时
await rpc.restoreActive(tabId);     // 收工/提前归还
```

和 `tabs.activate` 的关键区别：

- **只切标签页、不聚焦窗口**（不调 `chrome.windows.update({focused:true})`）。实测单独
  `chrome.tabs.update({active:true})` 就能恢复 rAF（Chrome 不在前台时同样有效），
  **所以用户正在别的应用里工作时不会被弹到 Chrome**。
- **用完自动还原**：默认 20s 无操作后把活动标签页还给用户原来那个；长流程中每次 `page.*` 调用
  都会续期，不会在滚动循环中途抢走前台。`restoreAfterMs` 可调。
- **只在必要时才激活**：内部先探 `document.hidden`，已在渲染就原样返回（`activated:false`）。

> 注：CDP `Emulation.setFocusEmulationEnabled` 也能恢复 rAF，但它 **detach 或页面导航后立即失效**
> （实测），而 detach 是每次 RPC 收尾都会做的事，所以不能用它代替。

### 滚动加载检测：`page.scroll { checked: true }`

后台页里 `window.scrollBy` **仍然生效**（滚动位置会变），所以「滚动成功」不能当作「内容加载了」的依据。

```js
await rpc.scrollChecked(tabId, { direction: "down", expectGrowth: true });
// 推进了：{ checked:true, grew, moved, atBottom, heightBefore, heightAfter }
// 后台没加载出来：抛 SCROLL_NO_GROWTH
// 视口完全没动：抛 SCROLL_STALLED
// 到底了收尾：加 allowNoProgress:true
```

**错误里带结构化字段，用字段判断，不要解析 message**：

```js
try { await rpc.scrollChecked(tabId, { y: 99999, expectGrowth: true }); }
catch (e) {
  e.code;                  // SCROLL_NO_GROWTH | SCROLL_STALLED
  e.detail("recoverable"); // ★ 激活能不能解决：true 才值得调 ensureActive
  e.details.atBottom;      // 真到底了就别再激活
  e.details.wasHidden;     // 当时是不是后台标签页
}
```

`recoverable === false` 时（前台也没动 / 已到底）**不要激活**——那是选择器或容器问题，
激活只会白打扰用户。

**不想自己写判断就用 `scrollLoad`**：先直接滚 → 只有 `recoverable===true` 才 `ensureActive` →
重试一次；返回带 `{ borrowed, activated, attempts, firstError }`。

`expectGrowth` 是「这一滚**应该**加载出新内容」的声明；判断到底请用返回的 `atBottom` 字段
（**不要**用 atBottom 去免掉这个检查——懒加载的哨兵元素本来就在列表末尾）。老写法
`page.scroll`（不带 `checked`）行为不变。

### 截图行为变化（v0.3.0+）

`page.screenshot` 默认 CDP 静默截图（后台 tab 可用）；CDP 失败时**不再偷偷激活窗口**，报 `SCREENSHOT_FAILED`。显式传 `allowActivate:true` 或改用 `page.activateAndShot` 才会降级到 `captureVisibleTab`（该路径要求目标 tab 是窗口内激活 tab）。

### 后台节流与冻结（v0.3.10+ 自动处理）

Chrome 会把后台 tab 的定时器压到 1 秒级，并在长闲后**冻结渲染器**（Memory Saver / 高能效模式）。
两种情况都已自动处理，Agent 不需要做任何事：

- **冻结**：`chrome.scripting.*` 全部挂到超时（13s），扩展会自动 CDP 解冻后重试一次。
- **渲染暂停**：rAF 被暂停导致懒加载不推进——这一种**不能**自动处理（自动激活会在长流程里反复
  抢用户前台），需要你显式 `page.ensureActive`，并用 `page.scroll{checked}` 判断是否真的加载了。


## 错误码（可诊断）

桥接层返回结构化错误，包含 code/method/tabId/channel/elapsedMs：

- `TIMEOUT` / `EXT_DISCONNECTED` / `SEND_FAILED`：扩展通道层。超时后会返回 method、tabId、channel、耗时，日志不含 token 与页面内容。
- `TAB_BUSY`：同 tab 请求串行队列中前序请求占用（一般等待而非报错；若恢复窗口内，短时间等待后重试）。
- `NAV_TIMEOUT`：导航/等待 URL/ready/selector 超时。
- `PAGE_CONTEXT_TIMEOUT`：页面上下文已销毁/无法注入 content script（导航中、chrome://、上下文崩溃）。
  **v0.3.10+ 会自动先试一次 CDP 解冻**（渲染器被 Memory Saver 冻结是它的头号成因）；仍报错才是真坏。
- `SCROLL_NO_GROWTH`：`page.scroll{checked:true, expectGrowth:true}` 时，滚动生效了但页面没加载出新内容。
  典型是后台标签页 rAF 被暂停 → 先 `page.ensureActive`。
- `SCROLL_STALLED`：滚动指令完全没生效（位置未变），通常是选择器/容器不可滚。
- `CONTENT_TIMEOUT`：content 调用（click/type 等）超时。
- `EXT_DISCONNECTED` 在扩展 WS/Native 断连时让所有 pending 请求确定结局，不无限挂起。
- `TAB_LEASED`：Tab 已被其他 Agent 占用。
- `AGENT_STOPPED`：**用户在页面上点了「停止 Agent」**（或有人调了停止接口）。
  - 只拦**写**操作（click/type/press/navigate/scroll/…，以及 CDP 的 `Input.*`）。
  - 只读操作（`page.info`/`snapshot`/`evaluate`/`tabs.list`、CDP 的 `Runtime.*`）**不受影响**——
    你仍然可以看页面来判断该等用户还是该恢复。
  - 恢复：`rpc.call("agent.resume", { tabId })`（省略 tabId = 恢复全局）。
    判断依据在 `e.detail("resumeWith")`（= `"agent.resume"`）与 `e.detail("scope")`（`"tab"` / `"all"`）。
  - 停止**不是回放**：已经落到页面上的动作（点过的按钮、提交过的表单）无法撤销，
    只有**尚未派发**的排队请求会被取消。收到这个错误就停下来问用户，不要自动 resume 后重试。

### 超时与取消语义（v0.3.11+，避免「以为失败却偷偷执行」）

- **排队时间计入你的 timeoutMs**：请求从进入 host 就开始计时，排队、等扩展重连、执行共用同一预算。
  排到队时预算已耗尽就直接失败（`TIMEOUT`，`details.phase` 是 `queued` / `waiting-ext` / `executing`），
  **不会**在你已经放弃之后才把操作发出去。
- **客户端断开即取消未派发的请求**：HTTP 连接断开 / WS 关闭时，同 Agent 排队中且尚未派发的请求会被取消。
  对 `page.click` / `page.type` / 发消息 / 提交表单这类**不可逆**操作，这条是防止「调用方以为失败、实际稍后执行」的关键。
- 已经派发到扩展的请求无法撤回（响应里会如实报告 `inFlight` 数量）。

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

租约在**派发前会重新校验**（v0.3.11+）：排队期间租约易主，排到队时会被拒绝，而不是带着过期归属继续执行。

### 停止 Agent（用户随时可能按下）

页面上会出现一个「停止 Agent」按钮（只在 click/type/scroll 等交互操作后显示）。用户按下后：

| 会怎样 | 说明 |
|---|---|
| 后续**写**操作被拒 | 报 `AGENT_STOPPED`，**不会**静默继续 |
| 排队中未派发的请求被取消 | 立即收到错误，不用等到排到队首 |
| 只读操作不受影响 | 你仍可观察页面状态 |
| 已派发/已完成的动作无法撤销 | 停止不是回放 |

范围默认是**当前标签页**（按钮在你操作的那个页面上按下）；全局停止由 API 显式触发。

```js
// 判断自己是否被停（不必解析 message）
try { await rpc.clickEl(tabId, "..."); }
catch (e) {
  if (e.code === "AGENT_STOPPED") {
    console.log(e.detail("resumeWith")); // "agent.resume"
    console.log(e.detail("scope"));      // "tab" | "all"
    // 停下来问用户。不要自动 resume 重试——用户刚明确表示不要继续。
  }
}
```

CLI 也能管：

```bash
node agent/cli.mjs stop-status      # 当前有没有停止在生效
node agent/cli.mjs stop             # 全局停止
node agent/cli.mjs stop 12345       # 只停 tab 12345
node agent/cli.mjs resume 12345     # 恢复该 tab
```

## 同 tab 串行与跨 tab 并行

- 同一 tab 的 `page.*` / `tabs.get|activate|prepare|close|reload` / `session.*` 请求在 host 端**严格串行**（按 tabId 维护队列），避免 BOSS 重型 SPA 下 navigate/snapshot/evaluate 互相堆积导致超时。
- 跨 tab 请求并行。
- 单个请求超时不会让同 tab 后续所有请求雪崩：超时后该 tab 进入短恢复窗口（约 500ms），后续请求重试而非级联失败。

## 增强等待 API（BOSS SPA，不依赖固定 sleep）

- `page.waitForUrl` `{ tabId, match?/equals?, timeoutMs?, intervalMs? }`：等 URL 变化。
- `page.waitForReady` `{ tabId, timeoutMs? }`：等 `document.readyState` 为 complete。
- `page.waitForSelector` `{ tabId, selector, by?, timeoutMs?, intervalMs? }`：等选择器出现。
- `page.waitLoad` `{ tabId, timeoutMs? }`：等加载完成（webNavigation + 轮询兑底）。

## 前台渲染保障（v0.3.10+）

Chrome 对后台标签页把 `requestAnimationFrame` **完全暂停**（实测 2s 内 0 帧），
懒加载 / 瀑布流 / 无限滚动在后台永不推进。需要页面真渲染时：

- `page.ensureActive` `{ tabId, restoreAfterMs? }`：**只在必要时**（`document.hidden`）临时激活。
  只切标签页、**不聚焦窗口**，且空闲后**自动把活动页还给用户**（默认 20s，长流程中每次
  `page.*` 调用续期）。返回 `{ activated, alreadyRendering, willRestoreTo, note }`。
- `page.restoreActive` `{ tabId }`：立刻归还，不等空闲计时器。
- `page.scroll` `{ ..., checked: true }`：滚动并**回读页面高度/滚动位置**验证真的推进了，
  没推进报 `SCROLL_NO_GROWTH` / `SCROLL_STALLED`；错误里带 `recoverable` / `atBottom` /
  `wasHidden` 结构化字段（用字段判断，不要解析 message）。到底收尾加 `allowNoProgress:true`。
- `page.scrollLoad`（客户端封装，见 `scripts/lib/bridge.mjs`）：先直接滚，只在 `recoverable===true`
  时自动 `ensureActive` 并重试——**不写判断也能用，且不会在无关场景打扰用户前台**。

> 为何不自动激活：自动激活会在长流程里反复抢用户前台。所以只提供「可判断的信号 +
> 一键封装」，由 Agent 决定。详见 `KNOWN_ISSUES.md`。

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
3. **不抢占用户正在看的标签页**：拿到一个网址要打开时走 `tabs.resolve`（见上方「打开网址」一节），它会复用**非活动**的同类 tab，没有就静默新开后台 tab。**禁止把「聚焦窗口的活动 tab」拿来 `page.navigate`**——那是用户正在看的页面，跳走就是直接把人家的页面顶掉。判断依据用 `tabs.list` 返回的 `active` 字段（或 `tabs.active`），不要凭「最后一个 tab」之类的猜测。真需要在用户当前页上操作时，先向用户说明。
   - 脚本里不要写「找不到匹配 tab 就 fallback 到 active tab」——这条 fallback 正是抢页面的元凶。宁可静默新开后台 tab。

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
