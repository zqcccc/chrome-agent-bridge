# 首次安装：Chrome 扩展 + 本地桥 host

**什么时候读本文件**：桥从未安装过——`~/.chrome-agent-bridge/token` 不存在（脚本报「读不到 token」）、
chrome://extensions 里没有 "Agent Browser Bridge"、native host 注册文件不存在。
已装过但连不上，按根 `SKILL.md`「前置条件」排查，不要重装。

前提：macOS + Google Chrome + Node.js ≥ 18。扩展**未上架 Chrome 网上应用店**，只能以「已解压扩展」方式加载。

## 分工：哪些 Agent 直接做完，哪些等用户点一下

| 步骤 | 谁做 | 说明 |
|---|---|---|
| 1. 克隆仓库、软链 Skill、注册 native host | **Agent 一口气做完**（先征得用户同意） | `install-host.sh` 会自动根据 `extension/` 路径算出 Chrome 扩展 ID，无需等用户手动复制 ID |
| 2. 在 `chrome://extensions` 加载 `extension/` 并重启 Chrome | **用户** | Chrome 受保护页不接受外部自动注入；重启会关掉现有窗口，由用户自己按 `⌘Q` |
| 3. 验证连接 | **Agent** | 只读自检 |

安装会改动用户的浏览器与本机配置：**开始前向用户说明将写入的路径，得到同意后一口气执行完第 1 步，再引导用户做第 2 步。**

## 步骤

### 1. Agent 执行：克隆代码、软链 Skill、注册 native host

```bash
git clone https://github.com/zqcccc/chrome-agent-bridge.git ~/code/chrome-agent-bridge
mkdir -p ~/.agents/skills
ln -sfn ~/code/chrome-agent-bridge/skills/agent-browser-bridge ~/.agents/skills/agent-browser-bridge
bash ~/code/chrome-agent-bridge/relay/install-host.sh
```

- 目录位置可由用户指定（下文用 `<仓库根>` 表示）。**注册后不要移动该目录**，因为 native host 注册文件里写的是 `<仓库根>/relay/host.sh` 的绝对路径。
- 若当前 Agent 使用 `~/.claude/skills` 等目录，也一并建立软链（或运行 `clawhub install agent-browser-bridge`）。
- `install-host.sh` 不传参数时会根据 `<仓库根>/extension` 的真实路径自动算出 Chrome 32 位扩展 ID 并写入 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.agentbrowser.bridge.json`（也可显式传 `bash install-host.sh <扩展ID>` 覆盖）。

### 2. 用户执行：加载扩展并重启 Chrome（把这段话发给用户）

> 本地桥与 Skill 已配置好。请在 Chrome 完成最后两步：
> 1. 打开 `chrome://extensions`，开启右上角「开发者模式」，点击「加载已解压的扩展程序」，选择 `<仓库根>/extension` 目录。
> 2. 按 `⌘Q` 完全退出 Chrome（只关窗口不够），再重新打开告诉我。

### 3. Agent 执行：验证连接

```bash
curl -s http://127.0.0.1:8778/status
node <仓库根>/agent/cli.mjs verify
```

`/status` 应返回 `"ok":true`、`"extConnected":true`、`"mode":"native"`，且 `verify` 全部通过。不通过时按根 `SKILL.md`「前置条件」排查（最常见：用户未按 `⌘Q` 完全退出 Chrome，或扩展加载的目录与注册目录不一致）。

## 注意

- 扩展不会自动更新。升级流程见 `CHANGELOG.md`（`git pull` + `node agent/cli.mjs reload-ext` + `node agent/cli.mjs verify`）。
- 推荐只用 Native 模式，不要另外 `npm start` 起 standalone host（会占用 8778 端口，导致 native host 启动失败）。
