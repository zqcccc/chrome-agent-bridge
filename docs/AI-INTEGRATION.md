# AI Agent 接入指南

这份指南写给第一次接触 Agent Browser Bridge 的使用者，以及需要帮助用户完成接入的 AI Agent。

项目当前支持 **macOS + Google Chrome**。它不是一个独立浏览器，也不是安全沙箱，而是让一个本地 Agent 通过 Chrome 扩展操作用户当前 Chrome 标签页的底层桥。

## 先理解四个组件

```text
Chrome 扩展  <->  relay 本地桥  <->  AI Agent
```

- **Chrome 扩展**：加载到用户正在使用的 Chrome 中，负责读取和操作网页。
- **relay**：本地 Node.js 服务，负责连接扩展和 Agent。默认只监听 `127.0.0.1:8778`。
- **agent 客户端**：`agent/client.mjs` 和 `agent/cli.mjs`，供程序或命令行调用。
- **Skill**：`skills/agent-browser-bridge/SKILL.md`，告诉支持 Skill 的 Agent 如何检查状态、选择标签页和安全执行操作。

## 给 AI Agent 的标准接入流程

AI Agent 不应假设用户已经完成配置。首次接入时按下面顺序执行，并在每一步报告结果。

### 1. 确认前置条件

向用户确认：

- 使用的是 macOS。
- 已安装 Google Chrome。
- Node.js 版本满足项目要求（`relay/package.json` 中当前为 Node.js >= 18）。
- 用户知道该桥会操作真实 Chrome 和真实登录状态。

在项目目录运行：

```bash
node --version
```

### 2. 加载 Chrome 扩展

1. 打开 `chrome://extensions`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择项目中的 `extension/` 目录。
5. 复制扩展卡片显示的 32 位扩展 ID。
6. 确认扩展开关为 On。

不要把某个用户的扩展 ID 写入脚本或文档；每次应读取用户本机显示的 ID。

### 3. 注册并启动 Native host

在项目根目录执行：

```bash
cd /path/to/chrome-agent-bridge/relay
bash install-host.sh <用户的扩展ID>
```

注意：`install-host.sh` 是 Shell 脚本，不要使用 `node install-host.sh`。

完全退出并重新打开 Chrome，或重新加载扩展。Native 模式下不要先运行 `npm start`，Chrome 会按需启动 host。

首次启动会生成本地 Token：

```text
~/.chrome-agent-bridge/token
```

Token 是本机能力凭证，不要发送给第三方、写入聊天记录、提交到 Git 或放到网页中。

### 4. 配置扩展

打开：

```text
chrome-extension://<用户的扩展ID>/options.html
```

填写：

- 通道：`native`
- Host：`127.0.0.1`
- Port：`8778`
- Native 模式下扩展不需要填写 Token；Agent CLI 从 `~/.chrome-agent-bridge/token` 读取 Token

保存并重连。

### 6. 验证连接

先检查 relay：

```bash
curl -s http://127.0.0.1:8778/status
```

预期包含：

```json
{"ok":true,"extConnected":true}
```

再使用 CLI：

```bash
cd /path/to/chrome-agent-bridge
node agent/cli.mjs status
node agent/cli.mjs tabs
```

只有当 `extConnected` 为 `true` 且 `tabs` 能返回标签页后，才认为接入成功。

## AI Agent 的日常操作规范

每次任务都应遵守以下顺序：

1. 先调用 `status`，确认 relay 存活且扩展已连接。
2. 再调用 `tabs`，不要复用过期的 tab ID。
3. 对目标标签页执行 `snapshot`，确认页面、标题和当前状态。
4. 执行操作后再次读取页面状态验证结果。
5. **导航必须用 `page.navigate`**，禁止用 `page.evaluate` 改 `location.href`/`location.assign`/`history.go`（会销毁执行上下文，导致 RPC 无法返回、Host 超时）。
6. BOSS 等重型 SPA 的等待用条件等待（`page.waitForUrl`/`page.waitForReady`/`page.waitForSelector`/`page.waitLoad`），不要用固定 sleep。
7. 操作会发送消息、投递、下单、删除或提交表单时，必须先向用户展示最终动作和目标，获得明确确认后再执行。
8. 遇到登录、验证码、支付、二次确认或安全检查时停止并交给用户。

### 多 Agent 并行 / Tab 租约

多个 Agent 可以共用同一个 Relay。为避免业务流程互相干扰，每个 Agent 应设置唯一的 `AGENT_ID`，并在操作 Tab 前申请租约：

```js
const bridge = new Bridge({ agentId: "agent-a", agentName: "research" });
await bridge.register();
const tabs = await bridge.list();
await bridge.claimTab(tabs[0].id, 120000);
// ... 操作该 Tab ...
await bridge.releaseTab(tabs[0].id);
```

租约默认 120 秒、最长 1 小时，Agent 异常退出后会自动过期。未被租约占用的 Tab 仍可访问；已被其他 Agent 占用时返回 `TAB_LEASED`。

### 同 tab 串行 / 跨 tab 并行

- 同一 tab 的 `page.*` / `session.*` 请求在 host 端严格串行（按 tabId 队列），避免重型 SPA 下请求互相堆积导致超时。Agent 无需关心排队，但应避免在同一 tab 上“发完一个不等就发下一个”的反模式——串行由 host 保证。
- 跨 tab 请求并行。
- 单个请求超时不会级联：超时后该 tab 进入短恢复窗口，后续请求重试而非全超时。

