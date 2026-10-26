---
name: agent-browser-bridge
description: 用真实 Chrome 打开、读取、操作任意网页——**拿到 http(s) 链接要读内容时默认用本技能，不要先试 curl / wget / WebFetch 赌它是静态页**：前端渲染的站点（SPA / React / Vue / 动态加载）用 curl 只能拿到空壳 HTML，正文一个字都没有，而且**不会报错**，会静默给出错误结论。覆盖：读网页正文与价格/文档/列表数据、站内搜索、抓取动态渲染或登录后数据、点击输入滚动截图、执行 JS、下载文件、填表提交发消息投递下单预订、管理后台操作。走用户日常 Chrome 与真实登录态，可进入被反爬 / 风控拦截（验证码、登录墙、无头指纹、滑块）与需登录页面：小红书、知乎、大众点评、BOSS 直聘、公众号后台、网银、论坛等。已有专项子技能（xhs / boss / chatgpt / notebooklm / linkedin / debug / captcha）必须先读其 SKILL.md 并优先复用 scripts/ 下现成脚本与 scripts/lib/bridge.mjs；遇到页面改版、结构变动或未收录站点时，通过 page.inspect 实时探查并灵活应变；任务中验证通过的新站点配方、改版适配与通用经验必须在收尾时沉淀回子技能、scripts/ 或 KNOWN_ISSUES.md。需要登录 / 授权 / 扫码 / 验证码时，必须先告知用户要访问的页面与原因并等待用户手动完成，不得替用户登录或绕过验证。判断口径：**只要任务是「从某个网址拿到内容」或「在网页上做操作」，就是本技能**，不存在「先用通用工具试、失败再切过来」的降级层。
---

# Agent Browser Bridge —— 让 Agent 操作日常 Chrome

架构：Chrome 扩展（MV3）↔ 本地桥 host（`relay/host.js`，`127.0.0.1:8778`）↔ Agent 客户端（HTTP/WS JSON-RPC）。驱动用户日常 Chrome（真实登录态、真实指纹、真实环境）。

---

## 开工前必读（按顺序执行）

### 1. 读 `KNOWN_ISSUES.md` 与查子技能索引

任务命中下方「子技能索引」任一行 → **先读取对应子技能的 `SKILL.md`，优先直接运行 `scripts/*.mjs`**。未命中时先看 `KNOWN_ISSUES.md` 了解行为红线与错误码速查。

| 站点 / 目标 | 子技能 | 现成脚本（`<skill 目录>/scripts/`） |
| --- | --- | --- |
| **小红书 xiaohongshu.com**（搜笔记、抓正文、**全量评论含楼中楼二级回复**、搜用户、用户主页、问点点 AI） | `xhs/SKILL.md` | `extract-xhs-comments.mjs`、`xhs-search-inpage.mjs`、`xhs-note-full.mjs`、`xhs-search-user.mjs`、`xhs-user-notes.mjs`、`xhs-ask-diandian.mjs`、`xhs-dismiss-softblock.mjs` |
| **BOSS 直聘 zhipin.com**（搜职位、筛选、读 JD、打招呼投递） | `boss/SKILL.md` | `boss-send-chat.mjs`、`boss-batch-apply.mjs`、`boss-verify-helpers.mjs` |
| **ChatGPT chatgpt.com**（网页端提问、读回复、选模型、生图；严格 CSP 禁 `page.evaluate`） | `chatgpt/SKILL.md` | `chatgpt-ask.mjs`、`cdp-eval.mjs` |
| **NotebookLM**（新建笔记本、上传来源、提问、Studio 产物） | `notebooklm/SKILL.md` | `notebooklm/upload.mjs`、`notebooklm/ask.mjs`、`notebooklm/scripts/*.mjs`、`scripts/cdp-upload.mjs` |
| **LinkedIn linkedin.com**（读档案、改 Headline/About、增删改经历与项目、中英双语档案） | `linkedin/SKILL.md` | `linkedin/scripts/linkedin-read.mjs`、`linkedin/scripts/linkedin-edit.mjs`、`linkedin/scripts/lib/linkedin.mjs` |
| **Cloudflare 挑战页 / 人机验证**（`Just a moment...`、Turnstile、`/cdn-cgi/challenge-platform/`） | `captcha/SKILL.md` | `captcha/scripts/cf-wait.mjs` |
| **任何站点：页面异常 / 结构陌生 / 交付前验证** | `debug/SKILL.md` | 内置 `page.inspect` / `page.record` RPC；兜底 `browser-debug.mjs` |

