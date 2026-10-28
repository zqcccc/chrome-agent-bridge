# Firefox：用同一套 RPC 操作 Firefox

**什么时候读本文件**：用户要求在 Firefox 里操作；`/status` 返回 `"browser":"firefox"`；
或在 Firefox 上遇到 `BIDI_UNAVAILABLE` / `CDP_UNSUPPORTED`。

## 选浏览器：只改一个环境变量

Chrome 与 Firefox 各有一个本地 host，**RPC 方法、参数、返回结构、错误码相同**，区别只有端口：

| 浏览器 | host 端口 | 选择方式 |
|---|---|---|
| Chrome | `8778` | 默认 |
| Firefox | `8779` | `BRIDGE_BROWSER=firefox`（或 `BRIDGE_PORT=8779`） |

`scripts/lib/bridge.mjs` 与 `scripts/` 下全部脚本都按 `BRIDGE_BROWSER` / `BRIDGE_PORT` 选端口（`BRIDGE_PORT` 优先）：

```bash
BRIDGE_BROWSER=firefox node <skill 目录>/scripts/preflight.mjs
BRIDGE_BROWSER=firefox node <skill 目录>/scripts/cdp-eval.mjs <tabId> "document.title"
```

```js
import { Rpc } from "./scripts/lib/bridge.mjs";
const rpc = new Rpc({ port: 8779, agentName: "MyTask" });   // 或进程环境里设 BRIDGE_BROWSER=firefox
await rpc.withPage("https://example.com/", async (tabId) => {
  await rpc.clickReal(tabId, "a");
  console.log(await rpc.ev(tabId, "document.title"));
});
```

裸 HTTP：

```bash
TOKEN=$(cat ~/.chrome-agent-bridge/token)
curl -s http://127.0.0.1:8779/status
curl -s -X POST http://127.0.0.1:8779/rpc -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"method":"tabs.list","params":{},"timeoutMs":10000}'
```

两个浏览器的 token 是同一个文件；tabId 各自独立编号，**不能把 Chrome 的 tabId 拿到 Firefox 端口用**。

## 前置条件：Firefox 必须以 Remote Agent 模式启动

Firefox 扩展没有 `chrome.debugger`。真实点击、受控输入、文件上传、CDP 求值、静默截图在 Firefox 上由 host
经 **WebDriver BiDi**（Firefox 内置的 Remote Agent）执行，而 Remote Agent 只在 Firefox 带
`--remote-debugging-port` 启动时开启。

`/status` 判断当前状态：

```json
{ "browser": "firefox", "extConnected": true, "bidi": { "port": 9222, "connected": true, "attachedTabs": [] } }
```

- `extConnected:false`：Firefox 没开，或扩展没装（临时扩展在 Firefox 重启后会消失）。
- `bidi.connected:false` 只表示还没有调用过需要 BiDi 的方法，不代表不可用；第一次调用失败才报 `BIDI_UNAVAILABLE`。

不需要 BiDi 的方法（`tabs.*`、`page.navigate`、`page.snapshot`、`page.click`、`page.type`、`page.scroll`、
`page.evaluate`（非严格 CSP 页）、`page.inspect`、`page.read` 等）在 Firefox 普通启动时也能用。

启动方式（本机仓库的便利命令，由用户或安装流程执行，见 `INSTALL.md`「Firefox」一节）：

```bash
node <chrome-agent-bridge 仓库根>/relay/firefox-launch.js --no-install   # 已永久安装签名版扩展时；Firefox 须已完全退出
node <chrome-agent-bridge 仓库根>/relay/firefox-launch.js                # 未签名：每次启动都装临时扩展
```

## 与 Chrome 的行为差异

| 项目 | Chrome | Firefox |
|---|---|---|
| `page.clickReal` / `page.typeReal` / `page.uploadFile` / `page.evalCdp` / `page.screenshot` | `chrome.debugger` | WebDriver BiDi；事件同样 `isTrusted=true`，后台标签页可用 |
| `session.send` | 全部 CDP 方法 | 下表的子集；其余报 `CDP_UNSUPPORTED` |
| 用户能看到的浏览器痕迹 | CDP 操作期间顶部短暂显示「正在调试此浏览器」 | Remote Agent 开启期间地址栏一直是远程控制样式（见下节） |
| `navigator.webdriver` | `false` | **`true`**（Remote Agent 开启期间，实测）：检测它的风控站点会识别为自动化 |
| 渲染器冻结自愈 | 有（Memory Saver） | 不适用（Firefox 无此冻结） |
| `DEBUGGER_BUSY` | 用户开 DevTools 时出现 | 不会出现 |
| 页面标题 / 指示器 / 停止按钮 / 租约 / `agent.stop` | 相同 | 相同 |

`navigator.webdriver=true` 是 Firefox 方案的固有代价。对 BOSS 直聘、小红书等风控严格的站点，优先用 Chrome。

