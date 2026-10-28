# AGENTS.md — Agent Browser Bridge 开发规范

本文件给在本仓库内工作的 Agent 开发者阅读，尤其是**修改 `skills/agent-browser-bridge/` 下的任何 skill 时**必须遵守。

## 最重要的规则：Skill 必须自包含

`skills/agent-browser-bridge/` 会被**其他 Agent 以链接 / 拷贝方式引用**，对方只能拿到 skill 目录本身（`SKILL.md`、`xhs/`、`debug/`、`scripts/`），**拿不到仓库根的文件**（`agent/`、`extension/`、`relay/` 等）。

因此编写 / 修改任何 skill 文档时：

1. **关键代码直接贴进文档**：RPC 调用示例、JS 表达式、返回数据格式、选择器，都要在 `SKILL.md` 里给出可复制的内容，而不是"见 `agent/cli.mjs`"或"参考 `extension/background.js`"。
2. **引用的文件必须位于 skill 目录内**：文档里出现"读取 xxx 脚本 / 工具"时，该文件必须放在 `skills/agent-browser-bridge/scripts/` 下（scripts/ 是 skill 的一部分，会随 skill 一起被链接），且文档要贴出核心用法与参数。
3. **禁止依赖仓库根文件**：不要把 `agent/cli.mjs`、`extension/*` 等仓库根文件当作唯一入口或必读文件。CLI 命令可以出现，但必须标注为"本机仓库的便利命令"，同时给出**等价的 RPC 代码示例**作为自包含路径。
4. **禁止机器特定绝对路径**：不写 `/Users/<user>/...` 之类路径。skill 内文件的路径用相对 skill 目录的写法（如 `scripts/browser-debug.mjs`）；仓库根的路径用占位符（如 `<chrome-agent-bridge 仓库根>`）。
5. **新增能力时：插件实现 + skill 文档双写**：给插件新增 RPC（如 `page.inspect`）时，skill 文档必须包含——调用方式（RPC / HTTP）、参数表、返回结构示例、一个最小可用示例。写完自检：**假设对方只有 skill 目录，能否照文档独立完成操作？** 不能，就补代码。
6. **新增 RPC 必须登记 `relay/methods.js`**：host 按这张表判定 `UNKNOWN_METHOD`，不登记的方法到不了扩展。登记后运行
   `node relay/gen-rpc-doc.js` 重新生成 `skills/agent-browser-bridge/reference/rpc.md`；`test-methods.mjs` 对照 `background.js` 的 `case` 与 host 本地处理的方法检查一致性，`gen-rpc-doc.js --check` 检查文档是否过期，两者都在 `test:unit-all` 里。参数说明、返回示例写进 `reference/core.md`。

### 四个调用入口各管什么

| 入口 | 位置 | 改它要注意 |
|---|---|---|
| `scripts/lib/bridge.mjs` | skill 内 | 其余三个入口的底座。只依赖 Node 内置模块；不为低于 `MIN_BRIDGE_VERSION` 的扩展做降级 |
| `scripts/bb.mjs` | skill 内 | Agent 用的命令行。新命令加在这里，不要加到 `agent/cli.mjs` |
| `agent/cli.mjs` | 仓库根 | 只放开发命令（`reload-ext` / `verify` / `cursor` / `listen`），其余转交 `bb.mjs` |
| `mcp/server.mjs` | 仓库根 | MCP 工具层，依赖 `@modelcontextprotocol/sdk`（`mcp/` 下单独 `npm install`）。回归：`cd mcp && npm test`（真机） |

**`unwrap()` 踩过的坑**：曾用「对象含 `value` 键」判定 CDP RemoteObject，于是 `page.typeReal` 的返回 `{ok, value, verified, delta}` 被剥成 value 字符串，`rpc.typeReal()` 的 `verified` 一直是 `undefined`。现在要求形状完全符合 RemoteObject（有 `type`，字段都在 RemoteObject 字段集内）。新 RPC 的返回对象若同时含 `type` 与 `value`，要先想清楚会不会被误判。

## 开发循环：改完怎么生效

改代码后**不要让用户去点 chrome://extensions 的刷新按钮**——自己重载。

