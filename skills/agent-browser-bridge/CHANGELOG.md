# 版本与更新（扩展 + 本地桥）

## 0.3.14：Firefox 版（同一套 RPC，CDP 经 WebDriver BiDi 执行）

1. **Firefox 扩展**：与 Chrome 版共用 `extension/` 源码，`relay/build-firefox.js` 只派生 manifest（输出 `dist/firefox/`）。
   浏览器差异在运行时按能力判断；`bridge.status` 新增 `browser`、`cdp`（`chrome.debugger` / `bidi`）字段。
2. **CDP→BiDi 翻译层**（`relay/bidi-cdp.js`）：Firefox 扩展没有 `chrome.debugger`，`page.clickReal` / `page.typeReal` /
   `page.uploadFile` / `page.evalCdp` / `page.screenshot` 与 `session.send` 的 CDP 命令由 host 经 Firefox Remote Agent 执行，
   返回形状与 Chrome 一致。支持的 CDP 方法与差异见 `firefox/SKILL.md`；不支持的方法报 `CDP_UNSUPPORTED`。
3. **每个浏览器一个 host**：host 按拉起方识别浏览器，Firefox 默认端口 `8779`、日志 `host-firefox.log`；`/status` 新增 `browser`、`bidi` 字段。
4. **客户端选浏览器**：`scripts/lib/bridge.mjs`、`agent/client.mjs`、`agent/verify-bridge.mjs` 与 `scripts/` 下全部脚本
   支持 `BRIDGE_BROWSER=chrome|firefox`（`BRIDGE_PORT` 优先）。此前这些脚本把 `8778` 写死。
5. **安装与启动**：`install-host.sh --browser firefox` 注册 Firefox native host；`relay/firefox-launch.js` 以 Remote Agent 模式启动
   Firefox 并把扩展装成临时扩展。`relay/sign-firefox.js` 走 AMO 自分发（unlisted）签名，产出可永久安装的 `.xpi`。`firefox-launch.js --install-xpi` 免确认框永久安装签名版。
6. **Chrome 侧行为不变**：调试器调用收敛到 `dbgAttach / dbgDetach / dbgSend`，`withBorrowedDebugger` 归还会话时改为等待 detach 完成。

新增错误码：`BIDI_UNAVAILABLE`、`CDP_UNSUPPORTED`（仅 Firefox）。

## 0.3.13：Agent 易用性全面升级（原子 CDP · 交互 Delta · 元素 ref · 一键读取 · 阻断诊断 · 内存错情）

围绕 `host.log` 33.5 万行真实运行数据暴露的高频痛点，一次性升级扩展、本地桥、客户端与 CLI：

1. **扩展内原子 CDP 操作（消除 80% 冗余往返与调试横条常驻）**：
   - 新增 `page.evalCdp`、`page.clickReal`（支持 `{ selector }` / `{ ref }` 或 `{ x, y }`）、`page.typeReal`（自动聚焦 + 清空 + `Input.insertText` + 回读校验 `verified`）、`page.uploadFile`（单次完成 `DOM.getDocument` → `querySelector` → `setFileInputFiles`）。
   - `scripts/lib/bridge.mjs` 的 `attach(tabId)` 缓存已建立的会话，消除重复 `session.attach` 往返；页面导航断连时自动重连重试；进程退出自动释放全部 CDP 会话与 Tab 租约，内置 `unhandledRejection` / `uncaughtException` 停止码（3）守护。
2. **交互动作返回增量状态摘要（Action Delta）**：
   - `page.click`、`page.clickReal`、`page.type`、`page.typeReal`、`page.press`、`page.select` 均在响应中附带 `delta: { urlChanged, url, titleChanged, modalOpened, modalClosed, activeTag, activeValue, mutationCount }`，单次调用即可验证操作是否生效。
3. **`page.snapshot` 持久化元素引用（`ref`）与 `compact` 紧凑模式**：
   - 在 isolated world 内存中为可见交互元素分配稳定短标号（如 `e1`、`e2`，不改页面 DOM 属性、零指纹暴露），支持 `mode: "compact"` 输出单行紧凑列表（节省 70% 上下文 Token）。
   - `click` / `type` / `hover` / `select` / `clickReal` / `typeReal` 支持 `{ ref: "e12" }` 或选择器 `"@e12"` 直接定位；元素脱离 DOM 时报 `STALE_ELEMENT_REF`，消除下标漂移误点。
4. **一键读取 `page.read` 与跨站点通用 `blocker` 阻断诊断**：
   - `page.read`（及 CLI `read <url>`）一次调用完成打开/复用后台标签页、等待就绪、提取正文与主链接；若后台标签页因 rAF 暂停未渲染正文，自动临时调用 `page.ensureActive` 唤醒重读并归还标签页，读取完毕自动关闭临时标签页。
   - `page.inspect { focus: "overview" }` 与 `page.read` 自动识别 `cloudflare` / `captcha` / `login_wall` / `dismissible_modal` 四类阻断状态。
5. **本地桥 `host.log` 5MB 自动轮转与 `bridge.recentErrors`（`/errors`）**：
   - `relay/host.js` 在日志超过 5MB 时自动保留尾部 64KB 并轮转至 `host.log.1`。
   - 新增 host 内存近期错误环形缓冲（最近 100 条），支持 `GET /errors`、RPC `bridge.recentErrors` 与 `cli.mjs errors [tabId]` 按 `tabId` / `code` 过滤查询并输出错误码统计分布 `byCode`。
