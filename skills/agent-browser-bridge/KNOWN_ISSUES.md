# Agent Browser Bridge —— Agent 行为约束与已知状态

> 本文件是给**所有使用本 skill 的 Agent** 的行为约束，不只是故障记录。
> 使用本桥操作任何网站前，先读本文件；违反约束会被视为执行错误。

## 约束零之前：变更类操作必须回读验证

**删除 / 保存 / 提交 / 发布之后，必须重新加载列表页或详情页，确认目标状态真的变了。**

- **不得以脚本自己打印的 `✓ 已删除` / `✓ 已保存` 作为成功依据。** 按钮被点到 ≠ 请求发出去了。
- 为什么单独立一条：这个坑最隐蔽——脚本无报错、日志显示成功，但业务状态没变；不主动回读就会带着错误结论继续往下走（“删了重复项”其实没删、“保存了”其实没保存）。
- 可用 `scripts/lib/bridge.mjs` 的 `rpc.mutateAndVerify(mutate, verify)` 强制这个模式。

## 约束零：先查子技能、优先用现成脚本，不自己重造

- 根 `SKILL.md`「第一原则：先查子技能，用现成脚本（禁止重造）」列出了子技能索引。任务站点命中索引（小红书 / BOSS 直聘 / ChatGPT / NotebookLM）时，**必须先读对应子技能 `SKILL.md`，优先直接跑它给的 `scripts/*.mjs`**。
- **为什么这是风控约束而不只是效率建议**：这些脚本里的限速、随机抖动、单 tab 内操作、验证码/404 自动拦截退出、`tabs.prepare` 静默注入，都是踩过风控后调出来的。临时手写的裸脚本（自己拼 HTTP、自己写 `page.evaluate` 遍历 DOM、为每条内容开新 tab）没有这些防护，**几轮就会把账号/会话打到限制里**，且报错往往伪装成脚本 bug，让人误判为「选择器不对」而继续重试，进一步加重风控。
- 脚本不完全贴合时：**先改参数**（`--max-scrolls` / `--max-results` / `--channel` / `--filter` / 选择器），再考虑改脚本。
- 确实需要新功能才自己写，且必须**以同类子技能脚本为模板复制改写**（继承它的限速、拦截检测、静默 prepare、单 tab 操作），并在交付说明里注明「子技能 X 未覆盖 Y，基于 `scripts/Z.mjs` 改写」。禁止从零手写。
- 任何站点行为异常（取不到内容、数量不对、404、疑似风控）→ 先读 `debug/SKILL.md` 用 `page.inspect` 探查，再下结论。

## 约束一：遇到风控/安全验证 → 立即停止，不要疯狂重试

- 现象特征：页面跳转到验证码页（如小红书的 `website-login/captcha` /「Security Verification」）、滑块验证、人机校验、或大量页面返回 404 /「页面不见了」。
- **正确做法**：一旦发现上述特征，**立即停止该站点的所有后续请求**。不要换参数重试、不要加大滚动轮数、不要重新批量打开页面、不要换个标签页再试。
- 停下来，向用户说明被拦截的原因，等待用户手动完成验证（或风控解除）后再继续。
- **为什么**：疯狂重试会加重风控，导致账号/会话被更长时间限制，甚至触发更严格的验证。等待是最快恢复路径。
- 桥本身（host / 扩展）几乎从不是这类问题的原因：先查 `/status` 确认 `extConnected:true`，确认桥正常后，把原因归于站点侧风控。

### 约束一·例外：小红书「`.reds-alert` 软风控弹窗」不算入本约束（2026-09-14 补充）

小红书在操作过快/被频繁请求时会弹出 `.reds-alert` 软风控弹窗，标题如「温馨提示 / 小贴士」，正文如「操作太频繁，请稍后再试 / 网络异常，点此重试 / 系统繁忙 / 广告屏蔽插件提示」等，**弹窗上只有「我知道了」按钮，点一下就消失，不需要人**——与上面「需要人验的硬风控」是两种东西，**不要混为一谈**。该弹窗在 DOM 里平时是 `display:none` 隐藏的，被频繁操作激活为 `block`；本质是「提示」不是「验证」。

