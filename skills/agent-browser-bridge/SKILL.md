---
name: agent-browser-bridge
description: 用本地 Chrome 扩展 + 本地桥（Agent Browser Bridge）操作真实 Chrome 浏览器的完整指南。当任务需要在用户的日常 Chrome 里操作网页（导航、读取页面、点击、输入、滚动、截图、执行 JS、管理标签页），且必须使用真实登录态（如 BOSS 直聘、公众号后台、网银等登录后页面）时使用本 Skill。与 Playwright/Puppeteer 无关——本桥直接接管日常 Chrome，参考 ChatGPT/Claude 官方 Chrome 插件的原生通道设计。触发词：操作浏览器、打开某网页、在 Chrome 里点击/输入/抓取、自动投递、登录后页面操作。
---

# Agent Browser Bridge —— 让 Agent 操作日常 Chrome

架构：Chrome 扩展（MV3）↔ 本地桥 host（relay/host.js，:8778）↔ Agent 客户端（HTTP/WS JSON-RPC）。

```
你的 Chrome（真实登录态）──native messaging / ws──▶ 本地桥 host(:8778) ◀──HTTP POST /rpc── Agent
```

## 前置条件（每个任务开始前必须检查）

1. **扩展已加载**：chrome://extensions 里有 "Agent Browser Bridge"（已解压；ID 以你本机 `chrome://extensions` 中显示的为准），开关为 On。
2. **host 存活**：`curl -s http://127.0.0.1:8778/status` 返回 `{"ok":true,...}`。
   - **推荐 Native 模式**：不要手动 `npm start`。注册 native host 后，Chrome 按需拉起 host 进程，该进程监听 8778，Agent 连 8778 即同一进程。Chrome 关闭时进程自动退出。`status` 返回 `mode:native`。
   - **standalone WS 模式（二选一）**：`cd /path/to/chrome-agent-bridge/relay && npm start`，host 常驻 8778，扩展用 `ws://127.0.0.1:8778/agent` 连入。`status` 返回 `mode:standalone`。
   - **两种模式不要同时运行**：standalone 占着 8778 时，native 拉起的进程会因端口占用退出，扩展 `auto` 通道会回退到 WS（不透明）。推荐只用 Native。
3. **扩展已连上 host**：status 输出 `extConnected:true`。扩展 reload 或 Chrome 重启后几秒内自动重连。

## 快速开始（CLI）

```bash
export BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token)   # 每次 shell 都要
cd /path/to/chrome-agent-bridge

node agent/cli.mjs status              # host 状态 + 扩展连接
node agent/cli.mjs tabs                # 列出所有标签页（拿 tabId，用户操作会变，用前必查）
node agent/cli.mjs open <url>          # 新标签页打开 URL
node agent/cli.mjs eval <tabId> "<js>" # 在页面执行 JS（同步求值）
node agent/cli.mjs click <tabId> <css选择器>
node agent/cli.mjs type <tabId> <sel> <text>
node agent/cli.mjs press <tabId> <key>
node agent/cli.mjs scroll <tabId> <sel> <dir>
node agent/cli.mjs snap <tabId>        # 页面快照（a11y 树+元素清单）
node agent/cli.mjs shot <tabId>        # 页面截图（保存当前目录）
node agent/cli.mjs listen              # 订阅页面事件
```

## 编程调用（推荐用于多步流程）

```js
import { Bridge } from "./agent/client.mjs";   // 或直接 HTTP
const bridge = new Bridge({ port: 8778, token: process.env.BRIDGE_TOKEN });
await bridge.rpc("tabs.list");
await bridge.rpc("page.navigate", { tabId, url });
await bridge.rpc("page.evaluate", { tabId, expression: "..." , awaitPromise: false });
await bridge.rpc("page.click", { tabId, selector: "..." });
await bridge.rpc("page.type", { tabId, selector: "...", text: "..." });
```

HTTP 直调：`POST http://127.0.0.1:8778/rpc`，头 `Authorization: Bearer <token>`，体 `{"method":"...","params":{...},"timeoutMs":20000}` → `{"ok":true,"result":{...}}`。注意 **page.evaluate 的返回值在 `result.result` 里是 JSON 字符串**，需要再 JSON.parse 一次。

## 实战踩坑清单（务必先读）