6. **统一 `agent/client.mjs` 与 `scripts/lib/bridge.mjs` 环境变量与能力，精简 `SKILL.md`**：
   - 两套客户端统一兼容 `BRIDGE_TOKEN` / `AGENT_BRIDGE_TOKEN` 与 `BRIDGE_PORT` / `AGENT_BRIDGE_PORT`；`cli.mjs shot` 默认输出改为 `.scratch/screenshots/`。

## 0.3.12+（文档与子技能）：captcha 子技能 + 技能工作循环改写 + 两处脚本修复

**新增 `captcha/` 子技能**：`captcha/SKILL.md` 与 `captcha/scripts/cf-wait.mjs`（识别挑战页 → 停止驱动 → 等待自动通过 → 需要点击时把 tab 交用户人工完成并轮询恢复）。

**技能规则改写**：根 `SKILL.md` 的「第一原则」从「先查子技能、禁止重造」改为「优先复用、临场应变、持续沉淀」三段闭环，`KNOWN_ISSUES.md` 约束零、`debug/SKILL.md` 同步；description 与子技能索引、子技能详解补入 `captcha` 与 `linkedin` 入口。

**`scripts/boss-send-chat.mjs`**：输入改用 CDP `Input.insertText`（受信任事件，能触发 React 受控更新），并补上 `page.focusEl` 与 `session.attach`/`session.detach` 配对——实测 `Input.insertText` 只写入当前焦点元素，不先聚焦文字落不到 `.chat-input`。轮询循环里未声明的 `r` 改为局部 `const`（原写法在严格模式下抛 `ReferenceError`）。点击发送保持 DOM `click`，送达验证逻辑不变。

**`scripts/cdp-upload.mjs`**：`session.send` 的返回被 host 多包了一层，`DOM.getDocument` / `DOM.querySelector` 改为自适应读取 `result.root` / `result.nodeId`，原先解构拿到 `undefined` 导致「未找到 file input」。

> 本节只描述 skill 文档与 skill 脚本变更，不含扩展 / host 行为变更，因此未改 `extension/manifest.json` 版本号。

## 0.3.12：CDP 会话隔离（内部流程不再拆掉 Agent 的调试会话）+ LinkedIn 子技能

这一版修的是一个**已在三个不同路径上各自发作**的根因，外加沉淀一个子技能。

### 1. 内部 CDP 流程不再拆掉 Agent 的会话（真 bug，三个故障同一根因）

扩展里有 4 处「`chrome.debugger.attach` → `sendCommand` → `detach`」的裸写法，其中前 3 处
都**无条件 detach**：CDP 兜底求值、CDP 截图、渲染器解冻。而 `rpc.ev()` 会先 `session.attach`
建立 Agent 自己的会话，于是这三个内部流程会把 Agent 的会话一并拆掉，而 `cdpSessions`
集合仍留着 tabId —— 扩展内部状态与真实调试状态不一致。

三个已复现的真实故障：

1. **严格 CSP 站点**（linkedin.com / github.com / chatgpt.com）：先 `page.evaluate`（走 CDP 兜底）
   再 `ev()` → 兜底拆掉会话。后果 A：兜底自己因 detach/sendCommand 竞态拿不到结果，抛出的
   却是 `EVAL_ERROR`（错误信息指向 CSP，与真实原因完全无关）；后果 B：下一次 `ev()` 报
   `SESSION_SEND_FAILED`「Debugger is not attached」。
2. **Agent 持有会话时 `page.screenshot`** → attach 报「Another debugger is already attached」，
   截图直接失败（而不是复用会话）。
3. **Agent 持有会话时渲染器被冻结** → 解冻的 attach 失败，**自愈静默失效**，
   仍要空等 13s 才报 `PAGE_CONTEXT_TIMEOUT`（实测：无会话时 11.9s 自愈成功，有会话时 13.0s 失败）。

修法：收敛成**唯一入口** `withBorrowedDebugger(tabId, fn)`——「谁借的谁还」：

| 情形 | 行为 |
|---|---|
| `cdpSessions` 已有该 tab | 复用 Agent 的会话，结束**不拆** |
| attach 成功 | 我们借的，结束归还 |
| attach 报 `already attached` | 本扩展的遗留会话，登记进 `cdpSessions` 后保留 |
| 报 `Another debugger`（用户开着 DevTools） | 归一为 `DEBUGGER_BUSY` 抛出，**不抢** |

> 为什么收敛而不是在三处各打补丁：第一版只在兜底求值里加判断，随后发现截图与解冻各有一份
> 同样的缺陷。裸写 4 遍 `attach/detach` 本身就是 bug 的来源，所以改成单一入口。

**回归测试**：`relay/test-cdp-session-isolation.mjs`（17 项，已接入 `test:e2e`）。
它用**本地 CSP 页面**（响应头带 `script-src 'self'`）确定性复现，不依赖外网站点与登录态。
已验证测试**真的会红**：在旧代码上 11 项失败，修后 17 项全绿。

### 2. 测试套件不再「挂死」（v0.3.11 引入的回归）

`relay/test.js` 第 6 步发一个 `agent.stop` 事件来验证订阅，第 7 步接着发 `page.click`（写操作）。
但 v0.3.11 把 `agent.stop` 从「通知」改成了**强制状态**（host 会拦后续写操作），于是第 7 步
在 host 入口就被拒掉、**不再转发给扩展**，而测试在 `await extWs.next()` 等一个永不到来的帧。

实测：在干净 HEAD 上 **3/3 挂死**（`timeout` 才能收掉）。