- 错误地按硬风控处理：把「点一下就能过」的场景当成「被拦截、停下来等用户」，**浪费任务进度**。
- 正确处理：调用 `xhs/scripts/xhs-dismiss-softblock.mjs`（或内联同样的「点【我知道了】」逻辑）。该脚本区分软/硬风控：软风控自动点【我知道了】（退出码 0），硬风控不动并以退出码 2 报回。调用方拿到硬风控退出码 2 才是真正需要停下来等用户。

## 约束二：优先页面内跳转/点开，少开标签页

- 目标站点的内容本身就能在页面内点开（如小红书每个笔记都是可点开的页面内弹窗），**优先在当前 tab 内 `page.navigate` 跳转或直接点开内容**，看完后**关闭弹窗**，再点下一条。
- **不要**为每条内容都新开一个浏览器标签页；确需新开时，用完立即 `tabs.close`。同一任务同时打开的标签页应控制在个位数，确需保留的只有搜索/列表页本身。
- **为什么**：大量并发标签页 = 大量并发请求 = 更容易触发风控；同时标签页过多会让快照、截图、tab 管理混乱，还会挤占「同一 tab 串行、跨 tab 并行」的队列。
- 全局同理：能用单页交互/跳转完成的，不要开新 tab。
- **自己开的 tab 必须自己关（含测试/临时脚本）**：用 `rpc.withPage(url, fn)` 时默认 `cleanup:true`，会自动关掉**本次新建**的 tab（复用用户已有的不动）。自己写脚本时，`tabs.resolve` / `tabs.create` 拿到 `reused === false` 就应在 `finally` 里 `tabs.close`。
  > 历史教训：测试脚本反复跑却没关 tab，实测攒下 **21 个 `example.com`**（总标签页 62 个）。这类垃圾页不会自己消失，只能人工清。

## 约束三：默认静默操作，不抢用户焦点（扩展 v0.3.0+）

- 桥的读/写/点击/截图默认全部静默：不切换激活 tab、不把浏览器窗口拉到前台。脚本里用 `tabs.prepare`（注入 content script + 防后台冻结）代替过去的 `tabs.activate`。
- **何时才显式激活**：登录/扫码/验证码/2FA/选文件（需用户眼睛）、最终核对可视化结果（`page.activateAndShot`）、被 OneTab/浏览器丢弃冻结的 tab（激活即唤醒重载；`tabs.prepare` 对被冻结 tab 返回 `TAB_DISCARDED`，`tabs.list` 的 tab 带 `discarded` 字段可预判）。
- **页面必须激活才能继续时，就激活——但用 `page.ensureActive`，不要用 `tabs.activate`**（v0.3.10+）。
  区别：`ensureActive` **只切标签页、不聚焦窗口**，且**用完自动把活动标签页还给用户**（空闲 20s，
  可调 `restoreAfterMs`）；`tabs.activate` 会连窗口一起拉到前台并且永不归还。
  典型场景：滚动加载不推进、懒加载出不来内容（后台 tab 的 rAF 被 Chrome 暂停）。
  详见下方「已根治：后台 tab 渲染被暂停」。
- 截图默认 CDP 静默；CDP 失败不再自动激活窗口（报 `SCREENSHOT_FAILED`），需要时显式 `allowActivate:true` 或 `page.activateAndShot`。
- BOSS 薪资 OCR 走 macOS 窗口截图，需要 Chrome 窗口可见：静默模式下该步先 `tabs.activate` 再截。
- 旧版扩展（无 `tabs.prepare`，返回 `UNKNOWN_METHOD`）：脚本里的 `try{...}catch{}` 会吞掉，`page.*` 内容调用自带 `ensureInjected` 自动注入，流程仍可跑；只有防冻结不生效。
- **打开网址走 `tabs.resolve`（v0.3.9+），不要自己挑 tab**（2026-09 补充）。过去脚本里的 `tabs.find(t => t.url.includes(站点)) || tabs.find(t => t.active)` 有个坏 fallback：找不到匹配 tab 就拿用户当前正在看的页面去 `page.navigate`，直接把人家看的页面顶掉。`tabs.resolve` 把这条规则收进扩展：只复用**非活动**的同类 tab（排除聚焦窗口的活动页、pinned、discarded），没有就 `active:false` 静默新开后台 tab。**自己写脚本时也不要再写「fallback 到 active tab」这句。**