1. **host 可能随时死**：开工前、长流程中途，都 `curl /status` 确认；死了就重启，token 不变。
2. **刚 reload 扩展前的旧标签页 content script 不注入**：`page.evaluate` 报 "Cannot access contents of the page"。解决：先 `page.activate`（或 tabs.activate）激活该标签再操作。被 OneTab 冻结的标签同理。
3. **`chrome://` 等受保护页面**不能注入/截图（需 activeTab 授权，点一次扩展图标即可）。
4. **eval 是同步求值**：表达式里有 `await`/Promise 必须传 `awaitPromise:true`，否则返回空对象。
5. **受控组件（React/Vue）输入**：`el.value=x` 无效。用 native setter + InputEvent：
   ```js
   const setter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText').set; // textarea 用 'value'
   setter.call(el, text);
   el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text}));
   ```
   输完检查发送/提交按钮是否从 disabled 变 enabled，再点它。
6. **部分动态页面的截图**：CDP `page.screenshot` 可能卡住或无法得到期望结果；先激活标签页，必要时使用系统级截图方案。
7. **激活标签后 tabId 不变**，但用户手动开/关标签会变——多步流程每步都重新 `tabs` 确认。
8. **导航等待**：导航必须用 `page.navigate`（走 `chrome.tabs.update`），**禁止用 `page.evaluate` 改 `location.href`/`location.assign`/`history.go`**——后者会销毁执行上下文，导致 RPC 无法返回、Host 超时。`page.navigate` 后可调 `page.waitForUrl`/`page.waitForSelector`/`page.waitForReady` 按条件等待，不要用固定 sleep。
9. **视觉指示器**：Agent 操作时页面会显示幽灵光标 + 点击涟漪 + 「停止 Agent」按钮（默认开启）。用户可随时点停止打断。
10. **停止按钮实现**：background 的 dispatch() 只对真实交互操作（click/type/press/scroll/hover/focusEl/select/waitFor）显示停止按钮；只读/导航（navigate/info/evaluate/snapshot/waitLoad/waitForUrl/waitForSelector/waitForReady）不被 indicator 阻塞，indicator 失败也不影响主 RPC。如需默认关闭改 background.js 的 INTERACTIVE_METHODS。

## 错误码（可诊断）

桥接层返回结构化错误，包含 code/method/tabId/channel/elapsedMs：

- `TIMEOUT` / `EXT_DISCONNECTED` / `SEND_FAILED`：扩展通道层。超时后会返回 method、tabId、channel、耗时，日志不含 token 与页面内容。
- `TAB_BUSY`：同 tab 请求串行队列中前序请求占用（一般等待而非报错；若恢复窗口内，短时间等待后重试）。
- `NAV_TIMEOUT`：导航/等待 URL/ready/selector 超时。
- `PAGE_CONTEXT_TIMEOUT`：页面上下文已销毁/无法注入 content script（导航中、chrome://、上下文崩溃）。
- `CONTENT_TIMEOUT`：content 调用（click/type 等）超时。
- `EXT_DISCONNECTED` 在扩展 WS/Native 断连时让所有 pending 请求确定结局，不无限挂起。

## 同 tab 串行与跨 tab 并行

- 同一 tab 的 `page.*` / `tabs.get|activate|close|reload` / `session.*` 请求在 host 端**严格串行**（按 tabId 维护队列），避免 BOSS 重型 SPA 下 navigate/snapshot/evaluate 互相堆积导致超时。
- 跨 tab 请求并行。
- 单个请求超时不会让同 tab 后续所有请求雪崩：超时后该 tab 进入短恢复窗口（约 500ms），后续请求重试而非级联失败。

## 增强等待 API（BOSS SPA，不依赖固定 sleep）

- `page.waitForUrl` `{ tabId, match?/equals?, timeoutMs?, intervalMs? }`：等 URL 变化。
- `page.waitForReady` `{ tabId, timeoutMs? }`：等 `document.readyState` 为 complete。
- `page.waitForSelector` `{ tabId, selector, by?, timeoutMs?, intervalMs? }`：等选择器出现。
- `page.waitLoad` `{ tabId, timeoutMs? }`：等加载完成（webNavigation + 轮询兑底）。

## 安全

- host 只监听 127.0.0.1；Agent 调用需 Bearer token（首次启动随机生成，0600 权限）。
- 页面快照自动遮蔽敏感字段（密码、hidden、信用卡、验证码）为 `[value redacted]`。
- 发送消息/提交表单前，涉及不可逆动作（投递、发消息、下单）务必先给用户确认清单。
- 项目根目录由使用者自行决定；以下命令中的 `/path/to/chrome-agent-bridge` 请替换为实际路径。Native Messaging host 名 `com.agentbrowser.bridge`。