> 为什么没人发现：v0.3.11 的提交里没有跑完整 `npm test`（或只跑了离线层），
> 而「挂住」不会像「失败」那样出现在结果里——它只会让进程停在那里。

修法（两层）：

1. **测试自净**：第 6 步验证完就补发 `agent.resume`，把 host 状态清干净再进第 7 步。
   这也顺便把「停止/恢复事件真的落到 host 状态」这件事验证得更完整。
2. **加挂死看门狗**：默认 60s（`BRIDGE_TEST_TIMEOUT_MS` 可调），超时打印已通过/失败项数
   + 最可能的原因 + host 输出尾部，然后 `exit 1`。
   > **「挂住」比「失败」更糟**：CI 会一直卡着，本地也看不出原因。以后写这类
   > 「等对方回帧」的测试，都应配一个看门狗。

已验证：修后连跑 3/3 通过；把补丁去掉后看门狗会在 15s 内明确报错并指出原因（不再无限挂起）。

### 3. 新增 LinkedIn 子技能 `linkedin/`

`linkedin/SKILL.md` + `linkedin/scripts/lib/linkedin.mjs`（公共层）+ 两个脚本：

- `linkedin/scripts/linkedin-read.mjs`：**只读**读档案（经历/项目/教育/技能/Headline）
- `linkedin/scripts/linkedin-edit.mjs`：改 Headline / About，带 `--dry-run` 与
  「非空字段默认拒绝覆盖」（写公开档案是对外可见动作，不能默认覆盖）

沉淀的是该站**五重叠加的坑**（每条都实测过，且现象都指向错误方向）：

| 坑 | 现象 | 真相 |
|---|---|---|
| 严格 CSP | `EVAL_ERROR` 提到 CSP | 与表达式无关，必须走 CDP 求值 |
| **SDUI 懒渲染** | 页面正常但条目 0 条 | 后台标签页 rAF 被暂停，SDUI 不渲染；需先 `ensureActive` |
| 字段无稳定 id/name | 选择器时灵时不灵 | id 是 React 生成的；按 `aria-label` 定位 |
| About 是 TipTap 富文本 | 找到了但写不进去 | 赋 `innerText` 被 ProseMirror 忽略，必须写 `innerHTML` + `InputEvent` |
| 两种点击语义 | 点了没反应 | 有的按钮只认 `el.click()`，有的只认真实鼠标事件 |

**顺带修掉四个真实缺陷**（都是写这个子技能时实测撞到的）：

- **模板字符串里的 `split('\n')` 会变成真实换行**，生成的 JS 表达式当场断成两行、语法错误。
  实测影响 `fillField` 的富文本分支——**任何多行富文本写入都是坏的**。改用 `JSON.stringify(NL)` 注入。
  > 这与本仓库已记录的「单反斜杠被吃成 `d`」是同一类坑：**模板字符串里写正则/转义符**。
  > 同类地方（`readSection` 的 id 解析）已改用字符串切分，从根上避开转义层。
- **成功 toast 文案是「已成功保存。」**，而 `saveAndVerify` 只匹配「已保存|保存成功」，
  于是把成功当成了校验错误（报 `validation-error`，实际已保存）。现在用宽松判据
  （含「保存」且不含否定词），并支持「弹窗直接关掉」这条成功路径。
- **语言档案 URL 拼出双问号 → 静默回退主档案**。About 的表单路径本身带查询串
  （`?profileFormEntryPoint=GUIDANCE_CARD`），再拼 `?language=en` 就成非法 URL，
  LinkedIn 把后一个参数当成前一个的值（`...GUIDANCE_CARD%3Flanguage%3Den`），
  **不报错、静默返回主档案内容**。实测：英文 About 应为 1576 字符，拼错时拿到 768 字符的中文。
  修法：新增 `withQuery()` 安全合并（已带 `?` 则用 `&`），`gotoForm` 改用它。
  另修 `normalizeSlug` 的顺序 bug（先剥查询串再去尾斜杠，否则 `.../abc/?x=1` 与
  `.../abc` 会得到不同结果，随后又拼 `/` 就出现双斜杠）。

- **`linkedin-edit.mjs` 的参数解析会把旗标当成值**：旧写法 `out.headline = argv[++i]` 遇到
  `--headline --dry-run` 会把 `--dry-run` 当作标题文本——**若该字段为空，就会把字面量
  `--dry-run` 写进公开档案**。`--about --file x.md` 也把 `--file` 当成 About 正文、
  反而读不到文件。现改为：识别已知旗标名，后一个位置是旗标或缺值时报错退出（码 2）。

**回归测试**：`relay/test-linkedin-expr.mjs`（24 项，已接入 `test:unit-all`）。
它用 mock rpc 抓出真正会发给页面的表达式，用解析器逐个验证语法——模板字符串转义类错误
在真实使用中表现为「脚本报语法错但看起来莫名其妙」，用解析器断言能在毫秒内定位。
已验证测试**真的会红**：把 `split(JSON.stringify(NL))` 改回 `split('\n')` 后，
`fillField` 与 `fillHeadline` 两项立即失败。

> 该子技能**不含任何个人数据**：档案 URL 由调用方传入，示例用占位符。

## 0.3.11：五项加固（token fail-closed · 真停止 · 预算与取消 · 错误契约 · WS 分片）

这一版修的是**安全与可信度**问题，不是功能：五个缺陷都属于「界面/返回值说的是一回事，实际做的是另一回事」。
每一项都有可稳定复现的回归测试。