### 2. 开工体检：`scripts/preflight.mjs`

一条命令确认桥连通性、扩展版本能力与可用标签页：

```bash
node <skill 目录>/scripts/preflight.mjs                 # 人类可读体检
node <skill 目录>/scripts/preflight.mjs --json          # 机器可读
TAB=$(node <skill 目录>/scripts/preflight.mjs --pick github)  # 直接拿匹配可用 tabId（无匹配退出码 3）
```

等价状态检查（不依赖脚本）：

```bash
curl -s http://127.0.0.1:8778/status
```

- `version` 即扩展与 host 的统一版本号（源于 `extension/manifest.json`）。拿到 `UNKNOWN_METHOD` 一律是扩展版本不够新，对照 `CHANGELOG.md`。
- 若从未安装过（无 `~/.chrome-agent-bridge/token`）：读 `INSTALL.md`，向用户说明并获同意后再安装。
- 登录由用户主导：目标页需要登录 / 扫码 / 验证码 / 2FA 时，必须先告知用户并等待其手动完成，禁止代登录或绕过验证。

### 3. 多步流程统一用 `scripts/lib/bridge.mjs`

`scripts/lib/bridge.mjs` 自包含（仅依赖 Node 内置模块），内置：**三层返回值自适应解包 `unwrap()`**、**坏 tab 连续 3 次上下文错误自动熔断（`TAB_UNHEALTHY`）**、**进程退出自动释放 CDP 会话与 Tab 租约**、**用户点「停止 Agent」（`AGENT_STOPPED`）自动以退出码 3 终止**。

```js
import { Rpc, openUrl, waitReady, sleep } from "./scripts/lib/bridge.mjs";
const rpc = new Rpc({ agentName: "MyTask" });
await rpc.preflight();

// 一键读网页正文（自动打开/复用后台 tab、处理后台未渲染、提取正文与链接、关闭本次新建的 tab）
const article = await rpc.readPage("https://example.com/pricing");
console.log(article.title, article.text, article.blocker);

// 多步交互：选 tab + 等就绪 + 验可注入 + 结束自动 detach 并关掉本次新建的 tab
await rpc.withPage("https://example.com/", async (tabId) => {
  const snap = await rpc.snapshotCompact(tabId);          // 紧凑快照，元素带稳定短标号 [e1], [e2]
  console.log(snap.compact);
  const c = await rpc.clickReal(tabId, "@e1");            // 单次原子 CDP 真实点击，返回带 c.delta
  const t = await rpc.typeReal(tabId, "input#q", "hello");// 单次原子受控输入 + 自动回读校验 t.verified
  const v = await rpc.evalCdp(tabId, "document.title");   // 单次无状态 CDP 求值（绕过 CSP，不留调试横条）
});
```

---

## 核心工作原则與四条安全红线

### 第一原则：优先复用 → 临场应变 → 持续沉淀

1. **优先复用**：命中子技能索引时先跑现成 `scripts/*.mjs`（内置限速抖动、单 tab 复用、验证码退出、静默注入）；新流程基于 `scripts/lib/bridge.mjs` 构建，优先调命令行参数适配。
2. **随机应变**：遇到未收录站点、页面改版选择器失效或弹窗遮挡时，先调 `page.inspect`（`overview` / `links` / `scroll` / `modal` / `sel`）探查实时 DOM：
   - `page.evaluate` 报 CSP 错误 → 切 `page.evalCdp` 或 `rpc.ev()`；
   - 点击无反应 → 在 `page.clickReal`（CDP 真实鼠标）与 `page.click` / `rpc.clickEl`（DOM 原生 `.click()`）间切换；
   - 后台标签页列表为空或 `SCROLL_NO_GROWTH`（`recoverable: true`）→ 调 `page.ensureActive` 或用 `rpc.scrollLoad`；
   - `overview.blocker` 为 `dismissible_modal`（提示型软弹窗）→ 点掉关闭按钮继续；为 `captcha` / `cloudflare` / `login_wall` → 按对应规约停手交用户。
3. **持续沉淀**：跑通新解法后回写对应 `scripts/*.mjs`、`<子技能>/SKILL.md` 或 `KNOWN_ISSUES.md`，并清理一次性临时探查脚本。