## 使用痕迹：用户和网页能看到什么

Firefox 上的痕迹比 Chrome 明显，且大部分在桥没有操作时也存在。开工前向用户说明，风控严格的站点改用 Chrome。

**Firefox 独有**（v0.3.15 实测）：

| 痕迹 | 谁能看到 | 何时出现 | 能否避免 |
|---|---|---|---|
| 地址栏变为条纹背景并显示机器人图标（浏览器处于远程控制状态） | 用户 | 以 `--remote-debugging-port` 启动后一直存在，与桥是否在操作无关 | 桥无法隐藏。普通方式启动 Firefox 则没有，但需要 BiDi 的方法（`clickReal` / `typeReal` / `uploadFile` / `evalCdp` / 截图 / `session.send`）全部报 `BIDI_UNAVAILABLE` |
| `navigator.webdriver === true` | 所有网页的脚本 | 同上：该 Firefox 进程内的所有页面，包括用户自己浏览的页面 | 同上 |
| `<html>` 上短暂出现 `data-abb-bidi="<uuid>"` 属性，随即删除 | 监听 `<html>` 属性变化的页面脚本（`MutationObserver`） | 每个标签页**第一次**调用需要 BiDi 的方法时出现一次（用来把扩展的 tabId 与 BiDi 的 context 对上）；同一标签页之后不再出现，导航也不会再触发 | 不能，这是配对机制本身 |

**两个浏览器共有**（桥自己的提示，页面脚本同样能读到）：

- 标题被改为 `● [<agentName>] 接管中 | 原标题`，`document.title` 可读到。
- `<html>` 下插入指示器节点：`#agent-bridge-control-status`（接管标记）、`#agent-bridge-stop`（「停止 Agent」按钮）、`#agent-bridge-cursor`（虚拟光标）与点击波纹。

## `session.send` 在 Firefox 上支持的 CDP 方法

| CDP 方法 | 说明 |
|---|---|
| `Runtime.evaluate` | 支持 `expression` / `returnByValue` / `awaitPromise` / `userGesture`。不返回 `objectId`；`contextId` 被忽略（固定在主 frame 的页面 realm）。异常时 `result` 与 `exceptionDetails.exception` 是同一个错误对象，`description` 含消息与堆栈 |
| `Input.dispatchMouseEvent` | `mouseMoved` / `mousePressed` / `mouseReleased` / `mouseWheel`；`modifiers` 生效；`clickCount` 被忽略（双击由浏览器按时间间隔自动判定） |
| `Input.dispatchKeyEvent` | `keyDown` / `rawKeyDown` / `keyUp` / `char`；`key` 用 DOM 键名（`Enter`、`Tab`、`ArrowDown`、`F5`…）或单个字符。按下期间的 `char` 不会重复输入 |
| `Input.insertText` | 在焦点所在 frame 执行 `execCommand("insertText")`：只触发 `beforeinput`/`input`，`\n` 是换行而不是回车提交 |
| `DOM.getDocument` / `DOM.querySelector` / `DOM.querySelectorAll` | nodeId 只在本次 attach 内有效；未命中返回 `nodeId: 0` |
| `DOM.setFileInputFiles` | 支持 `nodeId` / `backendNodeId`，**不支持 `objectId`** |
| `Page.captureScreenshot` | `format` / `quality` / `clip` / `captureBeyondViewport`；后台标签页可截 |
| `Page.navigate` / `Page.reload` / `Page.bringToFront` | |
| `Emulation.setDeviceMetricsOverride` / `Emulation.clearDeviceMetricsOverride` | 只改视口尺寸与 `deviceScaleFactor`（`mobile` 被忽略）；detach 时自动还原，与 CDP 一致 |

不支持任何 `*.enable` 与 CDP 事件订阅（如 `Network.enable`）：需要网络拦截、性能追踪等能力时改用 Chrome。

## Firefox 专有错误码

| 错误码 | 含义 | 处理 |
|---|---|---|
| `BIDI_UNAVAILABLE` | 连不上 Remote Agent：Firefox 没带 `--remote-debugging-port` 启动；或 BiDi 会话被别的自动化工具（Playwright / Selenium）占用；或上一个 host 被强制杀掉、没来得及结束会话 | 告知用户：完全退出 Firefox 后用 `firefox-launch.js` 重新启动。不要重试 |
| `CDP_UNSUPPORTED` | `session.send` 用了上表以外的 CDP 方法 | 换成上表里的方法或高层 RPC；确实需要时改用 Chrome |

Firefox 同一时间只允许一个 BiDi 会话，且连接断开不会释放会话。host 正常退出（Firefox 关闭、扩展重载、`SIGTERM`）
时会先结束会话；被 `kill -9` 时会话会残留，只能重启 Firefox 释放。