```bash
export BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token)
node agent/cli.mjs reload-ext        # 扩展自重载，约 2s，自动等重连
node agent/cli.mjs verify            # 回归自检，改完跑一次（12 项，全绿才算完）
```

- 原理：RPC `extension.reload` → 扩展**先回响应、再**延迟调 `chrome.runtime.reload()`。顺序不能反——自重载会立即终止自身执行，先回响应否则调用方永远收不到结果。
- **响应必然丢失，属正常**：扩展 reload 会连带关闭 native channel，host 进程随之退出并由 Chrome 重新拉起，该次 HTTP 响应收不到。CLI 已改由轮询 `/status` 确认重连；自己写脚本时照此处理，别把丢响应当失败。
- 改 `relay/host.js` 要重启 host（Chrome 按需重新拉起，约 1s）：`pkill -f "chrome-agent-bridge/relay/host.js"`。这条会同时结束 Chrome 与 Firefox 的 host；只能用默认的 SIGTERM，不要 `-9`（原因见下文「Firefox 版」）。
- 兜底：自重载失效时才到 chrome://extensions 手工点刷新。

### 怎么确认新代码真的加载了

**别假设，用可观测事实判定。** 依据是错误码从 `UNKNOWN_METHOD` 变成别的——目标 tab 可能本身有问题，但方法被认出来就证明代码是新的：

```bash
# 调一个只有新代码才注册的方法
curl -s -X POST http://127.0.0.1:8778/rpc -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"method":"page.waitForReady","params":{"tabId":<id>,"timeoutMs":5000},"timeoutMs":10000}'
# UNKNOWN_METHOD => 仍是旧代码；TIMEOUT / 业务错误 => 新代码已加载
```

两个易踩的坑：

- **版本号现在统一了**：`relay/host.js` 启动时读 `extension/manifest.json`，`/status` 的 `version` 即扩展版本（不再有独立的 host 版本号）。它仍是**进程启动时的快照**，所以改 `manifest.json` 后要重启 host 才看得到新值（`pkill -f "chrome-agent-bridge/relay/host.js"`）。**判重载以方法调用为准**，不要只看版本号。
- 重载后**旧标签页会失效**（content script 实例已销毁），操作报 `PAGE_CONTEXT_TIMEOUT`。对这些 tab 先 `tabs.prepare` 重新注入，或 `tabs.reload` 刷新页面。

### 排查报错：看 host.log，别看 chrome://extensions

`~/.chrome-agent-bridge/host.log` 是最可靠的报错源（带时间戳 / method / tabId / 耗时 / 错误码，可统计）：

```bash
cd ~/.chrome-agent-bridge
grep -o "code=[A-Z_]*" host.log | sort | uniq -c | sort -rn                             # 报错码分布
grep "code=UNKNOWN_METHOD" host.log | grep -o "method=[a-zA-Z.]*" | sort | uniq -c | sort -rn
grep "code=TIMEOUT" host.log | grep -o "method=[a-zA-Z.]*" | sort | uniq -c | sort -rn
grep "tab=<id>" host.log | grep -E "TIMEOUT|note=dispatch" | head -20                  # 单 tab 时间线
```

chrome://extensions 的 errors 面板只留最近若干条、不能滚动，混着大量预期失败噪音，且它是 `chrome://` 协议——桥既不能注入也不能截图。需要把它文本化时用 macOS Vision OCR（`swiftc` 编译 `VNRecognizeTextRequest`；对 WebUI 多层嵌套区域识别不稳定，仅当无日志可查时用）。

### chrome://extensions 面板怎么看、怎么清空

面板**累积显示、不会自动清空**，也不区分新旧——排查时必须先重置，否则会把历史报错误判成当前问题：

```bash
# 重新导航到该页即重置面板（等价于手动刷新）
curl -s -X POST http://127.0.0.1:8778/rpc -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"method":"page.navigate","params":{"tabId":<extensionsTabId>,"url":"chrome://extensions/?errors=<扩展ID>"},"timeoutMs":15000}'
```

然后**只触发一次**待测调用，再看面板新增了什么——这样才能确定归因。面板是 `chrome://` 协议，桥不能注入也不能截图（`session.attach` 报 `Cannot access a chrome:// URL`），只能靠 OCR 文本化。