### 四条硬性红线（所有站点必须遵守）

1. **拿到网址读内容默认走本技能，禁止先 `curl`**：现代 SPA/React/Vue 的 HTML 是空壳（HTTP 200 但 `body` 可见文本为 0）。除非目标是明确返回 JSON/XML/纯文本的接口或静态源码文件，凡是网页一律直接用 `page.read` 或 `withPage`。
2. **变更类操作必须回读验证**：删除 / 保存 / 提交 / 发布后，不仅看交互返回的 `delta`，还必须重新加载列表或详情页确认业务状态真变了（可用 `rpc.mutateAndVerify(mutate, verify)`）。
3. **遇到硬风控 / 验证码立即停止，禁止重试**：出现验证码、滑块或连续 404 时立即停止该站点后续请求，告知用户处理（小红书 `.reds-alert`「我知道了」软弹窗除外，用 `scripts/xhs-dismiss-softblock.mjs` 点掉）。
4. **默认静默运行、少开标签页、收到 `AGENT_STOPPED` 立即停手**：
   - 打开网址用 `tabs.resolve`（不抢用户正在看的活动标签页），优先在单 tab 内跳转，自己新建的 tab 用完必关；
   - 用户按下页面上的「停止 Agent」后，所有写操作返回 `AGENT_STOPPED`，必须立即停止一切写操作并向用户汇报进度，禁止自动 `agent.resume` 后重试。

---

## 路径约定与 CLI 快速开始

| 记号 | 含义 | 解析方式 |
| --- | --- | --- |
| `<skill 目录>` | 本 `SKILL.md` 所在目录 | 读取者按实际加载路径替换（symlink 请用 `cd -P` 解引用） |
| `$ROOT` | 仓库根 = `<skill 目录>/../..` | `ROOT="$(cd -P <skill 目录> && pwd)/../.."` |
| `<cli>` | 本机仓库便利 CLI | `"$ROOT/agent/cli.mjs"`（纯 HTTP 客户端，不依赖 cwd） |

```bash
export BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token)
ROOT="$(cd -P <skill 目录> && pwd)/../.."
CLI="$ROOT/agent/cli.mjs"

node "$CLI" status                        # host 状态、版本、连接与停止状态
node "$CLI" errors [tabId]                # 查看 host 内存记录的近期错误与错误码统计（免 grep 日志）
node "$CLI" read <url>                    # ★ 一键读取网页正文+主链接+阻断诊断（自动开关临时后台 tab）
node "$CLI" tabs                          # 列出所有标签页
node "$CLI" open <url>                    # 打开网址首选：复用非活动同类 tab，否则静默新开后台 tab
node "$CLI" snap <tabId> [compact|elements|a11y|text|full]  # 快照（默认 compact，输出 [e1] 短标号）
node "$CLI" click <tabId> <selector|@e1>  # DOM 点击（支持 CSS 选择器或快照 @e1 引用）
node "$CLI" click-real <tabId> <sel|@e1 | x y>  # ★ 扩展内原子 CDP 真实鼠标点击
node "$CLI" type <tabId> <sel|@e1> <text> # DOM 输入
node "$CLI" type-real <tabId> <sel|@e1> <text>  # ★ 扩展内原子 CDP 受控组件输入 + 自动回读校验
node "$CLI" upload <tabId> <sel> <file..> # ★ 扩展内原子 CDP 文件上传
node "$CLI" eval-cdp <tabId> "<js>"       # ★ 单次无状态 CDP 求值（绕过强 CSP，不留调试横条）
node "$CLI" eval <tabId> "<js>"           # 页面求值（MAIN world，遇 CSP 自动走 CDP 兜底）
node "$CLI" wait <tabId> ready|url|selector <arg> [timeoutMs] # 条件等待
node "$CLI" scroll <tabId> <up|down|left|right>
node "$CLI" ensure-active <tabId>         # 临时激活后台 tab 恢复 rAF 渲染（不聚焦窗口，空闲自动归还）
node "$CLI" inspect <tabId> [overview|links|media|scroll|modal|sel:<css>]
node "$CLI" record <tabId> start|stop|status|get|clear [types]
node "$CLI" shot <tabId> [out.png]        # 静默截图（默认保存到 .scratch/screenshots/）
node "$CLI" stop [tabId] / resume [tabId] # 停止或恢复 Agent 写操作
```

---