## 已根治：后台 tab 渲染器被冻结（扩展 v0.3.10+）

> 本条曾是「已知状态：静默模式的代价」，让 Agent 忍着。实际上它不是代价，是**当时最大的失败源**：
> host.log 全量统计里 `PAGE_CONTEXT_TIMEOUT` 433 次居首，`tabs.prepare` 失败率 **33.9%**，
> 耗时整齐卡在 **13s / 26s**（= ping 3s + 注入 10s 的整数倍）。v0.3.10 起自动自愈。

**现象**：某个用得好好的 tab 突然所有 `page.*` / `tabs.prepare` 都要等十几秒才失败（`PAGE_CONTEXT_TIMEOUT`），
换个调用还是失败，过一会儿自己又好了。

**根因**：Chrome 的 **Memory Saver / 高能效模式**会冻结后台标签页的渲染器。冻结后
`chrome.scripting.*`（注入、executeScript）**全部不可用**，只会挂到超时；而 **CDP 通道完好**。实测对照：

| 状态 | `page.evaluate` / `tabs.prepare`（scripting） | CDP `Runtime.evaluate` |
|---|---|---|
| 正常 | 125–2000ms 成功 | 32ms |
| `Page.setWebLifecycleState: frozen` 冻结后 | **13022ms 后 `PAGE_CONTEXT_TIMEOUT`** | **32ms 正常** |
| 再发 `active` 解冻 | 125ms 恢复 | — |

`Page.setWebLifecycleState` 就是 Chrome 自己冻结后台 tab 用的协议，所以这不是人造场景。
日志侧的佐证：失败前同 tab 空闲时长**中位数 41s、>60s 占 46%**——典型的「放一会儿就被冻」。

**v0.3.10 起自动处理，Agent 不需要做任何事**：`ensureInjected` 遇到 `PAGE_CONTEXT_TIMEOUT` 时，
自动 CDP attach → `Page.setWebLifecycleState: active` 解冻 → 重试一次。
实测从「13s 报错」变成「13s + 0.5s 后成功」，之后恢复毫秒级。

限流用的是**滑动窗口**（60s 内最多解冻 5 次），不是「成功后冷却」——因为 Chrome 可能刚解冻又冻回去，
成功即长冷却会让这种情况退化成不自愈。解冻失败（用户开着 DevTools 等）有 5s 退避，不会反复挂调试器。

**Agent 侧仍要注意的两点**：

1. **冻结 ≠ 丢弃**。`discarded` 的 tab 渲染器已被卸载，CDP 也救不回来，仍报 `TAB_DISCARDED`，
   需要显式 `tabs.activate`（会重载页面）。`tabs.list` 的 `discarded` 字段可预判。
2. **自愈要花约 13s**（第一次撞满 scripting 超时）。批量任务里如果某个 tab 反复出现 13s 延迟，
   说明它一直被冻；`tabs.resolve` 换一个 tab 更快。

**仍然成立的限制**：解冻只恢复**脚本执行能力**，不恢复前台时序——被冻过的页面里 rAF / 渲染节奏
仍按后台走，依赖 `requestAnimationFrame` 的懒加载、瀑布流可能不推进。**这一点另见下一条**
（v0.3.10 起有 `page.ensureActive` 可解）。

回归测试：`node relay/test-freeze-recovery.mjs`（用 CDP 手动冻结渲染器复现，不依赖等它自然冻结）。

## 已根治：后台 tab 渲染被暂停 → `page.ensureActive`（扩展 v0.3.10+）

**现象（比上面那条更隐蔽）**：滚动指令返回 `{ok:true}`、点击也成功，但**列表永远是空的 / 永远只有
首屏那几条**，页面高度不变。你以为是站点改版或选择器写错，实际是懒加载根本没触发。

