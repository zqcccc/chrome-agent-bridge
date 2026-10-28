<!-- 本文件由 relay/gen-rpc-doc.js 从 relay/methods.js 生成，不要手改。运行时也可调 bridge.methods 取同一份数据。 -->

# RPC 方法参考

调用格式：`POST http://127.0.0.1:8778/rpc`（Firefox 为 8779），请求头 `Authorization: Bearer <~/.chrome-agent-bridge/token>`，
请求体 `{"method":"<方法>","params":{...},"timeoutMs":20000}`。成功返回 `{ok:true,result}`，失败返回 `{ok:false,error:{code,message,details?}}`。

运行时查询（与本文同源）：

```bash
curl -s -X POST http://127.0.0.1:8778/rpc -H "Authorization: Bearer $(cat ~/.chrome-agent-bridge/token)" \
  -H 'Content-Type: application/json' -d '{"method":"bridge.methods","params":{"name":"page.clickReal"}}'
```

调用未登记的方法返回 `UNKNOWN_METHOD`，`error.details.suggestions` 给出最接近的方法名。

## 桥自身

| 方法 | 说明 | 参数（* 为必填） |
|---|---|---|
| `bridge.methods` | 列出全部 RPC 方法及参数说明（本表）。传 name 只看一个方法 | `name`: string — 方法名，可选 |
| `help` | `bridge.methods` 的别名 | 同上 |
| `bridge.status` | 扩展侧状态：版本、通道、活动标签页、被接管的 tab | — |
| `bridge.ping` | 连通性探测，返回 pong 时间戳 | `t`: number — 调用方时间戳，原样返回 |
| `bridge.connect` | 让扩展连接 WS 通道（通常无需手动调用） | — |
| `bridge.disconnect` | 断开扩展的 WS 通道 | — |
| `bridge.recentErrors` | host 内存里最近 100 条失败请求与按错误码统计 | `tabId`: number — 只看该 tab，可选<br>`limit`: number — 返回条数，默认 20 |
| `extension.reload` | 扩展自重载（先回响应再重载，该次响应可能丢失，属正常） | `delayMs`: number — 延迟毫秒，默认 300 |

## 停止 / 恢复

| 方法 | 说明 | 参数（* 为必填） |
|---|---|---|
| `agent.stop` | 停止 Agent 写操作（只拦写，读放行）。省略 tabId 为全局停止 | `tabId`: number — 只停该 tab，可选<br>`reason`: string — 原因，可选<br>`ttlMs`: number — 自动解除时间，可选 |
| `agent.resume` | 解除停止。省略 tabId 为解除全局 | `tabId`: number — 可选 |
| `agent.stopStatus` | 查询停止状态 | `tabId`: number — 可选 |

## 标签页

| 方法 | 说明 | 参数（* 为必填） |
|---|---|---|
| `tabs.list` | 列出标签页 | `windowId`: number — 只看该窗口，可选<br>`active`: boolean — 只看活动页，可选 |
| `tabs.get` | 读取单个标签页 | `tabId*`: number |
| `tabs.active` | 当前聚焦窗口的活动标签页 | — |
| `tabs.resolve` | 打开网址的首选入口：复用非活动的同类 tab，否则静默新开后台 tab（不抢用户正在看的页） | `url*`: string<br>`match`: string — host（默认）\| origin \| exact<br>`waitLoad`: boolean — 等待加载完成，默认 true<br>`reuseActive`: boolean — 允许复用活动页，默认 false<br>`includePinned`: boolean — 允许复用固定 tab，默认 false<br>`windowId`: number — 限定窗口，可选<br>`timeoutMs`: number |
| `tabs.openUrl` | `tabs.resolve` 的别名 | 同上 |
| `page.open` | `tabs.resolve` 的别名 | 同上 |
| `tabs.create` | 无条件新开 tab（打开网址请用 tabs.resolve） | `url`: string<br>`active`: boolean — 是否切到前台<br>`index`: number — 位置，可选 |
| `tabs.open` | `tabs.create` 的别名 | 同上 |
| `tabs.new` | `tabs.create` 的别名 | 同上 |
| `tabs.activate` | 切到该 tab（会聚焦窗口；唤醒被丢弃的 tab） | `tabId*`: number |
| `tabs.prepare` | 保证 content script 已注入并关闭自动丢弃；渲染器被冻结时自动 CDP 解冻 | `tabId*`: number |
| `tabs.close` | 关闭 tab | `tabId*`: number |
| `tabs.reload` | 刷新 tab | `tabId*`: number<br>`bypassCache`: boolean<br>`timeoutMs`: number |
| `page.reload` | `tabs.reload` 的别名 | 同上 |
| `tabs.claim` | 申请 tab 互斥租约（多 Agent 并行时用；其他 Agent 的请求会报 TAB_LEASED） | `tabId*`: number<br>`ttlMs`: number — 租约时长，默认 120000，上限 3600000 |
| `tabs.release` | 释放自己持有的 tab 租约 | `tabId*`: number |

