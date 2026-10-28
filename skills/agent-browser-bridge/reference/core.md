# 核心 RPC 详解

手写参考：参数、返回结构与最小示例。全部方法的索引见同目录 `rpc.md`；运行时调 `bridge.methods`（或 `help`）取同一份数据，
方法名写错时 `UNKNOWN_METHOD` 的 `error.details.suggestions` 给出最接近的方法名。

HTTP 调用格式：`POST http://127.0.0.1:8778/rpc`
请求头：`Authorization: Bearer <token>`、`Content-Type: application/json`、`X-Agent-Id: <id>`、`X-Agent-Name: <urlEncodedName>`
请求体：`{"method":"<method>","params":{...},"timeoutMs":20000}`

## 1. 一键读取网页：`page.read`（v0.3.13+）

单次调用完成：`tabs.resolve` 复用/后台新开 → `waitForReady` → 提取正文/标题/主链接 + `blocker` 阻断诊断 → **若因后台渲染暂停导致正文为空（`textLength < 80` 且 `document.hidden`）则自动临时 `ensureActive` 唤醒重读并归还** → 自动关闭本次新建的标签页。

- 参数：

  | 参数 | 类型 | 默认 | 说明 |
  |---|---|---|---|
  | url | string | 与 tabId 二选一 | 目标网址（未传 tabId 时自动走 `tabs.resolve`） |
  | tabId | number | 与 url 二选一 | 指定已有标签页读取（可同时传 url 导航后读取） |
  | maxLength | number | 20000 | 返回正文最大字符数 |
  | includeLinks | boolean | true | 是否提取正文区域可见链接 |
  | maxLinks | number | 30 | 最多返回链接数 |
  | keepOpen | boolean | false | 新建 tab 时是否保留不关（复用已有 tab 时永不关） |
  | waitMs | number | 0 | 就绪后额外等待毫秒数（重度异步渲染页面可用） |

- 返回示例：

  ```json
  {
    "ok": true,
    "tabId": 681467890,
    "reused": false,
    "closed": true,
    "activatedForRender": false,
    "url": "https://example.com/",
    "title": "Example Domain",
    "description": "...",
    "textLength": 1250,
    "truncated": false,
    "text": "Example Domain ...",
    "headings": [{ "level": "h1", "text": "Example Domain" }],
    "links": [{ "text": "More information...", "href": "https://www.iana.org/domains/example" }],
    "blocker": null
  }
  ```

- 最小可用示例：

  ```js
  const r = await rpc.readPage("https://example.com/docs");
  if (r.blocker) console.error("页面受阻:", r.blocker);
  else console.log(r.title, r.text);
  ```

## 2. 快照、紧凑模式与持久化元素引用 `ref`：`page.snapshot`（v0.3.13+ 增强）

`page.snapshot` 在页面 isolated world 内存中为每个可见交互元素分配稳定短标号（`e1`, `e2`, ...，不修改页面 DOM 属性，零指纹暴露）。

- 参数：`{ tabId, mode: "compact" | "elements" | "a11y" | "text" | "full", includeText: true, maxElements: 200 }`
- 返回（`mode: "compact"`）：

  ```json
  {
    "url": "https://example.com",
    "title": "Example",
    "readyState": "complete",
    "mode": "compact",
    "elementCount": 2,
    "compact": "[e1] textbox \"搜索关键词\" @(420,120)\n[e2] button \"搜索\" @(560,120)",
    "text": "页面正文..."
  }
  ```

- **用 `ref` 直接定位元素**：`page.click`、`page.clickReal`、`page.type`、`page.typeReal`、`page.hover`、`page.focusEl`、`page.select`、`page.press` 均支持传 `{"tabId": 1, "ref": "e2"}` 或 `{"tabId": 1, "selector": "@e2"}`。
- 若该 DOM 节点已在页面重渲染后被移除，立即报 `STALE_ELEMENT_REF`（`details: { ref: "e2", stale: true }`），不会像 `by: "index"` 那样因下标错位误点其他按钮。

## 3. 扩展内原子 CDP 操作：`page.evalCdp` / `page.clickReal` / `page.typeReal` / `page.uploadFile`（v0.3.13+）

全部在扩展内通过 `withBorrowedDebugger` 单次完成并自动归还调试器（若 Agent 已显式 `session.attach` 则复用且不拆会话）：

| 方法 | 参数 | 返回示例 | 适用场景 |
|---|---|---|---|
| `page.evalCdp` | `{ tabId, expression, awaitPromise?, userGesture? }` | `{ result: <值>, via: "cdp" }` | 严格 CSP / Trusted Types 站点（如 chatgpt.com、linkedin.com、github.com）单次求值 |
| `page.clickReal` | `{ tabId, selector?, ref?, by?, x?, y?, button?, clickCount?, delayMs? }` | `{ ok: true, x, y, ref, tag, text, via: "cdp", delta }` | React/Vue 菜单展开、只认真实鼠标事件的组件（传选择器或 `@e1` 自动滚动居中算坐标） |
| `page.typeReal` | `{ tabId, selector?, ref?, by?, text, clear?: true, pressEnter?: false }` | `{ ok: true, ref, tag, value, verified: true, via: "cdp", delta }` | React/Vue/ProseMirror 受控输入框（自动聚焦 + 清空 + CDP `Input.insertText` + 回读校验） |
| `page.uploadFile` | `{ tabId, selector?: 'input[type="file"]', files: string[] }` | `{ ok: true, selector, count, files, via: "cdp" }` | 给 `<input type="file">` 注入本地文件绝对路径 |