**根因**：Chrome 对后台标签页把 `requestAnimationFrame` **完全暂停**（实测 2s 内 **0 帧**，
活动页 60 帧）、`document.visibilityState="hidden"`。依赖 rAF / IntersectionObserver 的
懒加载、瀑布流、无限滚动在后台**永不推进**。

> 这是「暂停」不是「节流」——**加长超时完全没用**，别在这上面浪费轮次。

**已试过但不行的方案**：CDP `Emulation.setFocusEmulationEnabled` 确实能把 rAF 拉起来，
但它 **detach 或页面导航后立即失效**（实测），而 detach 是每次 RPC 收尾都会做的事，等于没用。
所以只能真让标签页 active。

### 用法

```js
// 需要页面真的渲染时（滚动加载、等懒加载出内容、依赖动画/时序的操作）
await rpc.ensureActive(tabId);
// 返回 { activated, alreadyRendering, willRestoreTo, note }

// 收工/提前归还（不等空闲计时器）
await rpc.restoreActive(tabId);
```

- **只在必要时才激活**：内部先探 `document.hidden`，已经在渲染就原样返回（`activated:false`），
  不会白切一次前台。
- **只切标签页，不聚焦窗口**：不调 `chrome.windows.update({focused:true})`。实测单独
  `chrome.tabs.update({active:true})` 就能恢复 rAF（Chrome 不在前台时同样有效），
  **所以用户正在别的应用里工作时不会被弹到 Chrome**——这是它和 `tabs.activate` 的关键区别。
- **用完自动还原**：默认 20s 无操作后把活动标签页还给用户原来那个；长流程中每次 `page.*`
  调用都会续期，不会在滚动循环中途抢走前台。`restoreAfterMs` 可调。
- 用户自己切走了、原标签页被关了（退到同窗口其它页）等边界都有处理。

### 滚动推进检测：`page.scroll { checked: true }`

后台页里 `window.scrollBy` **仍然生效**（实测滚动位置会变），所以「滚动成功」不能作为
「内容加载了」的依据。`checked` 会回读页面高度与滚动位置：

```js
await rpc.scrollChecked(tabId, { direction: "down", expectGrowth: true });
// 推进了：{ checked:true, grew, moved, atBottom, heightBefore, heightAfter }
// 后台没加载出来：抛 SCROLL_NO_GROWTH
// 视口完全没动：抛 SCROLL_STALLED
// 到底了收尾：加 allowNoProgress:true，不再报错
```

#### 错误里带结构化字段，**用字段判断，不要解析 message**

```js
try {
  await rpc.scrollChecked(tabId, { y: 99999, expectGrowth: true });
} catch (e) {
  e.code;                    // "SCROLL_NO_GROWTH" | "SCROLL_STALLED"
  e.details.atBottom;        // 是否已到底（真到底了就别再激活）
  e.details.wasHidden;       // 当时是不是后台标签页
  e.details.recoverable;     // ★ 激活能不能解决：true 才值得调 ensureActive
  e.detail("recoverable");   // 便捷读取（等价于 e.details.recoverable）
}
```

`recoverable` 就是为「由 Agent 判断该不该激活」设计的：

| 情况 | `recoverable` | 该怎么办 |
|---|---|---|
| 后台标签页、懒加载没触发 | `true` | 值得 `ensureActive` 后重试 |
| 前台也没动（选择器/容器不可滚） | `false` | **激活没用**，别白白打扰用户 |
| 已到底（`atBottom:true`） | `false` | 真到底了，用 `allowNoProgress` 收尾 |

#### 不想自己写判断？用 `scrollLoad`

```js
await rpc.scrollLoad(tabId, { y: 99999, expectGrowth: true });
// 内部：先直接滚 → 只有 recoverable===true 才 ensureActive → 重试一次
// 返回带 { borrowed, activated, attempts, firstError }
// 不该激活的场景（recoverable=false）直接原样抛出，不碰用户前台
```

- **`expectGrowth` 是「这一滚应该加载出新内容」的声明**，不是「到底了没」。
  判断到底请用返回的 `atBottom` 字段。
- 注意：**不能因为 `atBottom=true` 就放过**——懒加载的哨兵元素本来就在列表末尾，
  「到底部」正是应该触发加载的位置；用 atBottom 做例外等于把这个信号关掉（实现时踩过）。