## 导航与等待

| 方法 | 说明 | 参数（* 为必填） |
|---|---|---|
| `page.info` | tab 的 url / title / status | `tabId*`: number |
| `page.navigate` | 在该 tab 内跳转 | `tabId*`: number<br>`url*`: string<br>`waitLoad`: boolean — 默认 true<br>`timeoutMs`: number |
| `page.back` | 后退 | `tabId*`: number |
| `page.forward` | 前进 | `tabId*`: number |
| `page.focus` | 切到该 tab 并聚焦窗口（会打断用户，慎用） | `tabId*`: number |
| `page.ensureActive` | 后台 tab 渲染暂停（rAF=0、懒加载不推进）时临时切为活动页，不聚焦窗口，空闲后自动归还 | `tabId*`: number<br>`restoreAfterMs`: number — 空闲多久后归还，默认 20000 |
| `page.restoreActive` | 立即归还 ensureActive 借走的活动页 | `tabId*`: number |
| `page.waitLoad` | 等待 tab 加载完成 | `tabId*`: number<br>`timeoutMs`: number |
| `page.waitForReady` | 等待 document.readyState 为 interactive / complete | `tabId*`: number<br>`timeoutMs`: number |
| `page.waitForUrl` | 等待 URL 满足条件 | `tabId*`: number<br>`match`: string — URL 包含该子串<br>`equals`: string — URL 完全相等<br>`timeoutMs`: number — 默认 30000<br>`intervalMs`: number — 默认 300 |
| `page.waitForSelector` | 等待元素出现 | `tabId*`: number<br>`selector*`: string<br>`by`: string — selector 的解释方式：css（默认）\| xpath \| text \| aria<br>`timeoutMs`: number<br>`intervalMs`: number |
| `page.waitFor` | 等待元素出现或表达式为真（content script 内轮询） | `tabId*`: number<br>`selector`: string — 与 expression 二选一<br>`expression`: string<br>`timeoutMs`: number — 默认 10000<br>`intervalMs`: number — 默认 200 |
| `page.focusEl` | 聚焦元素 | `tabId*`: number<br>`selector`: string — CSS 选择器；也可写 `@e3` 引用快照元素<br>`ref`: string — page.snapshot 返回的元素引用（如 `e3`），与 selector 二选一<br>`by`: string — selector 的解释方式：css（默认）\| xpath \| text \| aria |

## 读取与截图