### 1. token 读不到时不再降级成固定密码（安全）

`relay/host.js` 的 `ensureToken()` 以前在捕获异常后 `return "dev"`。于是目录权限异常 / 磁盘满 /
只读挂载时，桥会用一个**写死在源码里**的密码启动。

现在：读不到就**拒绝启动**（`exit 2`），输出 `code=TOKEN_UNAVAILABLE` + 一行可照做的「修复:」；
顺带回读校验（防「writeFileSync 看似成功但没落盘」）、权限收紧到 600、空文件重新生成并告警。
逃生通道：`AGENT_BRIDGE_TOKEN` 环境变量（或 `--token`，会告警因为会出现在 `ps` 里）。

> 「只监听 127.0.0.1」不是省略这层保护的理由：本机任意进程都能访问该端口，
> 恶意页面也能借 DNS rebinding 打到 127.0.0.1。

### 2. 「停止 Agent」现在是真的停止

以前按钮只发一条 `agent.stop` 事件，host 只做 `broadcastToAgent` —— 不清队列、不拦后续 RPC。
界面显示「已放开」，而排队的点击/输入照跑；通过 HTTP 调用、没订阅事件的 Agent 完全不知情。

现在停止是一个**可查询、会拒绝新写操作、会取消未派发请求**的状态，三层各管一段：
host 拦「还没派发的」· 扩展拦「已派发未落页面的」· content.js 拦「多步动作的下一步」。
新增 `POST /agent/stop` · `/agent/resume` · RPC `agent.stopStatus`，`/status` 也暴露 `stopped`。

边界（重要，否则比不停更糟）：**只拦写操作**。只读、释放类（`tabs.close`/`session.detach`）、
恢复类（`session.attach`/`agent.resume`）都不拦；`session.send` 按 CDP method 细分（`Input.*` 拦、
`Runtime.*` 放行）。页面按钮只停**它所在的那个 tab**（用 `sender.tab.id`），不再全机停。
已完成的页面动作无法撤销，响应里会如实说明。

### 3. 排队计入超时；派发前重查；客户端断开即取消

以前超时计时器在请求**真正发出后**才启动，租约也只在入队前查一次。
隔离复现：`timeoutMs:10` 的请求排队 52ms 后仍被发送——对发消息/提交表单，这就是
「调用方以为失败」变成「稍后偷偷执行」。

现在：入口生成统一预算（排队 + 等重连 + 执行共用），排队超时立即失败（`details.phase`）；
**派发前重新校验**取消/停止/租约/预算；**客户端断开即取消**尚未派发的请求。

### 4. 错误契约统一：不再丢 details，不再把超时报成连接失败

- `agent/client.mjs` 重建 `BridgeError` 时只留 `code`/`message`，`SCROLL_NO_GROWTH` 的
  `recoverable` 到了调用方就没了；且本地超时被包成 `CONNECTION_REFUSED`（把人引向「请启动桥」）。
  现在：`details` + `detail(key)` 全链路透传，超时用专属 `BridgeTimeoutError`，
  并区分 `TIMEOUT` / `CONNECTION_REFUSED` / `UNAUTHORIZED` / `NOT_FOUND` / `AGENT_STOPPED` / 业务错误。
- WS `/bridge` 出口补上 `details`（以前只有 HTTP 出口带）。
- 顺带修一个真 bug：`_request` 写成 `method === "/rpc" ? "POST" : "GET"`，于是
  `register` / `claimTab` / `releaseTab` 全部以 GET 发出 → host 只注册了 POST → 调用方拿到 404。

### 5. 自写 WebSocket 不再错处理分片消息

`relay/ws-server.js` 对 text 与 continuation 帧都立即 `emit("message")`，没等 FIN。
一条分片 JSON 被拆成 `{"ok":` 和 `true}`，两边 `JSON.parse` 失败后**静默忽略**——
表现为「扩展连上了但从不响应」，日志里什么也没有。

现在按 FIN 组装，并补齐协议加固：未 mask → 1002、RSV 非 0 → 1002、未知 opcode → 1002、
控制帧不得分片/超 125 字节、消息与分片数上限（超限以 1009 提前拒绝，不先攒内存）、
发送侧背压记账（慢消费者 1013 断开，不再忽略 `write()` 返回值）。

> 对写测试的人：测试里手写的 WS 客户端**必须带 mask**。真实 Chrome 一直带，
> 只有手写实现会漏——那正是应该被拒绝的对象。本仓库两个手写客户端已补上。

### 工程：测试分层

`npm test` 以前把真实浏览器测试混在默认链里。现在拆开：

```bash
cd relay && npm run test:unit-all   # 纯离线（含新增回归），不碰用户浏览器
cd relay && npm run test:e2e        # 真机 E2E（需要扩展已加载、host 存活）
```

新增回归：`test-hardening.mjs`（32 项：token fail-closed / 预算与取消 / 停止闸门 / details 契约 /
WS 分片与背压 / host-扩展副作用清单契约）、`test-content-stop.mjs`（11 项：用桩化 chrome+DOM
直接驱动 content.js 与 indicator.js 的停止闸门）、`test-stop-e2e.mjs`（12 项真机：
页面按钮 → 扩展 → host → 后续 RPC 被拦 → 恢复放行）。

> `test-hardening.mjs` 已接入 `test:unit-all`；`test-stop-e2e.mjs` 属 `test:e2e`（需要真实浏览器）。

## 未发布：定位收紧（description 与路由语义）