### 扩展 console 为什么在 host.log 里查不到

host.log 只记 host 侧的 RPC 收发，**不含扩展内部的 `console.error`**。后者只出现在 chrome://extensions 面板。Chrome 的 `~/Library/Application Support/Google/Chrome/Default/LOG` 在没开 `--enable-logging` 时是空文件，指望不上。所以看扩展侧报错只有两条路：面板（+OCR），或主动把日志桥接出来。

### 历史坑：`sendMessage` 会静默挂起

`chrome.tabs.sendMessage` 对「content script 不存在」**不会 reject，会一直挂起**——曾导致 201 次 TIMEOUT（110 次在 `page.evaluate`），一个坏 tab 能把整条流程拖死。

凡是 `sendMessage` / `executeScript` 都必须包超时（现 ping 3s / 注入 10s / 求值 12s）。`indicatorCall` 是每个 `page.*` 的前置步骤，也曾因此成为卡点。

### 历史坑：Chrome 原生错误没有 code，会把面板刷红

`chrome.tabs.*` 抛的是原生 Error（如 `No tab with id: 1.`），**没有 code 字段**。此前一律落 `INTERNAL` 并 `console.error`，于是预期内的失败（tab 已关、受限页）把 errors 面板刷满，真正的故障被淹没。

现在有 `normalizeErrCode()`：按消息归一成 `TAB_GONE` / `UNSUPPORTED_URL` / `PAGE_CONTEXT_TIMEOUT` / `DEBUGGER_BUSY`，既让调用方可编程判断，也让预期内失败降级为 `console.warn`（不进面板）。**新增 RPC 抛错时走 `normalizeErrCode(e)`，不要写 `e.code || "INTERNAL"`。**

### 历史坑：token 被二次编码导致 WS 认证失败

现象：WS 握手报 `token=...%25' failed`——尾部的 `%25` 是 `%` 被编码了一次，说明存进 `storage.local` 的 token 本身就是已编码值，`wsUrl()` 再 `encodeURIComponent` 一次就成了双重编码。

修法：`normalizeToken()` 在读取和写入两端都做归一（含 `%xx` 才解码，解码失败保留原值）。**凡是 token 进出配置，都过一遍 `normalizeToken`。**

### 回归自检：`node agent/cli.mjs verify`
改完扩展跑一次，验证各修复项是否生效（脚本在 `agent/verify-bridge.mjs`）。改坏东西能立刻发现，不用等用户反馈。

全量回归分两层（`npm test` = 两层串联，**会跑真实浏览器**）：

```bash
cd relay && npm run test:unit-all   # 纯离线：版本守卫 + 单元 + 各 .mjs 断言，不碰用户浏览器
cd relay && npm run test:e2e        # 真机：需要扩展已加载、host 存活
```

**普通 CI 只跑 `test:unit-all`**——`test:e2e` 依赖用户本机 Chrome 状态（登录态、已装扩展、活动标签页），
在 CI 里必然假红。`test-hardening.mjs` / `test-content-stop.mjs` 属离线层，`test-stop-e2e.mjs` 属真机层。

写这类自检脚本有两条教训（都是我自己踩出来的假红）：

1. **版本号断言写下限，不要写死具体值**。写死 `version === "0.3.4"` 之后每发一次版都得回来改脚本，改漏了就出现「功能正常但测试失败」。改成 `>= 0.3.3`（修复引入的最低版本）即可。
2. **测试要自己保证前置条件**。扩展重载后旧标签页的 content script 会失效，脚本若随机挑一个 http tab 就直接测，会拿到 `TIMEOUT` 假红。正确做法是先对候选 tab 逐个 `tabs.prepare` 探测，取第一个可注入的。
   同理：断言「withPage 结束后 tab 已关闭」时必须用唯一 URL + `match:"exact"`——`tabs.resolve` 默认按 **host** 匹配，环境里已有同域 tab 时会复用而不新建，复用不关（正确行为）却让断言失败。

### 冻结自愈：`ensureInjected` 的 CDP 兜底（v0.3.10）

