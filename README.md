# Agent Browser Bridge

> macOS + Google Chrome 的本地 Agent 浏览器桥。面向开发者和 Agent 基础设施使用，不是隔离浏览器或安全沙箱。

[Security model](SECURITY.md) · [MIT License](LICENSE)

通用浏览器桥：让本地 Agent 通过安全通道接管你日常使用的 Chrome——列出/管理标签页、导航、读取页面、点击、输入、滚动、截图。

## 给 AI Agent 的一句话接入指令

把下面这句话直接复制给你的 AI Agent：

```text
请从 https://github.com/zqcccc/chrome-agent-bridge.git 克隆 Agent Browser Bridge，并阅读仓库中的 docs/AI-INTEGRATION.md、SECURITY.md 和 skills/agent-browser-bridge/SKILL.md，按照接入指南完成 macOS + Google Chrome 的本地配置。请在执行任何修改系统、Chrome 设置或网页不可逆操作前先向我说明并获得确认；不要输出或提交 ~/.chrome-agent-bridge/token。最后用 /status 和 agent/cli.mjs tabs 验证连接，并告诉我还需要我手动完成哪些步骤。
```

设计与 Codex（ChatGPT for Chrome）、Claude（Claude in Chrome）插件的做法一致：**装进你日常使用的 Chrome 里**，直接操作真实浏览器、真实登录态，而不是像 Playwright 那样另起一个无头浏览器。本项目的通道设计、页面感知与视觉指示器均参考了两家官方扩展的实现。

## 架构

```
┌─────────────┐   Native Messaging (stdio, 4字节长度+JSON)    ┌──────────────────┐
│  你的 Chrome │ ◄────────────────────────────────────────────►│                  │
│  (Chrome profile)│          或 WebSocket (ws://127.0.0.1)      │  本地桥 host      │
│             │                                                │  relay/host.js   │
│  Agent      │                                                │  :8778           │
│  Browser    │                                                │                  │
│  Bridge 扩展 │                                                │  HTTP /rpc       │
│  (MV3)      │                                                │  WS /agent       │
└─────────────┘                                                │  WS /bridge      │
                                                               └────────┬─────────┘
                                                                        │ HTTP /rpc (Bearer token)
                                                                        ▼
                                                               ┌──────────────────┐
                                                               │ Agent 客户端      │
                                                               │ agent/cli.mjs    │
                                                               │ agent/client.mjs │
                                                               └──────────────────┘
```

- **扩展（extension/）**：MV3 后台脚本 + 页面注入脚本。负责连接本地桥（Native Messaging 优先，失败自动回退 WebSocket）、RPC 分发、标签页管理、页面快照与操作、截图、导航等待。Native 连接建立后会先发送 hello 握手消息。
- **本地桥（relay/）**：既是 Native Messaging host 进程，又是 HTTP/WS 服务端。单进程双角色：Chrome 通过 native 或 ws 连进来，Agent 通过 HTTP/WS 连进来，两边消息转发。
- **Agent 客户端（agent/）**：给 Agent 用的 JS 客户端与命令行工具，内置 Agent 身份标识。

## 目录结构

```
chrome-agent-bridge/
├── extension/            # Chrome MV3 扩展
│   ├── manifest.json     # v0.2.0
│   ├── background.js     # 双通道连接管理、RPC 分发、截图、导航等待
│   ├── content.js        # 页面感知（a11y 树/元素清单）+ 操作 + 敏感字段遮蔽
│   ├── indicator.js      # 幽灵光标 + 点击涟漪 + 停止按钮（视觉指示器）
│   ├── popup.html/js     # 工具栏弹窗
│   ├── options.html/js   # 设置页（通道 / host / token）
│   └── icons/            # 16/32/48/128 图标
├── relay/
│   ├── host.js           # 本地桥（native host + HTTP/WS 服务）
│   ├── ws-server.js      # 零依赖 WebSocket 服务端（支持大帧截图）
│   ├── host.sh           # node 发现 + 启动包装
│   ├── install-host.sh   # 注册 native host 到 Chrome（需扩展 ID）
│   ├── generate-icons.js # 图标生成
│   └── test.js           # 集成测试
├── agent/
│   ├── client.mjs        # Bridge 客户端类
│   └── cli.mjs           # 命令行工具
├── docs/
│   └── AI-INTEGRATION.md    # 给 AI Agent 的接入与操作指南
├── skills/
│   └── agent-browser-bridge/ # 配套 Agent Skill（可选）
├── SECURITY.md
├── LICENSE
└── README.md
```

## 安装

当前项目面向 macOS + Google Chrome。`skills/agent-browser-bridge/` 是可选的 Agent 使用说明和辅助脚本，不参与 relay/extension 的运行时依赖。

