# Agent Browser Bridge

**一句话：你在 Chrome 里能做的事，让 AI 替你做。**

装上它之后，你的 AI 助手（Claude Code / Codex / OpenClaw / Cursor 等）就能直接操作你正在用的 Chrome：打开网页、读内容、点击、填表、截图、抓取登录后才能看到的数据——用的是**你自己的浏览器和登录态**，不是无头模拟器。

[安全说明](SECURITY.md) · [给 AI Agent 的接入指南](docs/AI-INTEGRATION.md) · [MIT License](LICENSE)

---

## 一句话安装（复制发给你的 AI Agent）

把下面这段话直接发给你的 AI 助手，它会自己克隆代码、装好 Skill、注册本地桥，并引导你完成最后一步：

```text
请帮我安装 Agent Browser Bridge：将 https://github.com/zqcccc/chrome-agent-bridge.git 克隆到本地，按仓库内 skills/agent-browser-bridge/INSTALL.md 完成 Skill 软链与 Native Host 注册，然后引导我在 Chrome 加载 extension/ 目录并验证连接。
```

AI 配好本地环境后，你只需要按它的提示在 `chrome://extensions` 里点一下「加载已解压的扩展程序」选中 `extension/` 目录，再按 `⌘Q` 重启一次 Chrome 即可。

<details>
<summary>手动安装步骤（不想让 AI 代劳时）</summary>

1. **克隆并注册本地桥 + Skill**：
   ```bash
   git clone https://github.com/zqcccc/chrome-agent-bridge.git ~/code/chrome-agent-bridge
   bash ~/code/chrome-agent-bridge/relay/install-host.sh
   mkdir -p ~/.agents/skills
   ln -sfn ~/code/chrome-agent-bridge/skills/agent-browser-bridge ~/.agents/skills/agent-browser-bridge
   ```
2. **在 Chrome 加载扩展**：
   - 打开 `chrome://extensions`，右上角开启「开发者模式」
   - 点「加载已解压的扩展程序」，选择 `~/code/chrome-agent-bridge/extension` 目录
   - 按 `⌘Q` **完全退出 Chrome 再重新打开**
3. **验证连接**：
   ```bash
   curl -s http://127.0.0.1:8778/status   # 看到 "extConnected":true 即成功
   ```

</details>

---

## 装完能干什么

| 你想做的事 | 直接跟 AI 说 |
|---|---|
| 查资料 | 「去小红书搜 XX 的口碑，把评论区吐槽整理出来」 |
| 抓数据 | 「把 BOSS 直聘上这个筛选条件下前 20 个岗位的 JD 抓成表格」 |
| 读登录后的页面 | 「打开我公众号后台，看看昨天那篇的数据」 |
| 填表 / 提交 | 「帮我在这个后台把这条记录的状态改成已审核」 |
| 看页面长什么样 | 「截个图给我看看这个页面现在渲染成什么样」 |

普通 AI 工具打不开的页面（要扫码登录、有验证码、反爬、内容动态渲染），它都能进——因为那就是你在用的真实 Chrome。

**唯一该先试 curl 的情况**：目标本身就是 JSON / XML / 纯文本（API、`.md`、`.csv`、`robots.txt`）。只要是**给人看的网页**，就直接用它——现代前端站点（React / Vue / SPA）用 curl 只能拿到空壳 HTML，`body` 可见文本长度为 0，而且**不报错**，很容易让人以为读到了、实际什么都没读到。

---

## 更新

同样把下面这句话发给你的 AI：

```text
请帮我更新本机的 Agent Browser Bridge：在本地 chrome-agent-bridge 仓库执行 git pull，运行 node agent/cli.mjs reload-ext 自动重载 Chrome 扩展（若 relay/host.js 有变更则重启本地 host 进程），最后运行 node agent/cli.mjs verify 确认版本与自检全绿。
```

扩展未上架 Chrome 商店，不会自动更新。更新了什么、某个报错是不是版本太旧，记录在 [`skills/agent-browser-bridge/CHANGELOG.md`](skills/agent-browser-bridge/CHANGELOG.md)。

---

## 常见问题

**`/status` 里 `extConnected:false`**
扩展没连上。看 `~/.chrome-agent-bridge/host.log` 里的报错码：

```bash
grep -o "code=[A-Z_]*" ~/.chrome-agent-bridge/host.log | sort | uniq -c | sort -rn
```

最常见的两个原因：一是 `install-host.sh` 里的扩展 ID 填错了（扩展重新加载后 ID 会变，要重跑一次脚本）；二是 Chrome 没重启。

**页面操作报 `PAGE_CONTEXT_TIMEOUT`**
扩展刷新后旧标签页里的脚本实例失效了。刷新那个页面，或对它先跑一次 `node agent/cli.mjs` 的注入。

**`chrome://` 开头的页面操作不了**
正常，Chrome 不允许往这类页面注入脚本。

**会遇到验证码 / 登录墙吗**
会。这是设计的一部分：AI 不会替你登录、不会绕过验证。它停下来告诉你「需要你手动登录一下」，你登完它继续。

**安全吗**
本地桥只监听 `127.0.0.1`，不对外网开放；调用要带 token；密码、验证码这类字段在页面快照里会自动打码，不会进 AI 的上下文。详见 [SECURITY.md](SECURITY.md)。

---

## 它是怎么工作的

```
你的 Chrome（真实登录态）
    │  Native Messaging
    ▼
本地桥 host（127.0.0.1:8778）
    │  HTTP / WS + Bearer token
    ▼
你的 AI 助手
```