`chrome.scripting.*` 在**渲染器被冻结**时全部挂到超时（13s），而 CDP 通道完好。这是 host.log 里
最大的失败源（433 次 `PAGE_CONTEXT_TIMEOUT`，`tabs.prepare` 失败率 34%，耗时整齐卡在 13s / 26s）。
Chrome 的 Memory Saver / 高能效模式就是这么冻后台 tab 的。

`ensureInjected` 现在遇 `PAGE_CONTEXT_TIMEOUT` 会 CDP 解冻（`Page.setWebLifecycleState: active`）后重试一次。

**改这块要注意三点**：

1. **限流用滑动窗口，不要用「成功后冷却」**。Chrome 可能刚解冻又冻回去，成功即长冷却会让这种情况退化成不自愈。当前是 60s / 最多 5 次。
2. **冻结 ≠ 丢弃**。`discarded` 的 tab 渲染器已卸载，CDP 救不回来，仍报 `TAB_DISCARDED`。不要在 `tryUnfreezeTab` 里试图处理 discarded。
3. **不是每个入口都该自愈**。`tabs.resolve` 的候选探测走 `ensureInjected(..., {noRecover:true})`——它的语义是「找个能用的 tab」，为一个冻死的候选挂调试器 + 等 13s 不如换下一个。

回归测试：`node relay/test-freeze-recovery.mjs`。它用 CDP 的 `Page.setWebLifecycleState` **手动冻结**
渲染器来复现，不依赖等它自然冻结，所以能稳定跑。改解冻逻辑后先跑它。

排查时可直接用 CDP 确认是不是冻结：`session.attach` + `session.send {method:"Page.setWebLifecycleState",params:{state:"active"}}`，
再发一次原调用——从 13s 报错变成毫秒级成功，就是冻结。

### 渲染暂停：`page.ensureActive`（v0.3.10）

与「冻结」是两件事，不要混：

| | 冻结（Memory Saver） | 渲染暂停（后台 tab） |
|---|---|---|
| 现象 | `chrome.scripting.*` 挂满 13s 才报错 | 脚本能跑，但 rAF=0、懒加载不推进 |
| 影响 | 所有 `page.*` / `tabs.prepare` 失败 | 滚动「成功」但页面高度不变 |
| 处理 | **自动** CDP 解冻重试 | 需 Agent 显式 `page.ensureActive` |

**为什么渲染暂停不自动处理**：自动激活会在长流程里反复抢用户前台（实测后台 tab 的 rAF 是
**0 帧**，活动页 60 帧）。所以只提供能力 + 假成功检测，由 Agent 决定。

**`ensureActive` 的实现要点**（改这块前先读）：

1. **只切标签页，不聚焦窗口**。不要加 `chrome.windows.update({focused:true})`——实测单独
   `chrome.tabs.update({active:true})` 就能恢复 rAF（Chrome 不在前台时同样有效），加上聚焦
   会把用户从别的应用里弹出来，这是这个 API 存在的意义。
2. **用完必须归还**。借前台的记录在 `borrowedActive`，空闲 `BORROW_RESTORE_MS` 后自动还原；
   `touchBorrow` 在每个 `page.*` 调用时续期（否则长流程中途会被抢走前台）。
   计时器用 **per-borrow 的 `restoreMs`**，不是全局常量——我第一版写成全局常量，
   于是 `restoreAfterMs` 参数被静默忽略，测试直接抓到。
3. **用 `document.hidden` 判定而不是 `tab.active`**：非聚焦窗口里的活动标签页 rAF 是正常的
   （实测 hidden=false、rAF=61），那种情况不需要动它。
4. **CDP `Emulation.setFocusEmulationEnabled` 不能用**：它能恢复 rAF，但 **detach 或导航后
   立即失效**，而 detach 是每次 RPC 收尾都会做的事。已实测确认，不要再试。

**滚动检测的语义**：`expectGrowth` = 「这一滚应该加载出新内容」。**不要因为 `atBottom=true`
就跳过报错**——懒加载的哨兵元素本来就在列表末尾，那正是应该触发加载的位置（实现时踩过这个坑，
导致检测形同虚设）。后台场景下 atBottom 不可信（同一位置激活后会加载出更多）。

**设计决定：不做自动激活，但必须让 Agent 能判断**。自动激活会在长流程里反复抢用户前台，
所以只提供信号 + 一键封装。为了让「判断」真的可行，加了 `recoverable` 字段：