- 后台场景下 `atBottom` **不可信**：同一位置激活后会加载出更多内容（实测），所以后台一律
  归因为渲染被暂停。
- 老写法 `page.scroll`（不带 `checked`）行为不变，不会突然开始报错。

回归测试：`node relay/test-foreground-rendering.mjs`（本地起一个靠 IntersectionObserver
懒加载的页面确定性复现，不依赖外网站点、不需要登录、不会因站点改版失效）。

## 已知状态：「接管中」滞留的自愈（扩展 v0.3.1+）

- 现象：标签页标题/工具栏 badge 停在「● Agent 接管中」，但 agent 早已退出。
- 原因：撤销依赖页面端 indicator 的 12s 闲置计时器回报；**扩展 reload 会销毁旧标签页里的 indicator 实例**（不会自动重注入），或页面被后台冻结（Memory Saver）时计时器不跑，标题/badge 就永远滞留。
- 修复（v0.3.1 三层自愈）：
  1. `indicatorCall` 在页面无 indicator 实例时**按需补注入**（幂等守卫，重注入无害），旧标签页也能正常显示接管状态；
  2. 后台 15s 无新控制请求即撤销 badge + 通知页面释放（页面存活立即恢复原标题，冻结页唤醒后也恢复）；
  3. 扩展启动/更新时**清扫**所有标题带「● …接管中」的 tab，补注入 indicator 并发送 released，恢复原标题。
- 旧版扩展：手动点一次「停止 Agent」或刷新扩展可清掉 badge；标题残影需刷新对应页面。

## 排查入口：报错优先看 host.log，不要靠截图（2026-09-12 实测）

- **最可靠的报错源是 `~/.chrome-agent-bridge/host.log`**（3 万行级、带时间戳/method/tabId/耗时/错误码），比 chrome://extensions 的 errors 面板强得多：
  - errors 面板**只保留最近若干条且不能滚动**，会漏掉历史高频问题；
  - 面板里混着大量**预期失败**的噪音（受限页注入被拒等），真正的故障被淹没。
- 常用统计命令（先统计再定位，别一条条看）：
  ```bash
  cd ~/.chrome-agent-bridge
  grep -o "code=[A-Z_]*" host.log | sort | uniq -c | sort -rn        # 报错码分布
  grep "code=UNKNOWN_METHOD" host.log | grep -o "method=[a-zA-Z.]*" | sort | uniq -c | sort -rn
  grep "code=TIMEOUT" host.log | grep -o "method=[a-zA-Z.]*" | sort | uniq -c | sort -rn
  grep "tab=<id>" host.log | grep -E "TIMEOUT|note=dispatch" | head -20   # 单 tab 时间线
  ```
- **chrome://extensions 的 errors 面板怎么看**：该页是 `chrome://` 协议，桥不能注入也不能截图（`session.attach` 报 `Cannot access a chrome:// URL`，`page.screenshot` 报 `SCREENSHOT_FAILED`）。需要文本化时用 **macOS Vision OCR** 把窗口截图转文字（见下方「OCR 配方」），或直接用 host.log。
- **OCR 配方**（macOS，`swiftc` 可用时）：
  ```bash
  cat > /tmp/ocr.swift <<'EOF'
  import Foundation; import Vision; import AppKit
  let url = URL(fileURLWithPath: CommandLine.arguments[1])
  let cg = NSImage(contentsOf: url)!.cgImage(forProposedRect: nil, context: nil, hints: nil)!
  let req = VNRecognizeTextRequest { r, _ in
    guard let obs = r.results as? [VNRecognizedTextObservation] else { return }
    for o in obs.sorted(by: { a, b in a.boundingBox.origin.y > b.boundingBox.origin.y }) {
      if let t = o.topCandidates(1).first { print(t.string) }
    }
  }
  req.recognitionLevel = .accurate; req.recognitionLanguages = ["en-US", "zh-Hans"]
  req.usesLanguageCorrection = false
  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
  EOF
  swiftc -O -suppress-warnings /tmp/ocr.swift -o /tmp/ocrbin
  screencapture -x -m /tmp/shot.png && /tmp/ocrbin /tmp/shot.png
  ```
  注意：OCR 对 WebUI 多层嵌套区域识别不稳定（常只拿到背景窗口层），**仅当没有日志可查时才用**。