**变更**：把本 skill 从「普通工具抓不到时的降级兜底」改为「浏览器任务的默认入口」。

改了什么：

1. `SKILL.md` 的 `description`：删掉旧的退让条款（「若任务不需要真实登录态、通用搜索/抓取工具即可完成，优先用通用工具」）与「什么时候不用它」一节；新增明确口径——**凡是要在浏览器里真正操作网页就一律用本 skill**，包括看起来普通的「打开某网址看内容」「搜一下这个站」。
2. 「什么时候必须用它（从 agent-browser 降级）」→「反爬站点是本 skill 的主场，不是切换来的」：反爬站点从一开始就走本 skill，不要先用无头工具试一轮。
3. `description` 开头新增**反 curl 硬规则**（「拿到 http(s) 链接要读内容时默认用本技能，不要先试 curl / wget / WebFetch 赌它是静态页」），并在 `SKILL.md` 正文（「路径约定」之后）新增小节「**最常犯的错：拿到网址先 `curl`**」：给出症状（`body` 可见文本为 0、HTTP 200 不报错、只有 `index-<hash>.js` 构建产物）、判断信号、正确动作（`tabs.resolve` + `page.evaluate`），以及 curl 唯一合法的场景（明确返回 JSON / XML / 纯文本的 API 或静态文件）。`README.md` 里反向的「什么时候别用它」一句同步改写。

为什么改：旧描述里「抓不到再切过来」的降级语义，叠加 `agent-browser` skill 的 `Prefer agent-browser over any built-in browser automation` 明示优先级，导致用户不点名时 Agent 从不主动加载本 skill。触发只由 `description` 决定（pi 只把 `name` + `description` 放进 system prompt），**skill 名字与目录名不影响触发**，因此本次不改名（改名还会断掉 clawhub 已发布的 `--slug agent-browser-bridge`）。

### 为什么单为「先 curl」加一段（真实事故）

2026-09-17 06:50，一个 Agent 收到 `https://www.workbuddy.ai/pricing/`，第一反应是 `curl -sL`，拿回 13 KB 空壳 HTML（`body` 可见文本长度 **0**，只有 `index-*.js` 引用），于是转去下载 JS bundle、`grep` 字符串、抓 `/docs` 下的 `.lean.js`，绕了 4 分钟才拼出答案。

两个关键事实：

- **描述已经在 06:43 改过了**（本次变更第 1、2 条），该会话 06:49 启动，仍走了 curl。所以「把描述改成默认入口」**不足以**解决这个问题——旧措辞只反驳了「去用别的浏览器工具」，**从没反驳过「用 curl 扒 HTML」**，Agent 于是自认为「这只是读一个公开页面，不算浏览器任务」。新描述把 curl 点名，并给出「判断口径：只要任务是从某个网址拿到内容，就是本技能」。
- **同一台机器上跑一次就是 1 次调用**：`tabs.resolve` 复用了已打开的 tab，`page.evaluate("document.body.innerText")` 一次返回 1252 字符，直接包含「无限代码补全」「5,000 次代码补全」等全部定价文案。curl 路线 4 分钟且结论不稳，桥路线一次调用且拿到的是渲染后真值。

配套改动（在本仓库之外）：

- `~/.pi/agent/AGENTS.md`：**新增**反 curl 路由行（「拿到链接要读内容 / 要在网页上操作 → 直接走 agent-browser-bridge，不要先 curl / wget / WebFetch」）。
  > 订正：本文件早先版本的这一条写成「路由行从『浏览器抓不到内容 → 切 agent-browser-bridge』**改为**『凡是要在浏览器里操作网页 → 直接走 agent-browser-bridge』」，但实际核验后发现**当时并未写入**（AGENTS.md 里当时根本没有任何 browser/bridge 路由行）。本次已真正补上。
- 删除 `~/.agents/skills/real-user-feedback/`（已核验确实不存在；其 UGC 平台清单与 `xhs` 子技能重叠，且内置「抓不到就切 bridge」的降级表述）。

> 本节只描述文档定位变更，不含 RPC / 扩展行为变更，因此未改 `extension/manifest.json` 版本号。

## 当前版本

**版本号是统一的**：host 与扩展同属一个发布单元，共用 `extension/manifest.json` 里的版本。
`relay/host.js` 启动时读该文件，所以 `/status` 的 `version` 就是扩展版本，不需要区分两个字段。

| 部件 | 版本 | 版本号来源 |
|---|---|---|
| 扩展 | **0.3.14** | `extension/manifest.json`（唯一事实来源） |
| 本地桥 host | 同扩展 | 启动时读 `extension/manifest.json`（不单独维护） |
| 本 skill | 随 ClawHub 发布 | — |

> 历史提醒：0.3.9 之前 host 自己维护了一个 `VERSION = "0.3.0"` 且从不跟着涨，导致 `/status`
> 报的版本与实际能力对不上（agent 会误判 `tabs.resolve` 等能力不可用）。现已改为单一来源。

## 版本号维护（改代码的人看这里）

**版本号只有一个事实来源：`extension/manifest.json` 的 `version`。**

`relay/host.js` 启动时读它，所以 `/status` 的 `version` 就是扩展版本，不存在「两个版本号」。

改完代码、准备发版时：

```bash
# 1. 改 manifest.json 的 version（唯一需要手改的地方）
# 2. 让其它位置自动跟上（README 发布命令、package.json、本文件的当前版本表）
node relay/version-guard.js --fix
# 3. 确认一致（也作为 npm test 的第一步自动跑）
node relay/version-guard.js
```