| 情况 | `recoverable` | 该怎么办 |
|---|---|---|
| 后台标签页、懒加载没触发 | `true` | 值得 `ensureActive` 后重试 |
| 前台也没动（选择器/容器不可滚） | `false` | **激活没用**，别白白打扰用户 |
| 已到底（`atBottom:true`） | `false` | 用 `allowNoProgress` 收尾 |

**踩过的坑：信号根本传不出去**。扩展抛的错误里本来带了 `atBottom`/`wasHidden`，但三层链路
（扩展 `error:{code,message}` → host 重建 error 对象 → `BridgeRpcError`）**只保留 code/message，
details 被静默丢弃**，Agent 只能解析 message 文本才能判断——等于「让 Agent 自己判断」是句空话。
现在：

- 扩展：`errorPayload()` 统一出口，所有地方（native/ws/bridge.action）都走它，避免再漏。
- host：`rejectPending` 和 HTTP 出口都补上 `details`。**重建错误对象时极易漏掉，改这块要盯住**。
- `BridgeRpcError` 新增 `details` + `detail(key)`。
- 透传用**白名单**（`ERROR_DETAIL_KEYS`），不是全量：避免把任意对象（可能含页面内容）带出去。

回归测试里专门有一条「details 三层链路未丢」——加字段时先想「这一路会不会被丢掉」。

回归测试：`node relay/test-foreground-rendering.mjs`。它本地起一个靠 IntersectionObserver
懒加载的页面确定性复现，**不依赖外网站点**。写这类测试的四个坑（都踩过）：

- 断言前要**等页面自己的探针脚本就位**，不能只 sleep 固定时长——后台标签页的脚本执行会被推迟，
  探针未就位时 `undefined - undefined = NaN`，JSON 序列化后是 `null`，报错信息完全看不懂。
- 测试页内容**必须超过一屏**，否则命中「内容不满一屏无需滚动」的正常分支，造成假红。
- **懒加载是异步的**：不要断言「第一次滚动就必须 grew」，要允许重试几次、只断言「最终能加载出来」。
- **测试跑在用户正在使用的真实浏览器上**，而它会临时借走活动标签页。用户随时可能切标签页，
  「调用前的活动页」在断言时已经变了——**这不是产品 bug**。第一版没做处理，实测 3 次里红 1 次。
  现在所有涉及活动页的断言都是「干扰检测 + 重试」：检测到 `activeNow() !== tabId` 就重试，
  重试耗尽则报 `skip`（不计失败）而不是给出假红。
  > 一般原则：**写针对真实环境的测试，先想「用户同时在操作时会怎样」**。
  > 假红的代价比不测更大——它会训练人忽略红色。

### 后台标签页不处理 CDP 鼠标与按键事件：`TAB_HIDDEN`（v0.3.15）

与「渲染暂停」同源但独立的一条：Chrome 后台标签页（`document.hidden`）里 `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`
约 6s 后返回、页面毫无反应；`Input.insertText` 不受影响。此前 `page.clickReal` 照样回 `ok:true`，属假成功。

- 判定点在 `cdpDeltaBegin` 返回的 `hidden`（content script 读 `document.hidden`），`pageClickReal` 与带 `pressEnter` 的 `pageTypeReal`
  在**改动页面之前**报 `TAB_HIDDEN`（`recoverable:true`）。
- 只拦 Chrome（`!CDP_VIA_HOST`）：Firefox 经 BiDi `input.performActions` 派发，后台标签页可用，`test-firefox-e2e.mjs` 第 6 节覆盖。
- 扩展不自动激活（理由同 `ensureActive`），自动重试放在客户端：`bridge.mjs` 的 `clickReal` / `typeReal` 与 MCP 工具。
- 回归：`node relay/test-agent-ergonomics.mjs` 第 0 节。

`Uncaught (in promise)` 之类的面板报错同理：面板累积显示、不区分新旧，排查前先重新导航重置，再只触发一次待测调用——否则会把历史残留当成新问题。

### 兜底：未捕获的 promise rejection