## 已知状态：page.evaluate 在严格 CSP / Trusted Types 站点被拦（扩展 v0.3.3 起自动兜底）

- 现象：`EVAL_ERROR: Evaluating a string as JavaScript violates ... 'unsafe-eval' is not an allowed source`（github.com 等）、或 `violates this document's Trusted Type assignment requirements`。`world:"ISOLATED"` 同样被拦（Chrome 83+ 隔离世界也受页面 CSP 约束）。
- **v0.3.3 起扩展自动兜底**：检测到 CSP / Trusted Types 类错误时，自动改用 CDP `Runtime.evaluate`（DevTools 协议不受页面 CSP 约束）重试一次，调用方无感。返回体带 `via:"cdp"` 表示走了兜底。
- **兜底仍失败**（未装 debugger 权限、页面已被用户 DevTools 占用等）才需要手动走 CDP：
  `scripts/cdp-eval.mjs`，或 `session.attach` + `session.send { method:"Runtime.evaluate", params:{ expression, returnByValue:true, awaitPromise } }`。
- 注意：CDP attach 期间 Chrome 会在该 tab 顶部显示「正在调试此浏览器」条，扩展用完立即 detach。
- 不受影响的 RPC：`page.click/type/press/scroll/waitForSelector/waitForUrl/waitForReady/waitLoad`、`page.snapshot/inspect/screenshot`、`tabs.*`。

> **直接可用的封装**：`scripts/lib/bridge.mjs` 的 `rpc.ev(tabId, expr)` 已经走 CDP `Runtime.evaluate`，自动绕过页面 CSP，并把返回值解包好。多步流程优先用它，不要自己拼 `session.attach` / `session.send` / `detach`。

## 已知状态：导航超时后该 tab 会连续超时（扩展 v0.3.3 起快速失败）

- 现象（host.log 实测 201 次 TIMEOUT，其中 110 次 `page.evaluate`）：`page.navigate` 超时后，**该 tab 后续每个 `page.evaluate` 都挂满 60s**，一个坏 tab 能把整条流程拖死。
- **根因（v0.3.6 才修到点子上）**：`chrome.tabs.sendMessage` 对「content script 不存在」**不会 reject，会一直挂起**。扩展 reload 前的旧标签页、content script 实例被销毁的页面都会命中——`ensureInjected` 的 ping 永不返回，外层 RPC 只能等满超时。此前几轮只在外层打补丁，没解决挂起。
- 修法：给所有 `sendMessage` / `executeScript` 加超时（ping 3s、注入 10s、求值 12s），把「挂起」变成「快速可判定」；配合 `brokenTabs` 标记（30s TTL）让后续调用立即失败。实测坏 tab：首次 20s 判定，后续毫秒级失败。
- `indicatorCall` 同样处理过——它是每个 `page.*` 的前置步骤，曾是一大卡点。
  **v0.3.10 起它不再被 `await`**：indicator 只是视觉提示，但在冻结/受限页上它自己要先撞 3s
  PING 超时；串在 RPC 前面等于给每个 `page.*` 白加 3s 延迟。现在改成 fire-and-forget（`.catch(()=>{})`），
  失败不影响主 RPC。
- 另一个触发源：导航超时往往意味着页面上下文已销毁。
- v0.3.3 起：导航超时会给 tab 打「上下文失效」标记（30s TTL），后续 evaluate **立即返回 `PAGE_CONTEXT_TIMEOUT` 快速失败**，不再空等。`tabs.prepare` 注入成功会自动清除标记。
- Agent 侧应对：收到 `PAGE_CONTEXT_TIMEOUT` 时，先 `tabs.prepare`（或 `page.navigate` 重来）恢复上下文，再继续；不要盲目重试同一个调用。

## 已知状态：操作报 PAGE_CONTEXT_TIMEOUT（页面上下文失效）