`version-guard` 会检查这三处是否与 manifest 一致，不一致就报错（`--fix` 可自动修正）。
它**不会**动「某能力从 vX 开始支持」这类历史标注——那些描述的是过去，改了反而错。

> 为什么需要这个工具：0.3.9 之前 host 自己维护 `VERSION = "0.3.0"` 且从不跟着涨，
> 导致 agent 从 `/status` 读到 0.3.0、误判 `tabs.resolve` 等能力不可用。手工维护多处版本号必然漏改。

## 更新步骤（让用户执行，或经用户同意后代跑）

```bash
cd <仓库根> && git pull                     # 1. 拉最新代码
bash relay/install-host.sh <扩展ID>          # 2. 重注册 native host（扩展 ID 变了必须重跑）
# 3. 重载扩展（二选一）：
node agent/cli.mjs reload-ext                #    自动重载，约 2s，自动等重连
# 或：chrome://extensions 点扩展卡片上的刷新按钮
node agent/cli.mjs verify                    # 4. 确认版本
```

注意：

- **扩展 ID 在重新「加载已解压的扩展程序」后会变**，变了必须重跑 `install-host.sh`，否则 native 通道连不上（host 的 `allowed_origins` 里写的是旧 ID）。
- `reload-ext` 的 HTTP 响应会丢失（扩展 reload 连带关闭 native channel，host 进程退出后由 Chrome 重新拉起），**这是预期行为**，CLI 已改为轮询 `/status` 确认重连。
- 重载后**旧标签页的 content script 会失效**，对这些 tab 先跑 `tabs.prepare` 重新注入，或让用户刷新页面。
- 改 `relay/host.js` 要重启 host：`pkill -f "chrome-agent-bridge/relay/host.js"`（Chrome 会按需重新拉起）。

## 版本历史

### 0.3.10 — 2026-09-17

**修掉最大的失败源：后台 tab 渲染器被冻结后所有 `page.*` / `tabs.prepare` 都超时。**

host.log 全量统计里 `PAGE_CONTEXT_TIMEOUT` 433 次居首，`tabs.prepare` 失败率 **33.9%**，
耗时整齐卡在 13s / 26s。之前被当成「静默模式的代价」写在 KNOWN_ISSUES 里让 Agent 忍着，
实际是 Chrome 的 Memory Saver / 高能效模式冻结了后台 tab 的渲染器——冻结后 `chrome.scripting.*`
**全部不可用**，而 CDP 通道完好（实测对照：scripting 13s 后报错，CDP `Runtime.evaluate` 32ms 正常；
`Page.setWebLifecycleState` 就是 Chrome 自己冻结后台 tab 用的协议）。

- **`ensureInjected` 自动解冻自愈**：遇到 `PAGE_CONTEXT_TIMEOUT` 时 CDP attach →
  `Page.setWebLifecycleState: active` → 重试一次。实测从「13s 报错」变成「13s + 0.5s 后成功」，
  之后恢复毫秒级（回归测试 8/8）。
  - 限流用**滑动窗口**（60s 内最多 5 次），不是「成功后冷却」——Chrome 可能刚解冻又冻回去，
    成功即长冷却会让这种情况退化成不自愈。解冻失败（用户开着 DevTools 等）有 5s 退避。
  - 冻结 ≠ 丢弃：`discarded` 的 tab 渲染器已卸载，CDP 也救不回来，仍报 `TAB_DISCARDED`。
- **`indicatorCall` 不再被 await**：indicator 只是视觉提示，但在冻结/受限页上它自己要先撞 3s
  PING 超时；串在每个 `page.*` 前面等于白加 3s 延迟。现改 fire-and-forget，失败不影响主 RPC。
- **`tabs.resolve` 的候选探测跳过自愈**（`ensureInjected(..., {noRecover:true})`）：
  它的语义是「找个能用的 tab」，不是「救活这个 tab」——一个真被冻结的候选不值得为它
  挂调试器 + 等 13s，直接换下一个 / 落到新建。
- **`lib/bridge.mjs` 超时错误码不再伪装成 `CONNECTION_REFUSED`**：`req.destroy(err)` 触发的
  `error` 事件会把我们自己的 `BridgeRpcError("TIMEOUT")` 也包装一遍，于是「页面上下文超时」
  被报成「无法连接本地桥」，把人引向错误排查方向。现在 `instanceof BridgeRpcError` 原样透传。
- 新增回归测试 `relay/test-freeze-recovery.mjs`（属 `npm run test:e2e` 真机层）：用 CDP 手动冻结渲染器复现，
  **不依赖等它自然冻结**，覆盖自愈成功、自愈后恢复毫秒级、二次冻结仍能自愈、真·连不上仍报
  `CONNECTION_REFUSED`。
- 修掉 `relay/test-tab-health.mjs` 的一个假红：它写死 `https://example.com/` 并断言「withPage
  结束后 tab 已关闭」，但 `tabs.resolve` 默认按 **host** 匹配，环境里已有 example.com tab 时会
  复用而不新建，于是复用时不关（正确行为）却断言失败。改用唯一 URL + `match:"exact"`。

**仍成立的限制**：解冻只恢复脚本执行能力，不恢复前台时序——被冻过的页面里 rAF / 渲染节奏
仍按后台走，依赖 `requestAnimationFrame` 的懒加载、瀑布流可能不推进。需要前台时序仍要显式
`tabs.activate`（代价是抢一次焦点）。