service worker 里漏网的 rejection 会变成面板上的 `Uncaught (in promise)`，掩盖真实问题。已在启动时注册 `unhandledrejection` 监听统一记录为 warn。新增顶层 promise 时仍要自己 catch，别依赖这个兜底。

### Firefox 版（v0.3.14）

**源码只有一份**。`extension/` 同时是 Chrome 版与 Firefox 版的源码；`relay/build-firefox.js` 只改 manifest
（`service_worker` → `background.scripts`、去掉 `debugger` 权限、加 gecko id），输出到 `dist/firefox/`（gitignore）。
浏览器差异在 `background.js` 里按能力判断：`BROWSER`（端口 8778 / 8779）与 `CDP_VIA_HOST = !chrome.debugger`。
**不要为 Firefox 复制一份扩展代码。**

开发循环（Firefox 加载的是 `dist/firefox/`，改完必须先重新构建）：

```bash
node relay/build-firefox.js
BRIDGE_BROWSER=firefox node agent/cli.mjs reload-ext   # 临时扩展 reload 会从 dist/firefox 重新读入（已实测）
BRIDGE_BROWSER=firefox node agent/cli.mjs verify
node relay/test-firefox-e2e.mjs                         # 真机回归：自己起独立 profile 的 Firefox，跑完关掉
```

host 日志：`~/.chrome-agent-bridge/host-firefox.log`（Chrome 仍是 `host.log`）。

**CDP 的去向**：Firefox 扩展没有 `chrome.debugger`。扩展里的 `dbgAttach / dbgDetach / dbgSend` 在 Firefox 上把调用
经 native 通道反向发给 host（`bidi.attach / bidi.detach / bidi.send`），由 `relay/bidi-cdp.js` 翻译成 WebDriver BiDi。
改这块要注意：

1. **翻译层的报错措辞照抄 chrome.debugger**（`already attached` / `not attached` / `Detached while handling command`）。
   `withBorrowedDebugger`、`sessionAttach`、`sessionSend` 靠正则匹配这些措辞决定会话状态，改了措辞就会出现
   「会话已失效但扩展以为还在」。只有 Firefox 独有的失败带 code：`CDP_UNSUPPORTED`、`BIDI_UNAVAILABLE`。
2. **扩展或 skill 脚本新用了一个 CDP 方法，必须在 `bidi-cdp.js` 加翻译**，否则 `test-bidi-unit.mjs` 的覆盖检查会红。
   不支持的方法报 `CDP_UNSUPPORTED`，不要返回 `{}` 冒充成功（`*.enable` 尤其如此：返回成功会让调用方一直等不来事件）。
3. **返回形状对齐 CDP returnByValue**：Map / Set / Date / Node 按值返回是 `{}`；对象里的 undefined 属性省略；
   异常时 `result` 与 `exceptionDetails.exception` 是同一个对象。改值还原逻辑先跑 `test-bidi-unit.mjs`。
4. **tabId ↔ BiDi context 配对**：两套编号无关。首次 attach 时扩展往 `<html>` 写一次性属性 `data-abb-bidi`，
   host 在各顶层 context 的 sandbox 里读它来配对，结果缓存到 context 销毁（导航不换 context id）。

**踩过的坑（都已实测）**：

- **Firefox 断开 WebSocket 不释放 BiDi 会话**，且同一时间只允许一个会话：断开后再连，`session.new` 一直报
  `Maximum number of active sessions`，按 sessionId 重连也不行，只能重启 Firefox。所以 host 在 stdin 关闭、SIGTERM、
  SIGINT 时都先 `session.end` 再退出（`shutdownAndExit`）；`kill -9` 会让会话残留。`test-firefox-e2e.mjs` 第 8 节专测这条。
- **Firefox 的 `e.stack` 不含「类型: 消息」首行**（Chrome 含），CSP 拦截的措辞也不同（`call to eval() blocked by CSP`）。
  `page.evaluate` 的 CSP 兜底判定曾因此失效，现在注入函数里用 `errText()` 补齐首行。
- **Firefox 对 contenteditable 调 `focus()` 不放置光标**，`execCommand("insertText")` 没有落点、静默不输入。
  `Input.insertText` 的翻译在选区不在焦点元素内时把光标放到末尾。