- 含义：目标 tab 的 content script 不在了——常见于**扩展刚被重载过**（reload 前打开的旧标签页）、标签页被冻结/丢弃、或页面正在导航。
- **v0.3.10 起，最常见的成因「渲染器被 Memory Saver 冻结」已自动自愈**（见上方「已根治」一节）：
  扩展会 CDP 解冻后重试一次，Agent 无感。仍报这个错说明是真坏（受保护页 / discarded / 永远 loading）。
- 处理：先 `tabs.prepare` 重新注入；仍不行则 `tabs.reload` 刷新该页面再操作。
- 该错误是**快速失败**（毫秒级），不会挂死。若发现每个调用都要等几十秒才报这个错，说明扩展版本过旧（v0.3.6 以前），到 `chrome://extensions` 刷新扩展即可。

## 已知状态：客户端超时被报成 CONNECTION_REFUSED（两个客户端都已修）

- 现象：`无法连接本地桥 127.0.0.1:8778（[TIMEOUT] 请求超时 30000ms）`——看着像 host 挂了，
  实际是**页面上下文超时**，与本地桥无关。会把人引向错误排查方向。
- 根因：`req.on("error")` 无差别包装错误，而 `req.destroy(err)`（超时/中断）
  也会走 `error` 事件，于是自己的超时错误被包成了 `CONNECTION_REFUSED`。
- 已修（两处）：
  - `scripts/lib/bridge.mjs`：`e instanceof BridgeRpcError` 时原样透传。
  - `agent/client.mjs`（v0.3.11）：超时用专属的 `BridgeTimeoutError`，`error` 处理器凭
    `instanceof BridgeError` 原样透传；只有真正的连接层失败才报 `CONNECTION_REFUSED`。
- 现在的错误码区分：`TIMEOUT`（本地/服务端超时）· `CONNECTION_REFUSED`（连不上，才该提示启动桥）·
  `UNAUTHORIZED`（token 不对）· `NOT_FOUND`（路由不存在）· `AGENT_STOPPED`（用户停了）· 业务错误。
- 排查提示：拿不准是桥挂了还是页面超时时，直接 `curl -s http://127.0.0.1:8778/status`——
  能返回 JSON 就说明桥好好的，问题在页面侧。

## 已知状态：`details` 在客户端链路被丢（v0.3.11 已修）

- 现象：`SCROLL_NO_GROWTH` 的 `recoverable` / `atBottom` 拿不到，Agent 只能去解析 message 文本，
  「让 Agent 自己判断该不该激活」于是成了空话。
- 根因：`agent/client.mjs` 重建 `BridgeError` 时只保留 `code` / `message`。
- 已修：`BridgeError` 新增 `details` 与 `detail(key)`，HTTP / WS / 客户端 / 扩展四层都透传。
  同时 host 的 WS `/bridge` 出口也补上了 details（以前只有 HTTP 出口带）。
- 用法：`e.detail("recoverable")`，不要解析 message。

## 已知状态：自写 WebSocket 实现把分片消息当成多条（v0.3.11 已修）

- 现象：扩展连上了、但「从不响应」，host 日志里看不到任何错误。
- 根因：`relay/ws-server.js` 对 text 帧和 continuation 帧都立即 `emit("message")`，
  没有按 FIN 组装。一条分片传输的 JSON 被拆成 `{"ok":` 和 `true}`，两边 `JSON.parse` 都失败
  后被静默忽略——错误被吞掉了，排查方向完全跑偏。
- 已修：按 RFC 6455 组装到 FIN 才交付；并补齐协议加固：
  - 未 mask 的客户端帧 → 1002；RSV 位非 0 → 1002；未知 opcode → 1002；
  - 控制帧不得分片 / 不得 >125 字节；
  - 单条消息上限（含分片累计）16MB、分片数上限，超限以 1009 提前拒绝（按声明长度就拒，不先攒内存）；
  - 发送侧背压记账：排队未 flush 字节超上限就断开慢消费者（1013），不再忽略 `write()` 的返回值。
- 副作用（对写测试的人重要）：**测试里手写的 WS 客户端必须带 mask**，否则现在会被拒。
  真实 Chrome 一直带 mask，只有手写实现会漏——那正是应该被拒绝的对象。