| 方法 | 说明 | 参数（* 为必填） |
|---|---|---|
| `page.read` | 一键读网页：打开/复用 tab → 等就绪 → 提取正文、标题、主链接与阻断诊断 → 关闭本次新建的 tab | `url`: string — 与 tabId 二选一<br>`tabId`: number — 读已有 tab；同时传 url 则先跳转<br>`match`: string — tabs.resolve 的匹配方式<br>`maxLength`: number — 正文最大字符数，默认 20000<br>`includeLinks`: boolean — 默认 true<br>`maxLinks`: number — 默认 30<br>`keepOpen`: boolean — 保留新建的 tab，默认 false<br>`waitMs`: number — 就绪后额外等待，上限 10000<br>`timeoutMs`: number — 默认 45000 |
| `page.snapshot` | 页面快照。compact 模式输出 `[e1] button "搜索"` 形式的元素清单，元素编号可直接用于 click/type | `tabId*`: number<br>`mode`: string — compact（推荐）\| elements \| a11y \| text \| full<br>`includeText`: boolean — 附带正文<br>`maxElements`: number — compact 最多元素数，默认 200<br>`maxDepth`: number — a11y 深度<br>`maxNodes`: number — a11y 节点上限 |
| `page.inspect` | 只读探查：overview（阻断诊断 blocker、弹窗、可滚动容器）\| links \| media \| scroll \| modal \| sel | `tabId*`: number<br>`focus`: string — 默认 overview<br>`selector`: string — focus=sel 时必填<br>`limit`: number<br>`world`: string — MAIN \| ISOLATED |
| `page.evaluate` | 在页面执行 JS 表达式并取回值（MAIN world；遇 CSP 拦截自动改走 CDP） | `tabId*`: number<br>`expression*`: string<br>`awaitPromise`: boolean<br>`world`: string — MAIN（默认）\| ISOLATED |
| `page.evalCdp` | 经 CDP Runtime.evaluate 单次求值，不受页面 CSP / Trusted Types 限制，用完立即归还调试器 | `tabId*`: number<br>`expression*`: string<br>`awaitPromise`: boolean<br>`userGesture`: boolean<br>`timeoutMs`: number |
| `page.screenshot` | 静默截图，返回 base64 dataURL | `tabId*`: number<br>`format`: string — png（默认）\| jpeg<br>`quality`: number — jpeg 质量，默认 90<br>`captureBeyondViewport`: boolean — 整页截图<br>`allowActivate`: boolean — CDP 截图失败时允许切前台再截 |
| `page.activateAndShot` | 切前台后截可见区域（会打断用户） | `tabId*`: number |
| `page.record.start` | 开始记录会话时间线（导航/弹窗/报错/DOM/console） | `tabId*`: number |
| `page.record.stop` | 停止记录 | `tabId*`: number |
| `page.record.status` | 记录状态 | `tabId*`: number |
| `page.record.get` | 读取时间线 | `tabId*`: number<br>`since`: number — 时间戳<br>`types`: string[] — nav \| modal \| err \| dom \| console<br>`limit`: number |
| `page.record.clear` | 清空时间线 | `tabId*`: number |

## 交互（返回值带 delta）

