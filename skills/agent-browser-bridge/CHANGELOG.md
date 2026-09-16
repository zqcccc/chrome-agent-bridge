# 版本与更新（扩展 + 本地桥）

> 本文件给**使用本 skill 的 Agent** 看：判断用户本机的扩展版本够不够新、要不要提示用户更新、更新什么。
>
> **扩展不会自动更新**（未上架 Chrome 商店）。用之前先查版本：
>
> ```bash
> export BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token)
> ROOT="$(cd -P <skill 目录> && pwd)/../.."
> node "$ROOT/agent/cli.mjs" verify        # 会打印实际扩展版本
> curl -s -X POST http://127.0.0.1:8778/rpc -H "Authorization: Bearer $BRIDGE_TOKEN" \
>   -H 'Content-Type: application/json' \
>   -d '{"method":"bridge.status","params":{},"timeoutMs":8000}'   # result.version 即扩展版本
> ```
>
> 版本低于本文件「当前版本」时，按下面步骤提示用户更新，**不要自己去改用户的 Chrome**。

## 当前版本

| 部件 | 版本 | 位置 |
|---|---|---|
| 扩展 | **0.3.9** | `extension/manifest.json` |
| 本地桥 host | 0.3.0 | `relay/host.js` 的 `VERSION` |
| 本 skill | 随 ClawHub 发布 | — |

## 更新步骤（让用户执行，或经用户同意后代跑）

```bash
cd <仓库根> && git pull                     # 1. 拉最新代码
bash relay/install-host.sh <扩展ID>          # 2. 重注册 native host（扩展 ID 变了必须重跑）
# 3. 重载扩展（二选一）：
node agent/cli.mjs reload-ext                #    自动重载，约 2s，自动等重连
# 或：chrome://extensions 点扩展卡片上的刷新按钮
node agent/cli.mjs verify                    # 4. 确认版本
```

注意：

- **扩展 ID 在重新「加载已解压的扩展程序」后会变**，变了必须重跑 `install-host.sh`，否则 native 通道连不上（host 的 `allowed_origins` 里写的是旧 ID）。
- `reload-ext` 的 HTTP 响应会丢失（扩展 reload 连带关闭 native channel，host 进程退出后由 Chrome 重新拉起），**这是预期行为**，CLI 已改为轮询 `/status` 确认重连。
- 重载后**旧标签页的 content script 会失效**，对这些 tab 先跑 `tabs.prepare` 重新注入，或让用户刷新页面。
- 改 `relay/host.js` 要重启 host：`pkill -f "chrome-agent-bridge/relay/host.js"`（Chrome 会按需重新拉起）。

## 版本历史

### 0.3.9 — 2026-09-16

- **新增 `tabs.resolve`**：打开网址的首选入口。只复用**非活动**的同类 tab（排除聚焦窗口的活动页、pinned、discarded），没有就 `active:false` 静默新开后台 tab。
  - 解决的问题：过去脚本的 `tabs.find(t => t.url.includes(站点)) || tabs.find(t => t.active)` 有个坏 fallback——找不到匹配 tab 就拿用户当前正在看的页面去 `page.navigate`，**直接把人家看的页面顶掉**。
  - **自己写脚本时也不要再写「fallback 到 active tab」这句。**
  - 旧版返回 `UNKNOWN_METHOD` 时降级：`tabs.create({url, active:false})` 新开后台 tab（宁可多开一个，也不要动用户当前页）。

### 0.3.8 — 2026-09-14

- 新增 `extension.reload` RPC 与 `node agent/cli.mjs reload-ext`：免手工去 chrome://extensions 点刷新，改完扩展自己重载。
- 新增 `node agent/cli.mjs verify` 回归自检（15 项）。
- host 侧未捕获异常加固。

### 0.3.6

- **修掉 `sendMessage` 静默挂起**：`chrome.tabs.sendMessage` 对「content script 不存在」**不会 reject，会一直挂起**，曾导致上百次 TIMEOUT（多数在 `page.evaluate`）。现 ping 3s / 注入 10s / 求值 12s 全部包超时。
  - 若发现每个调用都要等几十秒才报 `PAGE_CONTEXT_TIMEOUT`，说明扩展版本过旧（0.3.6 以前）。

### 0.3.3

- `page.waitForReady` / `page.waitForUrl` / `page.waitForSelector` 增强等待（取代固定 sleep）。
- `page.evaluate` 在严格 CSP / Trusted Types 站点被拦时，**自动走 CDP `Runtime.evaluate` 兜底**重试一次（返回体带 `via:"cdp"`）。
- CDP 会话状态跟踪：重复 attach 返回 `{already:true}`；未 attach 就 send 报 `SESSION_NOT_ATTACHED`；`onDetach` 自动清理。
- 导航超时给 tab 打「上下文失效」标记（30s TTL），后续 evaluate 立即 `PAGE_CONTEXT_TIMEOUT` 快速失败。

### 0.3.2

- 「Agent 已放开」提示改为过场态，展示约 2.6s 后淡出，不再常驻页面右上角。

### 0.3.1

- **「接管中」滞留三层自愈**：indicator 按需补注入（幂等）、后台 15s 无控制请求自动撤销、扩展启动/更新时清扫残留标题。
  - 旧版现象：标签标题/badge 停在「● Agent 接管中」，因为扩展 reload 会销毁旧标签页的 indicator 实例，或页面被冻结时计时器不跑。

### 0.3.0

- **静默模式**：读/写/点击/截图默认不抢焦点、不切激活 tab。新增 `tabs.prepare`（注入 + 防后台冻结）代替 `tabs.activate`。
- 截图改 CDP 静默，后台 tab 也能截；CDP 失败不再自动激活窗口（报 `SCREENSHOT_FAILED`），需要时显式 `allowActivate:true` 或 `page.activateAndShot`。

### 0.2.0

- 首个开源版本。

---

## 版本不匹配的典型症状（快速归因）

| 症状 | 需要的最低版本 |
|---|---|
| 每个 `page.evaluate` 都卡满超时才报 `PAGE_CONTEXT_TIMEOUT` | 0.3.6 |
| 「● Agent 接管中」标题/badge 不消失 | 0.3.1 |
| `tabs.prepare` 返回 `UNKNOWN_METHOD` | 0.3.0 |
| `page.waitForReady` 返回 `UNKNOWN_METHOD` | 0.3.3 |
| `tabs.resolve` 返回 `UNKNOWN_METHOD` | 0.3.9 |
| chatgpt.com / github.com 上 `page.evaluate` 被 CSP 拦 | 0.3.3 |

`UNKNOWN_METHOD` 一律是「扩展版本不够新」的信号——不是站点问题，也不是脚本 bug。