## 已知状态：`agent.stop` 以前只是通知，不是真停（v0.3.11 已修）

- 现象：用户点页面上的「停止 Agent」，界面显示「已放开」，但排队的点击/输入继续执行；
  通过 HTTP 调用、没订阅事件的 Agent 完全不知道用户按了停止。
- 根因：按钮只发 `agent.stop` 事件，host 只把它 `broadcastToAgent`，既不清队列也不拦后续 RPC。
- 已修：停止变成一个**可查询、会拒绝新写操作、会取消未派发请求**的状态，三层各管一段：
  - **host**：拦「还没派发的」（含排队中），并取消它们；`/status` 与 `agent.stopStatus` 可查。
  - **扩展**：拦「已派发但还没落到页面上的」。
  - **页面（content.js）**：拦多步动作的下一步（滚动循环、逐字输入等）。
- 范围：页面按钮只停**它所在的那个 tab**（用 `sender.tab.id` 判定），不再把整台机器上所有 Agent 一起停掉。
- 恢复：`agent.resume`；错误里给 `details.resumeWith` / `details.scope`，不用解析 message。
- 边界：**只拦写操作**。只读（`page.info`/`snapshot`/`evaluate`/`tabs.list`、CDP 的 `Runtime.*`）、
  释放类（`tabs.close`/`session.detach`）、恢复类（`session.attach`/`agent.resume`）都不拦——
  否则 Agent 被盲住，或者一次停止留下未释放的 debugger 会话，比不停更糟。
  已完成的页面动作**无法撤销**，响应里会如实说明。

## 已知状态：队列等待不计入超时（v0.3.11 已修）

- 现象（已隔离复现）：设 `timeoutMs:10` 的请求，排队 52ms 后**仍被发送**。
  对发消息 / 提交表单这类不可逆操作，这意味着「调用方以为失败」变成「稍后偷偷执行」。
- 根因：超时计时器在请求**真正发出后**才启动；租约也只在入队前查一次。
- 已修：
  - 入口生成统一截止时间（预算），**排队、等扩展重连、执行共用它**；排队超时立即失败
    （`details.phase` = `queued` / `waiting-ext` / `executing`）。
  - **派发前重新校验**：取消标记 / 停止状态 / 租约归属 / 预算。
  - **客户端断开即取消**尚未派发的请求（HTTP `aborted`/`close`、WS `close`）。
  - 已派发到扩展的无法撤回，响应里用 `inFlight` 如实报告。

## 已知状态：debugger 会话状态（session.attach / session.send）

- v0.3.3 前没有会话状态跟踪，导致两类连环报错：
  - 重复 `session.attach` → `Another debugger is already attached to the tab with id: N`；
  - 页面导航后目标被卸载仍继续 `session.send` → `Detached while handling command`。
- v0.3.3 起扩展维护 `cdpSessions` 集合：重复 attach 返回 `{ already:true }`；未 attach 就 send 报 `SESSION_NOT_ATTACHED`（明确指引）；`chrome.debugger.onDetach` 监听自动清理失效会话。
- 若报错 `DEBUGGER_BUSY`：**用户手动打开的 DevTools 占用了该 tab**，扩展不会抢断——关掉 DevTools 再试。
- 用法纪律：`session.*` 走同 tab 串行队列，收工 `session.detach`。

## ChatGPT 网页版专项已知坑（2026-09-10 实测）

- 图片-only 的 assistant 轮有 `conversation-turn` 容器但**没有** `data-message-author-role` 属性——按 role 取消息会漏掉图片轮；统一以 `[data-testid^="conversation-turn"]` 为准读取。
- 生成图片 URL 是带会话签名的临时地址（`backend-api/estuary/content?id=…&ts=…&sig=…`），必须在页面上下文内 fetch（带 cookie）下载，外部直连可能 403/过期。
- 生图通常 30~90s；「等待完成」不能只看 stop 按钮，纯图片回复要以「新 turn 出现 + 图片数增加 + 生成结束」判完成，否则会等到超时。
- 生图额度/服务暂时不可用时，ChatGPT 会以文本回复 `It looks like image creation is temporarily unavailable...`——按文本正常返回，不要自动重试生图。