| 方法 | 说明 | 参数（* 为必填） |
|---|---|---|
| `page.click` | DOM 原生 el.click() | `tabId*`: number<br>`selector`: string — CSS 选择器；也可写 `@e3` 引用快照元素<br>`ref`: string — page.snapshot 返回的元素引用（如 `e3`），与 selector 二选一<br>`by`: string — selector 的解释方式：css（默认）\| xpath \| text \| aria |
| `page.clickReal` | CDP 真实鼠标点击（React/Vue 等只认真实事件的组件）。传元素时自动滚动居中算坐标 | `tabId*`: number<br>`selector`: string — CSS 选择器；也可写 `@e3` 引用快照元素<br>`ref`: string — page.snapshot 返回的元素引用（如 `e3`），与 selector 二选一<br>`by`: string — selector 的解释方式：css（默认）\| xpath \| text \| aria<br>`x`: number — 视口坐标，与元素二选一<br>`y`: number<br>`button`: string — left（默认）\| right \| middle<br>`clickCount`: number — 默认 1<br>`delayMs`: number — 按下/松开间隔，默认 50 |
| `page.type` | DOM 方式输入（设置 value 并派发 input 事件） | `tabId*`: number<br>`selector`: string — CSS 选择器；也可写 `@e3` 引用快照元素<br>`ref`: string — page.snapshot 返回的元素引用（如 `e3`），与 selector 二选一<br>`by`: string — selector 的解释方式：css（默认）\| xpath \| text \| aria<br>`text*`: string<br>`clear`: boolean — 先清空，默认 true |
| `page.typeReal` | CDP 受控输入：聚焦 → 清空 → Input.insertText → 回读校验（verified） | `tabId*`: number<br>`selector`: string — CSS 选择器；也可写 `@e3` 引用快照元素<br>`ref`: string — page.snapshot 返回的元素引用（如 `e3`），与 selector 二选一<br>`by`: string — selector 的解释方式：css（默认）\| xpath \| text \| aria<br>`text*`: string<br>`clear`: boolean — 默认 true<br>`pressEnter`: boolean — 输入后回车 |
| `page.press` | 派发按键（Enter / Escape / Tab / ArrowDown …），可带 ctrl/meta/alt/shift | `tabId*`: number<br>`key*`: string<br>`selector`: string — CSS 选择器；也可写 `@e3` 引用快照元素<br>`ref`: string — page.snapshot 返回的元素引用（如 `e3`），与 selector 二选一<br>`by`: string — selector 的解释方式：css（默认）\| xpath \| text \| aria<br>`ctrl`: boolean<br>`meta`: boolean<br>`alt`: boolean<br>`shift`: boolean |
| `page.select` | 设置 <select> 的选项 | `tabId*`: number<br>`selector`: string — CSS 选择器；也可写 `@e3` 引用快照元素<br>`ref`: string — page.snapshot 返回的元素引用（如 `e3`），与 selector 二选一<br>`by`: string — selector 的解释方式：css（默认）\| xpath \| text \| aria<br>`value`: string<br>`values`: string[]<br>`label`: string<br>`labels`: string[] |
| `page.hover` | 派发悬停事件 | `tabId*`: number<br>`selector`: string — CSS 选择器；也可写 `@e3` 引用快照元素<br>`ref`: string — page.snapshot 返回的元素引用（如 `e3`），与 selector 二选一<br>`by`: string — selector 的解释方式：css（默认）\| xpath \| text \| aria |
| `page.scroll` | 滚动。checked=true 时回读是否推进，未推进报 SCROLL_NO_GROWTH / SCROLL_STALLED（details.recoverable） | `tabId*`: number<br>`direction`: string — up \| down \| left \| right<br>`amount`: number — 像素，默认 0.8 屏<br>`selector`: string — 滚动到该元素<br>`x`: number<br>`y`: number<br>`checked`: boolean — 回读推进检测<br>`expectGrowth`: boolean — checked 时要求页面变高（懒加载）<br>`allowNoProgress`: boolean — checked 时到底不报错 |
| `page.uploadFile` | 给 <input type=file> 注入本地文件（绝对路径） | `tabId*`: number<br>`selector`: string — 默认 input[type="file"]<br>`files*`: string[] |

## 视觉指示器

| 方法 | 说明 | 参数（* 为必填） |
|---|---|---|
| `page.indicator.move` | 移动虚拟光标 | `tabId*`: number<br>`x`: number<br>`y`: number<br>`instant`: boolean |
| `page.indicator.click` | 虚拟光标点击动画 | `tabId*`: number<br>`x`: number<br>`y`: number |
| `page.indicator.highlight` | 高亮元素 | `tabId*`: number<br>`selector`: string |
| `page.indicator.hide` | 隐藏虚拟光标 | `tabId*`: number |
| `page.indicator.stop` | 显示/隐藏「停止 Agent」按钮 | `tabId*`: number<br>`show`: boolean<br>`label`: string |
| `page.indicator.hideAll` | 隐藏所有 tab 的指示器 | — |

## CDP 直通

| 方法 | 说明 | 参数（* 为必填） |
|---|---|---|
| `session.attach` | 附加调试器（幂等）。用完必须 session.detach | `tabId*`: number |
| `session.detach` | 解除调试器 | `tabId*`: number |
| `session.send` | 发送任意 CDP 命令（Firefox 只支持子集，其余报 CDP_UNSUPPORTED） | `tabId*`: number<br>`method*`: string — 如 Emulation.setDeviceMetricsOverride<br>`params`: object |