- **CDP 的 Emulation 覆盖随 detach 失效，BiDi 的 `setViewport` 不会**，翻译层在 detach 时还原。
- **Remote Agent 开启期间 `navigator.webdriver === true`**。这是方案的固有代价，已写进 skill 文档，别试图在桥里掩盖。
- Firefox MV3 后台是事件页，实测有 native 端口与 30s keepalive 时空闲 2 分钟不会被挂起。
- **签名与永久安装**：`relay/sign-firefox.js` 走 AMO unlisted 签名（凭据在 `~/.chrome-agent-bridge/amo-credentials`，600）。
  永久安装用 BiDi `webExtension.install` 的私有参数 `"moz:permanent": true`（`firefox-launch.js --install-xpi`），
  不弹确认框，`<all_urls>` 也一并授予（记录在 profile 的 `extension-preferences.json`，`extensions.json` 的
  `userPermissions.origins` 显示为空是正常的）。`open -a Firefox x.xpi` 会弹确认框，而 Firefox 界面元素不暴露给
  macOS 辅助功能，自动化点不到，别走这条。AMO 不接受重复版本号，重签前先升 manifest 版本。

## 其他开发规范

### 桥的语义变更必须同步「桥外消费者」（强制）

改桥时不能只看 `relay/` 与 `extension/` 里的测试：**有些 skill 脚本不在本仓库里**，它们会真的点按钮、发消息，而 `npm test` 看不见它们。

**先认清两种 skill 的区别**（很容易搞混）：

| | `~/.agents/skills/agent-browser-bridge` | `~/.agents/skills/boss-zhipin-apply` |
|---|---|---|
| 实体 | **符号链接** → 本仓库 `skills/agent-browser-bridge` | 真实目录（不在任何 git 里） |
| 改它等于 | 改仓库（改完要 commit） | 改本地文件（**无版本历史、无备份**） |

所以：「`~/.agents/skills` 可以改」——但**要先分清改的是链接还是真目录**。改链接目录 = 改仓库；改真目录 = 只改本机、没有任何记录。

**当前桥外消费者**（`node relay/check-skill-consumers.js` 会实时列出）：

- `~/.agents/skills/boss-zhipin-apply/scripts/{send-chat,batch-apply,remote/*}.mjs` —— 4 个文件，直连 `/rpc` 与 `/tabs/claim`。
- `~/.workbuddy/skills/boss-zhipin-apply` 是前者的**符号链接**（同一份），不用重复改。
- resume-boilerplate 项目的 `job-loop/maimai-scan.mjs` 实现了 `maimai/SKILL.md` 的配方：改该子技能的配方时同步改它。

**改桥后的收尾动作**（两件事都要做）：

```bash
# 1. 机器检查：外部消费者是否还满足桥契约（静默吞错 / AGENT_STOPPED / 租约释放 / 进程 hook）
cd relay && npm run check-consumers      # 已接入 test:unit-all，改坏会直接红

# 2. 文档同步：把新错误码/新语义写进对应子 skill
#    boss/ xhs/ debug/ 以及外部 boss-zhipin-apply/SKILL.md
```

**新增错误码或改变调用语义时，问自己**：外部 skill 脚本会怎么处理它？
历史教训（v0.3.11）：桥新增 `AGENT_STOPPED`（用户点「停止 Agent」）后，
BOSS 脚本把桥错误静默吞成 `{}`，把「用户叫停」误报成「元素不存在」，
而且重试循环**在用户叫停后继续点击**——桥这边测试全绿，问题全在桥外。

### 其他

- 修改 skill 时保持按需加载结构：站点专项 / 通用能力拆成子 skill（如 `xhs/`、`debug/`），不把全部内容堆进根 `SKILL.md`。
- 实测踩坑写回对应子 skill 或 `KNOWN_ISSUES.md`，避免下个 Agent 重踩。
- 文档中所有命令给出后，用 `node --check` / 实跑验证过再写；"凭印象写命令"视为缺陷。
- **写文档前先分清读者**：`skills/` 下的文档面向「用桥去干活的 Agent」（抓小红书、投递 BOSS），他们不改 bridge 代码；塞进开发流程（自重载、改 manifest 版本号、重启 host）只会造成噪音。这类内容写进本文件（AGENTS.md）。