## 核心 RPC 接口详解（自包含，不依赖 CLI）

HTTP 调用格式：`POST http://127.0.0.1:8778/rpc`
请求头：`Authorization: Bearer <token>`、`Content-Type: application/json`、`X-Agent-Id: <id>`、`X-Agent-Name: <urlEncodedName>`
请求体：`{"method":"<method>","params":{...},"timeoutMs":20000}`

### 1. 一键读取网页：`page.read`（v0.3.13+）

单次调用完成：`tabs.resolve` 复用/后台新开 → `waitForReady` → 提取正文/标题/主链接 + `blocker` 阻断诊断 → **若因后台渲染暂停导致正文为空（`textLength < 80` 且 `document.hidden`）则自动临时 `ensureActive` 唤醒重读并归还** → 自动关闭本次新建的标签页。

- 参数：

  | 参数 | 类型 | 默认 | 说明 |
  |---|---|---|---|
  | url | string | 与 tabId 二选一 | 目标网址（未传 tabId 时自动走 `tabs.resolve`） |
  | tabId | number | 与 url 二选一 | 指定已有标签页读取（可同时传 url 导航后读取） |
  | maxLength | number | 20000 | 返回正文最大字符数 |
  | includeLinks | boolean | true | 是否提取正文区域可见链接 |
  | maxLinks | number | 30 | 最多返回链接数 |
  | keepOpen | boolean | false | 新建 tab 时是否保留不关（复用已有 tab 时永不关） |
  | waitMs | number | 0 | 就绪后额外等待毫秒数（重度异步渲染页面可用） |

- 返回示例：

  ```json
  {
    "ok": true,
    "tabId": 681467890,
    "reused": false,
    "closed": true,
    "activatedForRender": false,
    "url": "https://example.com/",
    "title": "Example Domain",
    "description": "...",
    "textLength": 1250,
    "truncated": false,
    "text": "Example Domain ...",
    "headings": [{ "level": "h1", "text": "Example Domain" }],
    "links": [{ "text": "More information...", "href": "https://www.iana.org/domains/example" }],
    "blocker": null
  }
  ```

- 最小可用示例：

  ```js
  const r = await rpc.readPage("https://example.com/docs");
  if (r.blocker) console.error("页面受阻:", r.blocker);
  else console.log(r.title, r.text);
  ```

### 2. 快照、紧凑模式与持久化元素引用 `ref`：`page.snapshot`（v0.3.13+ 增强）

`page.snapshot` 在頁面 isolated world 内存中为每个可见交互元素分配稳定短标号（`e1`, `e2`, ...，不修改页面 DOM 属性，零指纹暴露）。

- 参数：`{ tabId, mode: "compact" | "elements" | "a11y" | "text" | "full", includeText: true, maxElements: 200 }`
- 返回（`mode: "compact"`）：

  ```json
  {
    "url": "https://example.com",
    "title": "Example",
    "readyState": "complete",
    "mode": "compact",
    "elementCount": 2,
    "compact": "[e1] textbox \"搜索关键词\" @(420,120)\n[e2] button \"搜索\" @(560,120)",
    "text": "页面正文..."
  }
  ```

- **用 `ref` 直接定位元素**：`page.click`、`page.clickReal`、`page.type`、`page.typeReal`、`page.hover`、`page.focusEl`、`page.select`、`page.press` 均支持传 `{"tabId": 1, "ref": "e2"}` 或 `{"tabId": 1, "selector": "@e2"}`。
- 若该 DOM 节点已在页面重渲染后被移除，立即报 `STALE_ELEMENT_REF`（`details: { ref: "e2", stale: true }`），不会像 `by: "index"` 那样因下标错位误点其他按钮。

### 3. 扩展内原子 CDP 操作：`page.evalCdp` / `page.clickReal` / `page.typeReal` / `page.uploadFile`（v0.3.13+）

全部在扩展内通过 `withBorrowedDebugger` 单次完成并自动归还调试器（若 Agent 已显式 `session.attach` 则复用且不拆会话）：