### 错误码与诊断

桥接层错误结构化返回，包含 `code`/`method`/`tabId`/`channel`/`elapsedMs`，日志不含 token 与页面内容：

- `TIMEOUT`：超时。**排队时间计入 `timeoutMs`**（v0.3.11+），排队/等重连/执行共用一个预算；
  `details.phase` 说明超在哪一段（`queued` / `waiting-ext` / `executing`）。
  排到队时预算已耗尽就直接失败，**不会**在你放弃后才把操作发出去。
- `EXT_DISCONNECTED`：扩展通道断开；断连时所有 pending 请求确定结局，不无限挂起。
- `NAV_TIMEOUT`：导航或等待 URL/ready/selector 超时。
- `PAGE_CONTEXT_TIMEOUT`：页面上下文销毁/无法注入 content（导航中、chrome://、上下文崩溃）。
- `CONTENT_TIMEOUT`：content 调用（click/type 等）超时。
- `TAB_BUSY`：同 tab 串行队列占用（一般等待而非报错）。
- `TAB_LEASED`：Tab 已由另一个 Agent 租用。租约在**派发前会重新校验**，排队期间易主会被拒绝。
- `AGENT_STOPPED`：**用户在页面上点了「停止 Agent」**（v0.3.11+）。只拦写操作
  （`page.click`/`type`/`navigate`/CDP 的 `Input.*`），只读操作不受影响。
  不要重试；`details.resumeWith` = `"agent.resume"`，`details.scope` = `"tab"` / `"all"`。

结构化细节一律在 `error.details`（客户端库用 `e.detail(key)` 读），**不要解析 message 文本**：
如 `SCROLL_NO_GROWTH` 的 `recoverable`/`atBottom`、`AGENT_STOPPED` 的 `resumeWith`/`scope`。

> 超时与断连是两回事：`TIMEOUT` 是请求发出后超时，`CONNECTION_REFUSED` 才是连不上本地桥
> （v0.3.11 前客户端把本地超时也包成了 `CONNECTION_REFUSED`，会把人引向「请启动桥」）。

**取消语义**（v0.3.11+）：HTTP 连接断开 / WS 关闭时，同 Agent **尚未派发**的排队请求会被取消。
对点击、输入、发消息、提交表单这类**不可逆**操作，这是防止「调用方以为失败、实际稍后执行」的关键；
已派发到扩展的无法撤回，停止响应里会用 `inFlight` 如实报告数量。

HTTP 客户端可通过 `X-Agent-Id` 标识身份；WS 客户端在 `/bridge?...&agentId=<id>` 中传递身份。

可以使用客户端库：

```js
import { Bridge } from "./agent/client.mjs";

const bridge = new Bridge();
const status = await bridge.status();
if (!status.extConnected) throw new Error("Chrome extension is not connected");

// To open a URL: prefer `open()` — it reuses an INACTIVE same-site tab and otherwise
// opens a silent background tab, so it never hijacks the page the user is looking at.
const opened = await bridge.open("https://example.com");
const tabId = opened.tabId;   // { tab, tabId, reused, navigated, reason }

// Reading whatever the user is currently viewing is fine; navigating it away is not.
const target = await bridge.active();
if (!target) throw new Error("No active tab");

const snapshot = await bridge.snapshot(tabId, { mode: "a11y" });
console.log(snapshot.title, snapshot.url);
```

## 常见故障排查

### `ECONNREFUSED`

Native host 尚未被 Chrome 启动，或者端口不是 8778。先重新加载扩展并检查 Native 配置；如果明确使用 WS 模式，再运行：

```bash
cd /path/to/chrome-agent-bridge/relay
npm start
```

也可以检查环境变量 `AGENT_BRIDGE_PORT`。

### `extConnected: false`

依次检查：

1. Chrome 扩展是否开启。
2. 扩展设置中的 host、端口和 Token 是否正确。
3. Native Messaging Host 是否已经注册。
4. Chrome 是否在注册后重启。
5. 是否同时运行了多个 relay 进程。

### `401 UNAUTHORIZED`

Agent 使用的 Token 与本地 relay 不一致。默认 Token 位于：

```bash
cat ~/.chrome-agent-bridge/token
```

重新设置：

```bash
export AGENT_BRIDGE_TOKEN="$(cat ~/.chrome-agent-bridge/token)"
```

不要通过 `/token` HTTP 接口获取 Token；项目没有提供这个接口。

### `Cannot access contents of the page`

常见原因：

- 当前页面是 `chrome://` 等受保护页面。
- 扩展刚刚 reload，旧标签页还没有重新注入 content script。
- 标签页处于冻结或非激活状态。

先激活普通网页标签页，再重新获取标签列表和快照。

## 权限和安全边界

接入前，AI Agent 必须向用户说明：

- Agent 可能读取当前 Chrome 中已登录网页的可见内容。
- `page.evaluate` 可以执行页面 JavaScript。
- Token 是本地控制权限，泄露后可能导致未授权的浏览器操作。
- 该项目不是沙箱，不能隔离恶意 Agent 或恶意操作。
- 不可逆操作必须在执行前得到用户确认。

详细说明见项目根目录的 [SECURITY.md](../SECURITY.md)。