**Chrome 的后台标签页（`document.hidden`）不处理 CDP 鼠标与按键事件**（实测：点击约 6s 后返回、页面毫无反应；Firefox 经 BiDi 派发不受影响）。
`page.clickReal` 与带 `pressEnter` 的 `page.typeReal` 在后台标签页上直接报 `TAB_HIDDEN`（`details: { recoverable: true }`，此时尚未改动页面），
先 `page.ensureActive` 再重试。`Input.insertText` 不受影响，不带 `pressEnter` 的 `typeReal` 在后台可用。
`scripts/lib/bridge.mjs` 的 `rpc.clickReal()` / `rpc.typeReal()` 与 MCP 的 `browser_click` / `browser_type` 遇 `TAB_HIDDEN` 自动 `ensureActive` 后重试一次（返回值带 `activated: true`）。

`typeReal` 的 `verified` 在按回车之前回读（回车常触发提交 / 导航，之后焦点已不在输入框）；比对在页面内完成，密码框也能得到 `verified`，返回的 `value` 为 `[value redacted]`。

最小可用示例：

```js
// 受控输入框写入并一步校验确实写进去了
const res = await rpc.typeReal(tabId, "@e1", "前端开发工程师", { pressEnter: true });
if (!res.verified) throw new Error(`输入未生效，当前值: ${res.value}`);
console.log("回车后 URL 是否变化:", res.delta?.urlChanged);
```

## 4. 交互动作增量状态（Action Delta，v0.3.13+）

`page.click`、`page.clickReal`、`page.type`、`page.typeReal`、`page.press`、`page.select` 执行后自动采样页面变化并附带 `delta` 字段（DOM 动作与 CDP 动作同一形状）：

```json
{
  "ok": true,
  "ref": "e5",
  "tag": "BUTTON",
  "text": "提交",
  "delta": {
    "urlChanged": false,
    "url": "https://example.com/form",
    "titleChanged": false,
    "modalOpened": true,
    "modalClosed": false,
    "activeTag": "button",
    "activeValue": null,
    "mutationCount": 8,
    "mutations": { "added": 6, "removed": 0, "textChanged": 2 }
  }
}
```

- `mutationCount` 不含桥自己的指示器（虚拟光标、点击波纹、停止按钮）。点了按钮但 `mutationCount: 0` 且 `urlChanged: false`，大概率没生效。
- CDP 动作引发整页导航时，旧页面的采样状态随页面销毁，`delta` 只有 `{ urlChanged, url, navigated: true }`。
- `activeValue` 对密码等敏感输入框返回 `[value redacted]`。

## 5. 打开网址与静默准备：`tabs.resolve` / `tabs.prepare`

- **`tabs.resolve`（首选打开入口，v0.3.9+）**：`{"method":"tabs.resolve","params":{"url":"https://...","match":"host"|"origin"|"exact","waitLoad":true}}`
  - 只复用**非活动**的同类 tab（聚焦窗口的活动页被保护，绝不顶掉用户正在看的页面）；无可用候选时以 `active: false` 静默新开后台 tab。
  - 返回 `{ tab, tabId, reused, navigated, reason }`。若 `reused: true, navigated: false` 表示目标 URL 已打开，不要重复 `page.navigate`。
- **`tabs.prepare`（静默注入 + 防冻结，v0.3.0+）**：`{"method":"tabs.prepare","params":{"tabId":<id>}}`
  - 保证 content script 已注入且设置 `autoDiscardable: false`；若后台 tab 渲染器被 Chrome Memory Saver 冻结，v0.3.10+ 会自动通过 CDP 解冻后完成注入。

## 6. 前台渲染保障与滚动加载检测：`page.ensureActive` / `page.scroll { checked: true }`（v0.3.10+）

Chrome 对后台标签页将 `requestAnimationFrame` 完全暂停（0 帧），导致依赖 rAF / IntersectionObserver 的瀑布流与懒加载不推进。

- **`page.ensureActive`**：`{"method":"page.ensureActive","params":{"tabId":<id>,"restoreAfterMs":20000}}`
  - 仅在 `document.hidden === true` 时切标签页（**不聚焦浏览器窗口**，不打断用户当前应用），空闲 20s 后自动切回原活动标签页；提前归还调 `page.restoreActive`。
- **`page.scroll { checked: true, expectGrowth: true }`**：
  - 回读页面高度与滚动位置；未推进时抛 `SCROLL_NO_GROWTH` 或 `SCROLL_STALLED`，错误 `details` 含 `{ recoverable, atBottom, wasHidden }`。
  - 推荐直接用 `scripts/lib/bridge.mjs` 的 `await rpc.scrollLoad(tabId, { direction: "down", expectGrowth: true })`：先静默滚，仅当 `recoverable === true` 时自动 `ensureActive` 重试一次。