如果你希望让 AI Agent 使用本项目，请同时阅读 [AI Agent 接入指南](docs/AI-INTEGRATION.md)。它把“扩展、relay、Token、RPC、Skill”这些概念和接入步骤拆成了可执行的检查清单。

### 1. 加载扩展

1. 打开 `chrome://extensions`，右上角开启「开发者模式」
2. 点「加载已解压的扩展程序」，选择 `extension/` 目录
3. 记下扩展卡片上显示的 ID（每个本地安装的 ID 可能不同）

### 2. 启动本地桥

> 如果使用推荐的 Native 模式，请跳过本节，先完成下一节的 Native Messaging 注册。Native 模式不需要手动运行 `npm start`。

```bash
cd relay
npm start                # 等价于 node host.js --standalone
# 首次启动生成 token，保存在 ~/.chrome-agent-bridge/token，日志在 ~/.chrome-agent-bridge/host.log
```

端口默认 `8778`，可用 `--port` 修改。

### 3. 注册 Native Messaging Host（可选，推荐）

```bash
cd /path/to/chrome-agent-bridge/relay
bash install-host.sh <你的扩展ID>
```

注意：`install-host.sh` 是 Shell 脚本，使用 `bash` 执行，不要使用 `node install-host.sh`。

注册后完全退出并重新打开 Chrome，或重新加载扩展。Native Messaging 与 ChatGPT/Claude 插件同款通道，无需 HTTP 端口暴露给扩展。

> **两种运行模式（二选一，推荐 Native）**
> - **Native 模式（推荐）**：不启动 standalone host。Chrome 通过 Native Messaging 按需拉起 `host.js`，该进程自己监听 8778；Agent 连 8778 即是同一进程。Chrome 关闭连接时进程自动退出，无需常驻。`/status` 返回 `mode:native`。
> - **standalone WS 模式**：手动启动 `npm start`（host 常驻 8778），扩展通过 `ws://127.0.0.1:8778/agent` 连接。`/status` 返回 `mode:standalone`。
> - **两种模式不要同时运行**：standalone 占着 8778 时，native 拉起的进程会因端口占用自动退出，扩展 `auto` 通道会回退到 WS（已内置该逻辑，但不透明）。推荐只用 Native。
> - 不要把可靠性建立在“手动反复重启 host”上：Native 模式下 Chrome 关闭即退出、重连即拉起新进程；standalone 模式下进程异常会在 `/status` 体现为 `extConnected:false`。

### 4. 配置扩展连接

打开扩展设置页：`chrome-extension://<扩展ID>/options.html`

- 通道：默认 `auto`（优先 Native Messaging，失败回退 WebSocket）
- Relay 端口：`8778`
- Token：粘贴 `~/.chrome-agent-bridge/token` 的内容
- 点「保存并重连」

连接成功后设置页会显示「已连接」，host 状态接口也会显示 `extConnected: true`。

## 用法

### 状态检查

```bash
curl http://127.0.0.1:8778/status
# {"ok":true,"name":"com.agentbrowser.bridge","version":"0.2.0","channel":"disconnected","extConnected":false,...}
```

### Agent CLI（node agent/cli.mjs <cmd>）

| 命令 | 说明 |
|---|---|
| `status` | 显示 host 状态与扩展连接 |
| `tabs` | 列出所有标签页 |
| `active` | 当前激活标签页 |
| `open <url>` | 新标签页打开 URL |
| `snap [tabId]` | 页面快照（a11y 树 + 元素清单） |
| `shot [tabId]` | 页面截图（保存到当前目录） |
| `eval <js>` | 在页面执行 JS |
| `click <sel>` | 点击元素（CSS 选择器） |
| `type <sel> <text>` | 输入文本 |
| `press <key>` | 按键（Enter/Tab/Escape/...） |
| `scroll <sel> <dir>` | 滚动 |
| `cursor on/off` | 显示/隐藏幽灵光标 |
| `listen` | 订阅页面事件 |

示例：

```bash
export BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token)
node agent/cli.mjs tabs
node agent/cli.mjs open https://example.com
node agent/cli.mjs snap
node agent/cli.mjs click "button[type=submit]"
node agent/cli.mjs shot
```

### 编程调用（agent/client.mjs）

```js
import { Bridge } from "./agent/client.mjs";
const bridge = new Bridge({ port: 8778, token: "...", agentId: "research-agent" });
await bridge.register("research-agent");
const tabs = await bridge.list();
await bridge.claimTab(tabs[0].id); // 可选：声明 Tab 所有权
await bridge.rpc("tabs.list");
await bridge.rpc("page.snapshot", { mode: "a11y" });
await bridge.rpc("page.click", { selector: "#submit" });
await bridge.rpc("page.screenshot");
await bridge.releaseTab(tabs[0].id);
```

