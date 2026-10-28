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

## Firefox（可选，在 Chrome 安装完成后进行）

前提：Firefox ≥ 140、Node.js ≥ 22（host 用 Node 内置 WebSocket 连接 Firefox 的 Remote Agent）。
Firefox 版扩展**未签名**，正式版 Firefox 只能把它装成「临时扩展」，Firefox 重启后会消失——
所以每次都用启动器启动 Firefox，由它以 Remote Agent 模式启动 Firefox 并重新装上扩展。

**安装前先告诉用户**：以 Remote Agent 模式启动后，Firefox 地址栏会一直显示条纹背景与机器人图标，所有网页读到的
`navigator.webdriver` 都是 `true`（包括用户自己浏览的页面），风控站点可能因此识别为自动化。这些在桥没有操作时也存在。
完整说明见 `firefox/SKILL.md`「使用痕迹」。

| 步骤 | 谁做 | 说明 |
|---|---|---|
| 1. 注册 Firefox native host | **Agent**（先征得用户同意） | 写入 `~/Library/Application Support/Mozilla/NativeMessagingHosts/com.agentbrowser.bridge.json` |
| 2. 完全退出 Firefox | **用户** | 启动器不会结束用户正在用的 Firefox |
| 3. 启动 Firefox 并装扩展 | **Agent** | 用户的默认 profile、登录态不变 |
| 4. 验证连接 | **Agent** | 只读自检 |

```bash
# 1. Agent 执行
bash <仓库根>/relay/install-host.sh --browser firefox

# 2. 把这句话发给用户：「请按 ⌘Q 完全退出 Firefox，好了告诉我。」

# 3. Agent 执行（之后每次重启 Firefox 都用这条命令打开）
node <仓库根>/relay/firefox-launch.js

# 4. Agent 执行
curl -s http://127.0.0.1:8779/status          # "browser":"firefox"，"extConnected":true
BRIDGE_BROWSER=firefox BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node <仓库根>/agent/cli.mjs verify
```

### 永久安装（签名版，免每次重装）

临时扩展每次重启 Firefox 都要重装。用 AMO 自分发（unlisted）签名后可永久安装，扩展不会公开上架：

```bash
# 凭据：https://addons.mozilla.org/developers/addon/api/key/ 生成（需登录 Mozilla 账号、开两步验证、接受开发者协议、确认邮箱）
# 写入 ~/.chrome-agent-bridge/amo-credentials（chmod 600）：
#   WEB_EXT_API_KEY=user:12345678:123
#   WEB_EXT_API_SECRET=<secret>
node <仓库根>/relay/sign-firefox.js                 # 产物 dist/firefox-signed/*.xpi
# Firefox 须已退出；启动后立即永久安装（BiDi 私有参数 moz:permanent，不弹确认框，<all_urls> 权限一并授予）
node <仓库根>/relay/firefox-launch.js --no-install --install-xpi <仓库根>/dist/firefox-signed/<文件名>.xpi
```

装好后启动 Firefox 改用 `node <仓库根>/relay/firefox-launch.js --no-install`（只带 Remote Agent 启动参数，不再装临时扩展）。
不加 `--no-install` 会用未签名的 `dist/firefox/` 临时覆盖已安装的签名版（重启 Firefox 后恢复）。
AMO 不接受重复版本号：扩展升级后先升 `extension/manifest.json` 的 version 再签名，再用 `--install-xpi` 装新的 `.xpi`。
`--install-xpi` 要在 host 连上 BiDi 之前执行（Firefox 只允许一个 BiDi 会话），所以放在启动 Firefox 的同一条命令里。

启动器参数：`--profile <目录>`（用独立 profile 另起一个实例，可与日常 Firefox 并存）、`--bidi-port <端口>`（默认 9222）、
`--no-install`（扩展已永久安装时跳过安装）。用户从 Dock 直接打开 Firefox 时，扩展与 Remote Agent 都不在，
需要重新执行第 3 步。

告知用户两点：Remote Agent 开启期间地址栏会显示远程控制标识；页面里的 `navigator.webdriver` 为 `true`，
风控严格的站点（BOSS 直聘、小红书等）可能识别为自动化，这类站点优先用 Chrome。
