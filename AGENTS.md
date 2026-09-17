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

## 开发循环：改完怎么生效

改代码后**不要让用户去点 chrome://extensions 的刷新按钮**——自己重载。

```bash
export BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token)
node agent/cli.mjs reload-ext        # 扩展自重载，约 2s，自动等重连
node agent/cli.mjs verify            # 回归自检，改完跑一次（12 项，全绿才算完）
```

- 原理：RPC `extension.reload` → 扩展**先回响应、再**延迟调 `chrome.runtime.reload()`。顺序不能反——自重载会立即终止自身执行，先回响应否则调用方永远收不到结果。
- **响应必然丢失，属正常**：扩展 reload 会连带关闭 native channel，host 进程随之退出并由 Chrome 重新拉起，该次 HTTP 响应收不到。CLI 已改由轮询 `/status` 确认重连；自己写脚本时照此处理，别把丢响应当失败。
- 改 `relay/host.js` 要重启 host（Chrome 按需重新拉起，约 1s）：`pkill -f "chrome-agent-bridge/relay/host.js"`。
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

`Uncaught (in promise)` 之类的面板报错同理：面板累积显示、不区分新旧，排查前先重新导航重置，再只触发一次待测调用——否则会把历史残留当成新问题。

### 兜底：未捕获的 promise rejection

service worker 里漏网的 rejection 会变成面板上的 `Uncaught (in promise)`，掩盖真实问题。已在启动时注册 `unhandledrejection` 监听统一记录为 warn。新增顶层 promise 时仍要自己 catch，别依赖这个兜底。

## 其他开发规范

- 修改 skill 时保持按需加载结构：站点专项 / 通用能力拆成子 skill（如 `xhs/`、`debug/`），不把全部内容堆进根 `SKILL.md`。
- 实测踩坑写回对应子 skill 或 `KNOWN_ISSUES.md`，避免下个 Agent 重踩。
- 文档中所有命令给出后，用 `node --check` / 实跑验证过再写；"凭印象写命令"视为缺陷。
- **写文档前先分清读者**：`skills/` 下的文档面向「用桥去干活的 Agent」（抓小红书、投递 BOSS），他们不改 bridge 代码；塞进开发流程（自重载、改 manifest 版本号、重启 host）只会造成噪音。这类内容写进本文件（AGENTS.md）。
