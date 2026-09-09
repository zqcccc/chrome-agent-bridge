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
5. 操作会发送消息、投递、下单、删除或提交表单时，必须先向用户展示最终动作和目标，获得明确确认后再执行。
6. 遇到登录、验证码、支付、二次确认或安全检查时停止并交给用户。

可以使用客户端库：

```js
import { Bridge } from "./agent/client.mjs";

const bridge = new Bridge();
const status = await bridge.status();
if (!status.extConnected) throw new Error("Chrome extension is not connected");

const tabs = await bridge.list();
const target = tabs.find((tab) => tab.active);
if (!target) throw new Error("No active tab");

const snapshot = await bridge.snapshot(target.id, { mode: "a11y" });
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