## 通道协议

### 扩展 ↔ 本地桥（Native Messaging）

- 请求：`{"type":"request","requestId":N,"method":"...","params":{...}}`，前加 4 字节小端长度
- 响应：`{"type":"response","responseToRequestId":N,"payload":...|"error":...}`

### Agent ↔ 本地桥（HTTP/WS，JSON-RPC）

- HTTP POST `/rpc`：`{"method":"...","params":{...},"timeoutMs":...}` + `Authorization: Bearer <token>`
- WS `/bridge`：`{"id":N,"method":"...","params":{...}}` → `{"id":N,"ok":true,"result":...}`；事件 `{"type":"event","event":"...","payload":...}`

## 能力清单

- **标签页**：list / active / open / activate / close / update
- **页面感知**：a11y 树（role 推断、可读名、敏感字段遮蔽为 `[value redacted]`）、元素清单、全文、完整 DOM
- **页面操作**：click / type / press / scroll / hover / focus / select / waitFor
- **截图**：CDP `Page.captureScreenshot`（支持整页）→ 兜底 `tabs.captureVisibleTab`
- **导航等待**：`webNavigation.onCommitted` + 轮询兜底，默认 45s 超时；另提供 `page.waitForUrl`/`page.waitForReady`/`page.waitForSelector` 按条件等待（BOSS 重型 SPA 不依赖固定 sleep）
- **导航安全**：导航必须用 `page.navigate`（`chrome.tabs.update`），**禁止用 `page.evaluate` 改 `location.href`**（会销毁执行上下文导致 RPC 无法返回）
- **多 Agent 并行与租约**：多个 Agent 可同时连接；不同 Tab 并行；可用 Tab lease 明确分配所有权，避免同一 Tab 的业务流程互相干扰
- **同 tab 串行**：同一 tab 的 `page.*`/`session.*` 请求在 host 端严格串行，跨 tab 并行；单个请求超时不级联
- **错误码**：`TIMEOUT`/`EXT_DISCONNECTED`/`NAV_TIMEOUT`/`PAGE_CONTEXT_TIMEOUT`/`CONTENT_TIMEOUT`/`TAB_BUSY`，含 method/tabId/channel/耗时，日志不含 token 与页面内容
- **接管状态与视觉指示器**：Agent 对页面发出控制请求时，Chrome 标签标题会加上 `● Agent 接管中` 前缀，扩展工具栏图标显示蓝色 `ON` 徽标，页面右上角也显示「Agent 接管中」；连续 12 秒没有新的控制请求时自动切换为「Agent 已放开」，点击「停止 Agent」也会立即放开并清除标记。另保留幽灵光标、点击涟漪和停止按钮（页面内 `agent-bridge-cursor` / `agent-bridge-stop`）。
- **事件订阅**：页面事件实时推送（导航、点击、输入等）
- **Agent 身份与 Tab 租约**：`Bridge` 默认使用 `AGENT_ID` 或 `agent-<pid>`；可调用 `register()`、`claimTab()`、`releaseTab()`。租约默认 120 秒自动过期，最长 1 小时；其他 Agent 访问被占用 Tab 时返回 `TAB_LEASED`。

## 安全

- 本地桥只监听 `127.0.0.1`，不对外网暴露
- Agent 调用需 Bearer token（首次启动随机生成，0600 权限）
- 敏感字段（密码、hidden、信用卡、验证码等）在页面快照中自动遮蔽，不进入 Agent 上下文
- 停止按钮可随时打断 Agent 的页面操作

## 测试

```bash
cd relay && npm test               # 集成 + 单元 + send-chat helper
node relay/test.js                 # 集成测试（鉴权、RPC 转发、错误传播、事件广播）
node relay/test-unit.js            # 单元测试（frame parser、tab 队列、超时/pending 清理、WS error 不崩）
node --test relay/test-verify.mjs  # send-chat 送达验证 helper（6 种情形）
```


已知边界：
- `chrome://` 等受保护页面禁止内容注入（快照/操作不可用），截图需 `activeTab` 授权（点击一次扩展图标即可）
- 超长页面整页截图（`captureBeyondViewport:true`）可能较慢，默认视口截图（秒级）
- 对**非激活/被 OneTab 冻结**的标签截图可能卡住：先 `tabs.activate` 或 `page.activateAndShot` 激活该标签再截图（Agent 正常"导航→截图"流程不受影响）
- 扩展 MV3 service worker 会周期性休眠导致 WS 短暂断开：host 已内置"等待扩展重连（≤12s）再转发请求"，Agent 无感知

## 后续规划

- 更多页面事件类型与用户确认护栏
- 打包 .crx 分发与自动更新