| 方法 | 参数 | 返回示例 | 适用场景 |
|---|---|---|---|
| `page.evalCdp` | `{ tabId, expression, awaitPromise?, userGesture? }` | `{ result: <值>, via: "cdp" }` | 严格 CSP / Trusted Types 站点（如 chatgpt.com、linkedin.com、github.com）单次求值 |
| `page.clickReal` | `{ tabId, selector?, ref?, by?, x?, y?, button?, clickCount?, delayMs? }` | `{ ok: true, x, y, ref, tag, text, via: "cdp", delta }` | React/Vue 菜单展开、只认真实鼠标事件的组件（传选择器或 `@e1` 自动滚动居中算坐标） |
| `page.typeReal` | `{ tabId, selector?, ref?, by?, text, clear?: true, pressEnter?: false }` | `{ ok: true, ref, tag, value, verified: true, via: "cdp", delta }` | React/Vue/ProseMirror 受控输入框（自动聚焦 + 清空 + CDP `Input.insertText` + 回读校验） |
| `page.uploadFile` | `{ tabId, selector?: 'input[type="file"]', files: string[] }` | `{ ok: true, selector, count, files, via: "cdp" }` | 给 `<input type="file">` 注入本地文件绝对路径 |

最小可用示例：

```js
// 受控输入框写入并一步校验确实写进去了
const res = await rpc.typeReal(tabId, "@e1", "前端开发工程师", { pressEnter: true });
if (!res.verified) throw new Error(`输入未生效，当前值: ${res.value}`);
console.log("输入后 URL 是否变化:", res.delta?.urlChanged);
```

### 4. 交互动作增量状态（Action Delta，v0.3.13+）

`page.click`、`page.clickReal`、`page.type`、`page.typeReal`、`page.press`、`page.select` 执行后自动采样页面变化并附带 `delta` 字段：

```json
{
  "ok": true,
  "ref": "e5",
  "tag": "BUTTON",
  "text": "提交",
  "delta": {
    "urlChanged": false,
    "url": "https://example.com/form",
    "titleChanged": false,
    "modalOpened": true,
    "modalClosed": false,
    "activeTag": "button",
    "activeValue": null,
    "mutationCount": 8,
    "mutations": { "added": 6, "removed": 0, "textChanged": 2 }
  }
}
```

### 5. 打开网址与静默准备：`tabs.resolve` / `tabs.prepare`

- **`tabs.resolve`（首选打开入口，v0.3.9+）**：`{"method":"tabs.resolve","params":{"url":"https://...","match":"host"|"origin"|"exact","waitLoad":true}}`
  - 只复用**非活动**的同类 tab（聚焦窗口的活动页被保护，绝不顶掉用户正在看的页面）；无可用候选时以 `active: false` 静默新开后台 tab。
  - 返回 `{ tab, tabId, reused, navigated, reason }`。若 `reused: true, navigated: false` 表示目标 URL 已打开，不要重复 `page.navigate`。
- **`tabs.prepare`（静默注入 + 防冻结，v0.3.0+）**：`{"method":"tabs.prepare","params":{"tabId":<id>}}`
  - 保证 content script 已注入且设置 `autoDiscardable: false`；若后台 tab 渲染器被 Chrome Memory Saver 冻结，v0.3.10+ 会自动通过 CDP 解冻后完成注入。

### 6. 前台渲染保障与滚动加载检测：`page.ensureActive` / `page.scroll { checked: true }`（v0.3.10+）

Chrome 对后台标签页将 `requestAnimationFrame` 完全暂停（0 帧），导致依赖 rAF / IntersectionObserver 的瀑布流与懒加载不推进。

- **`page.ensureActive`**：`{"method":"page.ensureActive","params":{"tabId":<id>,"restoreAfterMs":20000}}`
  - 仅在 `document.hidden === true` 时切标签页（**不聚焦浏览器窗口**，不打断用户当前应用），空闲 20s 后自动切回原活动标签页；提前归还调 `page.restoreActive`。
- **`page.scroll { checked: true, expectGrowth: true }`**：
  - 回读页面高度与滚动位置；未推进时抛 `SCROLL_NO_GROWTH` 或 `SCROLL_STALLED`，错误 `details` 含 `{ recoverable, atBottom, wasHidden }`。
  - 推荐直接用 `scripts/lib/bridge.mjs` 的 `await rpc.scrollLoad(tabId, { direction: "down", expectGrowth: true })`：先静默滚，仅当 `recoverable === true` 时自动 `ensureActive` 重试一次。

### 7. 页面实时探查、通用阻断诊断与会话录制：`page.inspect` / `page.record.*`

无需手写 DOM 遍历 JS，直接调用内置探查：