## 7. 页面实时探查、通用阻断诊断与会话录制：`page.inspect` / `page.record.*`

无需手写 DOM 遍历 JS，直接调用内置探查：

```js
await rpc.call("page.inspect", { tabId, focus: "overview" });              // URL/标题/弹窗/blocker阻断诊断/可滚动容器/搜索框
await rpc.call("page.inspect", { tabId, focus: "links", limit: 6 });       // 列表卡片链接+可见性（防点 display:none 隐藏链接）
await rpc.call("page.inspect", { tabId, focus: "media" });                 // 图片/视频/live/blob
await rpc.call("page.inspect", { tabId, focus: "scroll" });                // 找出真正可滚动的容器
await rpc.call("page.inspect", { tabId, focus: "modal" });                 // 弹窗详情与弹窗内可见按钮清单
await rpc.call("page.inspect", { tabId, focus: "sel", selector: ".item" });// 指定选择器采样
```

`overview.blocker` 会自动识别四类阻断状态：
- `"cloudflare"` → 调用 `node <skill 目录>/captcha/scripts/cf-wait.mjs <tabId>`；
- `"captcha"` → 立即停止重试，请用户完成验证；
- `"login_wall"` → 请用户登录；
- `"dismissible_modal"` → 给出 `dismissText`，可直接点击关闭按钮继续。

过程性问题（如滚动后跳 404）用会话时间线记录：`page.record.start` → 复现操作 → `page.record.get`（含 `nav`/`modal`/`err`/`dom`/`console` 事件）→ `page.record.stop`。详见 `debug/SKILL.md`。

## 8. 近期报错查询与排查：`bridge.recentErrors`（v0.3.13+）

host 在内存中维护最近 100 条失败请求的环形缓冲（且 `~/.chrome-agent-bridge/host.log` 超过 5MB 自动轮转）：

```js
// 直接拿到近期错误明细与按错误码汇总的统计分布，无需 grep host.log
const errs = await rpc.recentErrors({ tabId, limit: 10 });
console.log(errs.byCode, errs.errors);
```

HTTP 等价：`GET http://127.0.0.1:8778/errors?limit=20&tabId=<id>`（带 `Authorization: Bearer <token>`）。

常见错误码处理速查（完整表见 `KNOWN_ISSUES.md`）：
- `AGENT_STOPPED`：用户在页面点击了「停止 Agent」（只拦写操作，只读放行）。立即停止写操作并询问用户；恢复用 `agent.resume`。
- `STALE_ELEMENT_REF`：快照引用 `@e1` 对应的节点已从 DOM 移除，重新调 `page.snapshot` 获取新 `ref`。
- `TAB_UNHEALTHY`：同 tab 连续 3 次上下文级失败被客户端熔断，换用 `tabs.resolve` / `withPage`。
- `PAGE_CONTEXT_TIMEOUT`：页面上下文失效，调 `tabs.prepare` 重新注入。
- `TAB_DISCARDED`：标签页被浏览器丢弃卸载，需 `tabs.activate` 唤醒重载。
- `TAB_LEASED`：标签页已被其他并行 Agent 租用。多 Agent 协作用租约互斥：RPC `tabs.claim` / `tabs.release`（`{tabId, ttlMs}`）与 HTTP `POST /tabs/claim` 是同一份账本，`rpc.claimTab(tabId)` / `rpc.releaseTab(tabId)` 封装了后者且进程退出自动释放。
- `TAB_GONE`：标签页已关闭（各入口统一报这个码），用 `tabs.resolve` 重新打开。
- `TAB_HIDDEN`：后台标签页不处理 CDP 鼠标 / 按键事件，`page.ensureActive` 后重试（见第 3 节）。
- `UNKNOWN_METHOD`：方法名不存在，看 `error.details.suggestions`；方法名正确却报这个码说明扩展版本落后，对照 `CHANGELOG.md`。

## 9. 底层 CDP 直通：`session.attach` / `session.send` / `session.detach`

当需要模拟移动设备视口、裁剪截图或拦截网络等未单独封装的 DevTools 能力时，使用 `rpc.withSession(tabId, fn)` 确保异常路径必 `detach`。
裸 HTTP 的 `session.send` 要求先 `session.attach`（否则报 `SESSION_NOT_ATTACHED`）；经 `rpc.call("session.send", ...)` 发送时本库自动 attach，进程退出时释放（Firefox 只支持其中一个子集，其余方法报 `CDP_UNSUPPORTED`，见 `firefox/SKILL.md`）：

```js
await rpc.withSession(tabId, async () => {
  await rpc.call("session.send", {
    tabId,
    method: "Emulation.setDeviceMetricsOverride",
    params: { width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 2, mobile: true },
  });
  const hasHScroll = await rpc.ev(tabId, "document.documentElement.scrollWidth > document.documentElement.clientWidth");
  console.log("是否存在横向溢出:", hasHScroll);
});
```