- **扩展**（`extension/`）：装在 Chrome 里，负责读页面、点击、输入、截图
- **本地桥**（`relay/`）：本机 Node 进程，转发 AI 和扩展之间的消息
- **Skill**（`skills/agent-browser-bridge/`）：教 AI 怎么用这套东西、哪些坑要避开；自带命令行 `scripts/bb.mjs` 与 JS 库 `scripts/lib/bridge.mjs`
- **MCP server**（`mcp/`）：把常用能力暴露为 MCP 工具（`browser_read` / `browser_click` …），支持 MCP 的 AI 助手直接调用
- **开发工具**（`agent/`）：扩展自重载、回归自检

跟 ChatGPT for Chrome、Claude in Chrome 的思路一样：**装进你日常用的浏览器**，而不是另开一个无头浏览器。

### 接入 MCP（Claude Code 等支持 MCP 的助手）

```bash
cd mcp && npm install
claude mcp add agent-browser-bridge -- node "$(pwd)/server.mjs"
```

之后助手可直接调用 `browser_read`（读网页）、`browser_snapshot`（元素清单，带 `[e1]` 编号）、`browser_click` / `browser_type`（按编号操作，返回是否生效）、
`browser_screenshot`、`browser_rpc`（任意桥方法）等工具。

### 命令行用法

```bash
BB="node skills/agent-browser-bridge/scripts/bb.mjs"   # token 自动从 ~/.chrome-agent-bridge/token 读取

$BB status                       # 状态和连接
$BB tabs                         # 列出所有标签页（拿 tabId）
$BB read <url>                   # 读网页正文 + 主链接 + 阻断诊断
$BB open <url>                   # 打开网址（不抢你正在看的标签页）
$BB snap <tabId>                 # 元素清单，[e1] 编号可直接传给 click / type
$BB click-real <tabId> @e2       # 真实鼠标点击
$BB type-real <tabId> @e1 "要输入的话" --enter
$BB wait <tabId> selector ".result"
$BB methods                      # 全部 RPC 方法与参数
$BB                              # 不带参数列出全部命令

node agent/cli.mjs verify        # 回归自检，改完代码跑一次
```

### 代码调用

```js
import { Rpc } from "./skills/agent-browser-bridge/scripts/lib/bridge.mjs";
const rpc = new Rpc({ agentName: "MyTask" });
const page = await rpc.readPage("https://example.com");
await rpc.withPage("https://example.com", async (tabId) => {
  const snap = await rpc.snapshotCompact(tabId);
  const r = await rpc.clickReal(tabId, "@e1");   // r.delta 说明点击后页面变了什么
});
```

### Firefox

同一套 RPC 也能操作 Firefox（host 端口 8779）。安装见 [`skills/agent-browser-bridge/INSTALL.md`](skills/agent-browser-bridge/INSTALL.md)「Firefox」一节；之后 AI 侧只需设 `BRIDGE_BROWSER=firefox`：

```bash
bash relay/install-host.sh --browser firefox   # 注册一次
node relay/firefox-launch.js                   # 每次打开 Firefox 都用它（以 Remote Agent 模式启动并装上扩展）
BRIDGE_BROWSER=firefox node skills/agent-browser-bridge/scripts/bb.mjs tabs
```

注意：Firefox 以 Remote Agent 模式运行期间，地址栏会一直显示条纹背景和机器人图标，所有网页读到的 `navigator.webdriver` 都是 `true`，风控严格的站点建议用 Chrome。详见 [`firefox/SKILL.md`](skills/agent-browser-bridge/firefox/SKILL.md)「使用痕迹」。

完整的 RPC 清单、错误码、多 Agent 并行与 Tab 租约、CDP 直通等，见 [docs/AI-INTEGRATION.md](docs/AI-INTEGRATION.md) 和 [`skills/agent-browser-bridge/SKILL.md`](skills/agent-browser-bridge/SKILL.md)。

---

## 目录结构

```
chrome-agent-bridge/
├── extension/               # MV3 扩展（Chrome 直接加载；Firefox 版由 relay/build-firefox.js 生成到 dist/firefox）
├── relay/                   # 本地桥（native host + HTTP/WS 服务）
├── agent/                   # 开发工具（cli.mjs：reload-ext / verify；client.mjs）
├── mcp/                     # MCP server（server.mjs）
├── docs/AI-INTEGRATION.md   # 给 AI Agent 的接入与操作指南
└── skills/
    └── agent-browser-bridge/  # 配套 Skill（含 xhs/ boss/ chatgpt/ notebooklm/ 子技能）
```

## 发布 Skill

```bash
clawhub login
clawhub publish ./skills/agent-browser-bridge \
  --slug agent-browser-bridge --version 0.3.15 \
  --tags latest,browser,chrome --changelog "见 CHANGELOG.md"
```

## 测试

```bash
cd relay && npm test
```

## 已知边界

- 只支持 macOS；浏览器支持 Google Chrome 与 Firefox（Firefox 需用 `relay/firefox-launch.js` 启动，差异见 [`skills/agent-browser-bridge/firefox/SKILL.md`](skills/agent-browser-bridge/firefox/SKILL.md)）
- `chrome://` 等受保护页面不能注入脚本
- 超长页面整页截图较慢，默认只截视口
- 扩展 MV3 的 service worker 会周期性休眠，导致短暂断连（host 已内置自动等待重连，AI 无感知）