```js
await rpc.call("page.inspect", { tabId, focus: "overview" });              // URL/标题/弹窗/blocker阻断诊断/可滚动容器/搜索框
await rpc.call("page.inspect", { tabId, focus: "links", limit: 6 });       // 列表卡片链接+可见性（防点 display:none 隐藏链接）
await rpc.call("page.inspect", { tabId, focus: "media" });                 // 图片/视频/live/blob
await rpc.call("page.inspect", { tabId, focus: "scroll" });                // 找出真正可滚动的容器
await rpc.call("page.inspect", { tabId, focus: "modal" });                 // 弹窗详情与弹窗内可见按钮清单
await rpc.call("page.inspect", { tabId, focus: "sel", selector: ".item" });// 指定选择器采样
```

`overview.blocker` 会自动识别四类阻断状态：
- `"cloudflare"` → 调用 `node <skill 目录>/captcha/scripts/cf-wait.mjs <tabId>`；
- `"captcha"` → 立即停止重试，请用户完成验证；
- `"login_wall"` → 请用户登录；
- `"dismissible_modal"` → 给出 `dismissText`，可直接点击关闭按钮继续。

过程性问题（如滚动后跳 404）用会话时间线记录：`page.record.start` → 复现操作 → `page.record.get`（含 `nav`/`modal`/`err`/`dom`/`console` 事件）→ `page.record.stop`。详见 `debug/SKILL.md`。

### 8. 近期报错查询与排查：`bridge.recentErrors`（v0.3.13+）

host 在内存中维护最近 100 条失败请求的环形缓冲（且 `~/.chrome-agent-bridge/host.log` 超过 5MB 自动轮转）：

```js
// 直接拿到近期错误明细与按错误码汇总的统计分布，无需 grep host.log
const errs = await rpc.recentErrors({ tabId, limit: 10 });
console.log(errs.byCode, errs.errors);
```

HTTP 等价：`GET http://127.0.0.1:8778/errors?limit=20&tabId=<id>`（带 `Authorization: Bearer <token>`）。

常见错误码处理速查（完整表见 `KNOWN_ISSUES.md`）：
- `AGENT_STOPPED`：用户在页面点击了「停止 Agent」（只拦写操作，只读放行）。立即停止写操作并询问用户；恢复用 `agent.resume`。
- `STALE_ELEMENT_REF`：快照引用 `@e1` 对应的节点已从 DOM 移除，重新调 `page.snapshot` 获取新 `ref`。
- `TAB_UNHEALTHY`：同 tab 连续 3 次上下文级失败被客户端熔断，换用 `tabs.resolve` / `withPage`。
- `PAGE_CONTEXT_TIMEOUT`：页面上下文失效，调 `tabs.prepare` 重新注入。
- `TAB_DISCARDED`：标签页被浏览器丢弃卸载，需 `tabs.activate` 唤醒重载。
- `TAB_LEASED`：标签页已被其他并行 Agent 租用（多 Agent 协作通过 `rpc.claimTab(tabId)` / `rpc.releaseTab(tabId)` 互斥）。
- `UNKNOWN_METHOD`：扩展版本落后，对照 `CHANGELOG.md` 升级并 `reload-ext`。

### 9. 底层 CDP 直通：`session.attach` / `session.send` / `session.detach`

当需要模拟移动设备视口、裁剪截图或拦截网络等未单独封装的 DevTools 能力时，使用 `rpc.withSession(tabId, fn)` 确保异常路径必 `detach`：

```js
await rpc.withSession(tabId, async () => {
  await rpc.call("session.send", {
    tabId,
    method: "Emulation.setDeviceMetricsOverride",
    params: { width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 2, mobile: true },
  });
  const hasHScroll = await rpc.ev(tabId, "document.documentElement.scrollWidth > document.documentElement.clientWidth");
  console.log("是否存在横向溢出:", hasHScroll);
});
```

---

## 安全与隐私

- 本地桥仅监听 `127.0.0.1`，强制要求长度 ≥ 16 的随机 Bearer token（`~/.chrome-agent-bridge/token`，`0600` 权限；读取失败 fail-closed 拒绝启动）。
- 快照与增量状态对 `password`、`hidden`、信用卡及验证码输入值自动脱敏为 `[value redacted]`。
- 执行投递、发消息、修改公开档案、下单等对外或不可逆动作前，必须先经用户确认（或先跑 `--dry-run`）。
