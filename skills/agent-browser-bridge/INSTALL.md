# 首次安装：Chrome 扩展 + 本地桥 host

**什么时候读本文件**：桥从未安装过——`~/.chrome-agent-bridge/token` 不存在（脚本报「读不到 token」）、
chrome://extensions 里没有 "Agent Browser Bridge"、native host 注册文件不存在。
已装过但连不上，按根 `SKILL.md`「前置条件」排查，不要重装。

前提：macOS + Google Chrome + Node.js ≥ 18。扩展**未上架 Chrome 网上应用店**，只能以「已解压扩展」方式加载。

## 分工：哪些 Agent 能做，哪些必须用户做

| 步骤 | 谁做 | 原因 |
|---|---|---|
| 1. 获取代码 | Agent（先征得用户同意） | 普通 `git clone` |
| 2. 加载已解压扩展、复制扩展 ID | **用户** | chrome://extensions 是受保护页，桥不能操作；扩展此时也还没装 |
| 3. 注册 native host | Agent（先征得用户同意） | 写入 Chrome 配置目录，属于改用户环境 |
| 4. 完全退出并重开 Chrome | **用户** | 会关闭用户所有窗口，不要替用户执行 |
| 5. 验证 | Agent | 只读检查 |

安装会改动用户的浏览器与本机配置：**开始前向用户说明上面五步、要写入的路径，得到同意再执行。**

## 步骤

### 1. 获取代码

```bash
git clone https://github.com/zqcccc/chrome-agent-bridge.git ~/code/chrome-agent-bridge
```

目录位置可由用户指定。下文用 `<仓库根>` 表示该目录。**之后不要移动这个目录**：
native host 注册文件里写的是 `<仓库根>/relay/host.sh` 的绝对路径。

### 2. 用户加载扩展（把这段话原样告诉用户）

> 1. 在 Chrome 地址栏打开 `chrome://extensions`，打开右上角「开发者模式」。
> 2. 点「加载已解压的扩展程序」，选择 `<仓库根>/extension` 目录。
> 3. 在出现的 "Agent Browser Bridge" 卡片上复制 ID（32 个小写字母，形如 `abcdefghijklmnopqrstuvwxyzabcdef`），发给我。

### 3. 注册 native host

```bash
bash <仓库根>/relay/install-host.sh <扩展ID>
```

它写入两处：

- `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.agentbrowser.bridge.json`
  （`allowed_origins` 是该扩展 ID，`path` 指向 `<仓库根>/relay/host.sh`）
- `~/.chrome-agent-bridge/token`（RPC 鉴权用，权限 600）

不传扩展 ID 时脚本会交互式询问；Agent 调用时始终传参。

### 4. 用户完全退出并重开 Chrome

告诉用户：按 `⌘Q` 完全退出 Chrome（只关窗口不够），再打开。Chrome 重启后才会按新注册文件拉起 host。

### 5. 验证

```bash
curl -s http://127.0.0.1:8778/status
node scripts/preflight.mjs        # 在 skill 目录下执行；退出码 0 = 可开工
```

`/status` 应返回 `"ok":true`、`"extConnected":true`、`"mode":"native"`。不通过时按根 `SKILL.md`
「前置条件」第 2、3 条排查（最常见：host 启动脚本找不到 node，看 `~/.chrome-agent-bridge/host.log`）。

## 注意

- **重新「加载已解压」会改变扩展 ID**，之后必须用新 ID 重跑第 3 步。
- 扩展不会自动更新。升级流程见 `CHANGELOG.md`（`git pull` + `install-host.sh` + 重载扩展）。
- 推荐只用 Native 模式，不要另外 `npm start` 起 standalone host（会占用 8778 端口，导致 native host 启动失败）。
