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

写这类自检脚本有两条教训（都是我自己踩出来的假红）：

1. **版本号断言写下限，不要写死具体值**。写死 `version === "0.3.4"` 之后每发一次版都得回来改脚本，改漏了就出现「功能正常但测试失败」。改成 `>= 0.3.3`（修复引入的最低版本）即可。
2. **测试要自己保证前置条件**。扩展重载后旧标签页的 content script 会失效，脚本若随机挑一个 http tab 就直接测，会拿到 `TIMEOUT` 假红。正确做法是先对候选 tab 逐个 `tabs.prepare` 探测，取第一个可注入的。

`Uncaught (in promise)` 之类的面板报错同理：面板累积显示、不区分新旧，排查前先重新导航重置，再只触发一次待测调用——否则会把历史残留当成新问题。

### 兜底：未捕获的 promise rejection

service worker 里漏网的 rejection 会变成面板上的 `Uncaught (in promise)`，掩盖真实问题。已在启动时注册 `unhandledrejection` 监听统一记录为 warn。新增顶层 promise 时仍要自己 catch，别依赖这个兜底。

## 其他开发规范

- 修改 skill 时保持按需加载结构：站点专项 / 通用能力拆成子 skill（如 `xhs/`、`debug/`），不把全部内容堆进根 `SKILL.md`。
- 实测踩坑写回对应子 skill 或 `KNOWN_ISSUES.md`，避免下个 Agent 重踩。
- 文档中所有命令给出后，用 `node --check` / 实跑验证过再写；"凭印象写命令"视为缺陷。
- **写文档前先分清读者**：`skills/` 下的文档面向「用桥去干活的 Agent」（抓小红书、投递 BOSS），他们不改 bridge 代码；塞进开发流程（自重载、改 manifest 版本号、重启 host）只会造成噪音。这类内容写进本文件（AGENTS.md）。