**仍成立的限制**：解冻只恢复脚本执行能力，不恢复前台时序——被冻过的页面里 rAF / 渲染节奏
仍按后台走，依赖 `requestAnimationFrame` 的懒加载、瀑布流可能不推进。
**这一点已由下面新增的 `page.ensureActive` 解决**。

回归测试：`node relay/test-freeze-recovery.mjs`（用 CDP 手动冻结渲染器复现，不依赖等它自然冻结）。

### 新增：`page.ensureActive` / `page.restoreActive` —— 后台 tab 渲染被暂停时按需激活

**另一个更隐蔽的问题**：Chrome 对后台标签页把 `requestAnimationFrame` **完全暂停**
（实测 2s 内 **0 帧**，活动页 60 帧）、`document.visibilityState="hidden"`。
依赖 rAF / IntersectionObserver 的懒加载、瀑布流、无限滚动在后台**永不推进**——
滚动指令返回 `{ok:true}` 但页面高度不变，调用方拿到空列表还以为是站点改版。
这是「暂停」不是「节流」，**加长超时完全没用**。

- `page.ensureActive { tabId, restoreAfterMs? }`：**只在必要时**（`document.hidden`）临时激活。
  - **只切标签页、不聚焦窗口**（不调 `chrome.windows.update({focused:true})`）。实测单独
    `chrome.tabs.update({active:true})` 就能恢复 rAF（Chrome 不在前台时同样有效），
    **用户正在别的应用里工作时不会被弹到 Chrome**。
  - **用完自动还原**：默认 20s 无操作后把活动标签页还给用户原来那个；长流程中每次 `page.*`
    调用都会续期，不会在滚动循环中途抢走前台。`restoreAfterMs` 可调。
  - 边界：用户自己切走了 → 不抢；原标签页被关 → 退到同窗口其它页；`tabs.close` 前先归还。
  - 返回 `{ activated, alreadyRendering, willRestoreTo, note }`。
- `page.restoreActive { tabId }`：立刻归还，不等空闲计时器。

**为什么不做成自动的**：自动激活会在长流程里反复抢用户前台。所以只提供能力，
由 Agent 根据「是否真的需要渲染」决定。

**已试过但不行的方案**：CDP `Emulation.setFocusEmulationEnabled` 确实能把 rAF 拉起来，
但它 **detach 或页面导航后立即失效**（实测：detach 后 raf 回到 0），而 detach 是每次 RPC 收尾
都会做的事，所以不能用它代替真激活。

### 新增：`page.scroll { checked: true }` —— 滚动推进检测（防假成功）

后台页里 `window.scrollBy` **仍然生效**（实测滚动位置会变），所以「滚动成功」不能作为
「内容加载了」的依据。`checked` 会回读页面高度与滚动位置：

- 推进了：返回 `{ checked, grew, moved, atBottom, heightBefore, heightAfter, yBefore, yAfter, wasHidden }`。
- 滚动生效但没加载出新内容（且声明了 `expectGrowth:true`）→ 抛 `SCROLL_NO_GROWTH`；
  视口完全没动 → 抛 `SCROLL_STALLED`。
- 到底了收尾：`allowNoProgress:true`，不再报错。内容不满一屏也不会报错。
- **实现时踩过的坑**：一开始因为 `atBottom=true` 就放过不报——但懒加载的哨兵元素本来就在
  列表末尾，「到底部」正是应该触发加载的位置，用 atBottom 做例外等于把信号关掉。
  现在 `atBottom` 只作为字段返回，供调用方区分「真到底了」与「卡住了」。
- 老写法 `page.scroll`（不带 `checked`）行为不变，不会突然开始报错。
- 客户端封装：`rpc.scrollChecked(tabId, opts)`。

### 新增：结构化错误 `details` + `recoverable` 信号 —— 让 Agent 能判断该不该激活

**设计决定：不在检测到卡住时自动激活**——自动激活会在长流程里反复抢用户前台。
改为「提供可编程判断的信号」，由 Agent 决定。但光有信号不够：

**修了一个让信号拿不到的 bug**：扩展抛的错误里本来带了 `atBottom` / `wasHidden`，
但三层链路（扩展 `error: {code, message}` → host 重建 error 对象 → `BridgeRpcError`）
**只保留 code/message，details 被静默丢弃**，Agent 只能去解析 message 文本才能判断。
现在：

- 扩展：`errorPayload()` 统一出口 + `errorDetails()` 白名单透传字段
  （`atBottom/wasHidden/grew/moved/heightBefore/...`）。
  白名单而非全量：避免把任意对象（可能含页面内容）带出去。
- host：`rejectPending` 与 HTTP 出口都补上 `details`（重建对象时容易漏，已加注释）。
- `BridgeRpcError` 新增 `details` 字段与 `detail(key)` 便捷方法。

`recoverable` 字段就是「激活能不能解决」的答案：

| 情况 | `recoverable` | 该怎么办 |
|---|---|---|
| 后台标签页、懒加载没触发 | `true` | 值得 `ensureActive` 后重试 |
| 前台也没动（选择器/容器不可滚） | `false` | **激活没用**，别白白打扰用户 |
| 已到底（`atBottom:true`） | `false` | 真到底了，用 `allowNoProgress` 收尾 |

### 新增：`scrollLoad` —— 一键完成「判断 + 必要时激活 + 重试」

```js
await rpc.scrollLoad(tabId, { y: 99999, expectGrowth: true });
// 内部：先直接滚 → 只有 recoverable===true 才 ensureActive → 重试一次
// 返回带 { borrowed, activated, attempts, firstError }；recoverable=false 时原样抛出
```

