# Agent Browser Bridge

**一句话：你在 Chrome 里能做的事，让 AI 替你做。**

装上它之后，你的 AI 助手（Claude Code / Codex / 任何支持 Skill 的 Agent）就能直接操作你正在用的 Chrome：打开网页、读内容、点击、填表、截图、抓取登录后才能看到的数据——用的是**你自己的浏览器和登录态**，不是无头模拟器。

[安全说明](SECURITY.md) · [给 AI Agent 的接入指南](docs/AI-INTEGRATION.md) · [MIT License](LICENSE)

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

## 30 秒安装

### 第 1 步：装 Chrome 扩展

1. 下载本仓库：`git clone https://github.com/zqcccc/chrome-agent-bridge.git`
2. 打开 `chrome://extensions`，右上角开「开发者模式」
3. 点「加载已解压的扩展程序」，选仓库里的 `extension/` 目录
4. 复制卡片上显示的**扩展 ID**（32 位字母，每人不同）

### 第 2 步：注册本地桥（一条命令）

```bash
cd chrome-agent-bridge/relay
bash install-host.sh <刚才复制的扩展ID>
```

然后**完全退出 Chrome 再重新打开**（不是关窗口，是 Cmd+Q）。

这条命令会做两件事：告诉 Chrome「这个扩展可以跟我本机的桥通信」，并首次启动时在 `~/.chrome-agent-bridge/token` 生成一个本地密钥。

### 第 3 步：验证

```bash
curl -s http://127.0.0.1:8778/status
```

看到 `"extConnected":true` 就装好了。

### 第 4 步（可选）：让 AI 知道怎么用它

装配套 Skill，AI 才会主动用这个桥：

```bash
clawhub install agent-browser-bridge
```

装完之后，你直接跟 AI 说「去小红书搜 XX」就行，不用教它。

> 不用 ClawHub 也行：把这句丢给你的 AI 即可（它会自己读文档完成配置）：
>
> ```text
> 请从 https://github.com/zqcccc/chrome-agent-bridge.git 克隆 Agent Browser Bridge，
> 并阅读仓库中的 docs/AI-INTEGRATION.md、SECURITY.md 和 skills/agent-browser-bridge/SKILL.md，
> 按照接入指南完成 macOS + Google Chrome 的本地配置。
> 请在执行任何修改系统、Chrome 设置或网页不可逆操作前先向我说明并获得确认；
> 不要输出或提交 ~/.chrome-agent-bridge/token。
> 最后用 /status 和 agent/cli.mjs tabs 验证连接。
> ```

---

## 更新

三个部件分开更新，各管各的：

| 部件 | 怎么更新 | 频率 |
|---|---|---|
| **Skill**（AI 的操作手册） | `clawhub update` | 最勤，跟着功能走 |
| **扩展**（Chrome 里那个） | `git pull` 后在 `chrome://extensions` 点一下刷新（或 `node agent/cli.mjs reload-ext`） | 有新能力时 |
| **本地桥 host** | `git pull` 后重跑 `bash install-host.sh <扩展ID>`，重启 Chrome | 跟扩展一起 |

扩展因为没上架 Chrome 商店，不会自动更新。**该不该更新、更新了什么**，写在 skill 里的 [`skills/agent-browser-bridge/CHANGELOG.md`](skills/agent-browser-bridge/CHANGELOG.md)——用之前让 AI 查一下当前版本对不对。

查自己装的扩展版本：

```bash
export BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token)
node agent/cli.mjs verify
# ✓ 扩展版本 >= 0.3.3（已加载修复后的代码）  → 实际 0.3.9
```

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
- **AI 客户端**（`agent/`）：给 AI 用的命令行和 JS 库
- **Skill**（`skills/agent-browser-bridge/`）：教 AI 怎么用这套东西、哪些坑要避开

跟 ChatGPT for Chrome、Claude in Chrome 的思路一样：**装进你日常用的浏览器**，而不是另开一个无头浏览器。

### 命令行用法

```bash
export BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token)

node agent/cli.mjs status              # 状态和连接
node agent/cli.mjs tabs                # 列出所有标签页（拿 tabId）
node agent/cli.mjs open <url>          # 打开网址（不抢你正在看的标签页）
node agent/cli.mjs snap <tabId>        # 页面快照
node agent/cli.mjs shot <tabId>        # 截图
node agent/cli.mjs click <tabId> "button[type=submit]"
node agent/cli.mjs type <tabId> "input#q" "要输入的话"
node agent/cli.mjs wait <tabId> selector ".result"   # 等元素出现
node agent/cli.mjs verify              # 回归自检，改完代码跑一次
```

### 代码调用

```js
import { Bridge } from "./agent/client.mjs";
const bridge = new Bridge({ port: 8778, token: process.env.BRIDGE_TOKEN });
await bridge.rpc("tabs.list");
await bridge.rpc("page.snapshot", { mode: "a11y" });
await bridge.rpc("page.click", { selector: "#submit" });
```

完整的 RPC 清单、错误码、多 Agent 并行与 Tab 租约、CDP 直通等，见 [docs/AI-INTEGRATION.md](docs/AI-INTEGRATION.md) 和 [`skills/agent-browser-bridge/SKILL.md`](skills/agent-browser-bridge/SKILL.md)。

---

## 目录结构

```
chrome-agent-bridge/
├── extension/               # Chrome MV3 扩展
├── relay/                   # 本地桥（native host + HTTP/WS 服务）
├── agent/                   # AI 客户端（cli.mjs / client.mjs）
├── docs/AI-INTEGRATION.md   # 给 AI Agent 的接入与操作指南
└── skills/
    └── agent-browser-bridge/  # 配套 Skill（含 xhs/ boss/ chatgpt/ notebooklm/ 子技能）
```

## 发布 Skill

```bash
clawhub login
clawhub publish ./skills/agent-browser-bridge \
  --slug agent-browser-bridge --version 0.3.11 \
  --tags latest,browser,chrome --changelog "见 CHANGELOG.md"
```

## 测试

```bash
cd relay && npm test
```

## 已知边界

- 只支持 macOS + Google Chrome
- `chrome://` 等受保护页面不能注入脚本
- 超长页面整页截图较慢，默认只截视口
- 扩展 MV3 的 service worker 会周期性休眠，导致短暂断连（host 已内置自动等待重连，AI 无感知）
