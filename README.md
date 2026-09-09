# Agent Browser Bridge

> macOS + Google Chrome 的本地 Agent 浏览器桥。面向开发者和 Agent 基础设施使用，不是隔离浏览器或安全沙箱。

[Security model](SECURITY.md) · [MIT License](LICENSE)

通用浏览器桥：让本地 Agent 通过安全通道接管你日常使用的 Chrome——列出/管理标签页、导航、读取页面、点击、输入、滚动、截图。

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

- **扩展（extension/）**：MV3 后台脚本 + 页面注入脚本。负责连接本地桥（Native Messaging 优先，失败自动回退 WebSocket）、RPC 分发、标签页管理、页面快照与操作、截图、导航等待。
- **本地桥（relay/）**：既是 Native Messaging host 进程，又是 HTTP/WS 服务端。单进程双角色：Chrome 通过 native 或 ws 连进来，Agent 通过 HTTP/WS 连进来，两边消息转发。
- **Agent 客户端（agent/）**：给 Agent 用的 JS 客户端与命令行工具。

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
│   └── test.js           # 集成测试（11/11）
├── agent/
│   ├── client.mjs        # Bridge 客户端类
│   └── cli.mjs           # 命令行工具
└── README.md
```

## 安装

### 1. 加载扩展

1. 打开 `chrome://extensions`，右上角开启「开发者模式」
2. 点「加载已解压的扩展程序」，选择 `extension/` 目录
3. 记下扩展卡片上显示的 ID（每个本地安装的 ID 可能不同）

### 2. 启动本地桥

```bash
cd relay
npm start                # 等价于 node host.js --standalone
# 首次启动生成 token，保存在 ~/.chrome-agent-bridge/token，日志在 ~/.chrome-agent-bridge/host.log
```

端口默认 `8778`，可用 `--port` 修改。

### 3. 注册 Native Messaging Host（可选，推荐）

```bash
cd relay
bash install-host.sh <你的扩展ID>
```

注册后**重启 Chrome** 生效。Native Messaging 与 ChatGPT/Claude 插件同款通道，无需 HTTP 端口暴露给扩展。

> **两种运行模式（二选一）**
> - **Native 模式（推荐）**：不启动 standalone host。Chrome 通过 Native Messaging 按需拉起 `host.js`，该进程自己监听 8778；Agent 连 8778 即是同一进程。Chrome 关闭连接时进程自动退出，无需常驻。
> - **WS 模式**：手动启动 `npm start`（standalone host 常驻 8778），扩展通过 `ws://127.0.0.1:8778/agent` 连接。
> - 注意：两种模式**不要同时运行**。standalone 占着 8778 时，native 拉起的进程会因端口占用自动退出，扩展 `auto` 通道会回退到 WS（已内置该逻辑）。

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
const bridge = new Bridge({ port: 8778, token: "..." });
await bridge.rpc("tabs.list");
await bridge.rpc("page.snapshot", { mode: "a11y" });
await bridge.rpc("page.click", { selector: "#submit" });
await bridge.rpc("page.screenshot");
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
- **导航等待**：`webNavigation.onCommitted` + 轮询兜底，默认 45s 超时
- **视觉指示器**：幽灵光标 + 点击涟漪 + 停止按钮（页面内 `agent-bridge-cursor` / `agent-bridge-stop`），Agent 可远程开关
- **事件订阅**：页面事件实时推送（导航、点击、输入等）

## 安全

- 本地桥只监听 `127.0.0.1`，不对外网暴露
- Agent 调用需 Bearer token（首次启动随机生成，0600 权限）
- 敏感字段（密码、hidden、信用卡、验证码等）在页面快照中自动遮蔽，不进入 Agent 上下文
- 停止按钮可随时打断 Agent 的页面操作

## 测试

```bash
cd relay && npm test     # 集成测试（鉴权、RPC 转发、错误传播、事件广播）
```


已知边界：
- `chrome://` 等受保护页面禁止内容注入（快照/操作不可用），截图需 `activeTab` 授权（点击一次扩展图标即可）
- 超长页面整页截图（`captureBeyondViewport:true`）可能较慢，默认视口截图（秒级）
- 对**非激活/被 OneTab 冻结**的标签截图可能卡住：先 `tabs.activate` 或 `page.activateAndShot` 激活该标签再截图（Agent 正常"导航→截图"流程不受影响）
- 扩展 MV3 service worker 会周期性休眠导致 WS 短暂断开：host 已内置"等待扩展重连（≤12s）再转发请求"，Agent 无感知

## 后续规划

- 更多页面事件类型与用户确认护栏
- 打包 .crx 分发与自动更新