这样 Agent 不写判断也能用，且不会在无关场景（选择器写错、真到底）打扰用户前台。

新增回归测试 `relay/test-foreground-rendering.mjs`（属 `npm run test:e2e` 真机层）：本地起一个靠
**IntersectionObserver 懒加载**的页面确定性复现（不依赖外网站点、不需要登录、不会因站点改版失效），
覆盖：后台 rAF=0、后台滚动不加载 → 报 `SCROLL_NO_GROWTH`、`ensureActive` 后 rAF 恢复且
懒加载推进、幂等（已在渲染不重复激活）、显式与空闲自动还原、
**details 三层链路未丢**、`scrollLoad` 自动判断、**前台没动时 `recoverable=false`（不该激活）**。

### 0.3.9 — 2026-09-16

- **新增 `tabs.resolve`**：打开网址的首选入口。只复用**非活动**的同类 tab（排除聚焦窗口的活动页、pinned、discarded），没有就 `active:false` 静默新开后台 tab。
  - 解决的问题：过去脚本的 `tabs.find(t => t.url.includes(站点)) || tabs.find(t => t.active)` 有个坏 fallback——找不到匹配 tab 就拿用户当前正在看的页面去 `page.navigate`，**直接把人家看的页面顶掉**。
  - **自己写脚本时也不要再写「fallback 到 active tab」这句。**
  - 旧版返回 `UNKNOWN_METHOD` 时降级：`tabs.create({url, active:false})` 新开后台 tab（宁可多开一个，也不要动用户当前页）。

### 0.3.8 — 2026-09-14

- 新增 `extension.reload` RPC 与 `node agent/cli.mjs reload-ext`：免手工去 chrome://extensions 点刷新，改完扩展自己重载。
- 新增 `node agent/cli.mjs verify` 回归自检（15 项）。
- host 侧未捕获异常加固。

### 0.3.6

- **修掉 `sendMessage` 静默挂起**：`chrome.tabs.sendMessage` 对「content script 不存在」**不会 reject，会一直挂起**，曾导致上百次 TIMEOUT（多数在 `page.evaluate`）。现 ping 3s / 注入 10s / 求值 12s 全部包超时。
  - 若发现每个调用都要等几十秒才报 `PAGE_CONTEXT_TIMEOUT`，说明扩展版本过旧（0.3.6 以前）。

### 0.3.3

- `page.waitForReady` / `page.waitForUrl` / `page.waitForSelector` 增强等待（取代固定 sleep）。
- `page.evaluate` 在严格 CSP / Trusted Types 站点被拦时，**自动走 CDP `Runtime.evaluate` 兜底**重试一次（返回体带 `via:"cdp"`）。
- CDP 会话状态跟踪：重复 attach 返回 `{already:true}`；未 attach 就 send 报 `SESSION_NOT_ATTACHED`；`onDetach` 自动清理。
- 导航超时给 tab 打「上下文失效」标记（30s TTL），后续 evaluate 立即 `PAGE_CONTEXT_TIMEOUT` 快速失败。

### 0.3.2

- 「Agent 已放开」提示改为过场态，展示约 2.6s 后淡出，不再常驻页面右上角。

### 0.3.1

- **「接管中」滞留三层自愈**：indicator 按需补注入（幂等）、后台 15s 无控制请求自动撤销、扩展启动/更新时清扫残留标题。
  - 旧版现象：标签标题/badge 停在「● Agent 接管中」，因为扩展 reload 会销毁旧标签页的 indicator 实例，或页面被冻结时计时器不跑。

### 0.3.0

- **静默模式**：读/写/点击/截图默认不抢焦点、不切激活 tab。新增 `tabs.prepare`（注入 + 防后台冻结）代替 `tabs.activate`。
- 截图改 CDP 静默，后台 tab 也能截；CDP 失败不再自动激活窗口（报 `SCREENSHOT_FAILED`），需要时显式 `allowActivate:true` 或 `page.activateAndShot`。

### 0.2.0

- 首个开源版本。

---

## 版本不匹配的典型症状（快速归因）

| 症状 | 需要的最低版本 |
|---|---|
| 每个 `page.evaluate` 都卡满超时才报 `PAGE_CONTEXT_TIMEOUT` | 0.3.6 |
| `tabs.prepare` / `page.*` 反复卡 13s 报 `PAGE_CONTEXT_TIMEOUT`（渲染器被冻结，需自动自愈） | **0.3.10** |
| 报错说「无法连接本地桥」但 `/status` 能返回 JSON（超时错误码被伪装） | **0.3.10** |
| 「● Agent 接管中」标题/badge 不消失 | 0.3.1 |
| `tabs.prepare` 返回 `UNKNOWN_METHOD` | 0.3.0 |
| `page.waitForReady` 返回 `UNKNOWN_METHOD` | 0.3.3 |
| `page.read` / `page.clickReal` / `page.typeReal` / `page.uploadFile` / `page.evalCdp` 返回 `UNKNOWN_METHOD` | **0.3.13** |
| `tabs.resolve` 返回 `UNKNOWN_METHOD` | 0.3.9 |
| `/status` 没有 `browser` 字段，或 `BRIDGE_BROWSER=firefox` 连不上 8779 | **0.3.14** |
| chatgpt.com / github.com 上 `page.evaluate` 被 CSP 拦 | 0.3.3 |

`UNKNOWN_METHOD` 一律是「扩展版本不够新」的信号——不是站点问题，也不是脚本 bug。
