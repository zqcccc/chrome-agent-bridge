# Agent Browser Bridge —— Agent 行为约束与已知状态

> 本文件是给**所有使用本 skill 的 Agent** 的行为约束，不只是故障记录。
> 使用本桥操作任何网站前，先读本文件；违反约束会被视为执行错误。

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

## 约束三：默认静默操作，不抢用户焦点（扩展 v0.3.0+）

- 桥的读/写/点击/截图默认全部静默：不切换激活 tab、不把浏览器窗口拉到前台。脚本里用 `tabs.prepare`（注入 content script + 防后台冻结）代替过去的 `tabs.activate`。
- **何时才显式激活**：登录/扫码/验证码/2FA/选文件（需用户眼睛）、最终核对可视化结果（`page.activateAndShot`）、被 OneTab/浏览器丢弃冻结的 tab（激活即唤醒重载；`tabs.prepare` 对被冻结 tab 返回 `TAB_DISCARDED`，`tabs.list` 的 tab 带 `discarded` 字段可预判）。
- 截图默认 CDP 静默；CDP 失败不再自动激活窗口（报 `SCREENSHOT_FAILED`），需要时显式 `allowActivate:true` 或 `page.activateAndShot`。
- BOSS 薪资 OCR 走 macOS 窗口截图，需要 Chrome 窗口可见：静默模式下该步先 `tabs.activate` 再截。
- 旧版扩展（无 `tabs.prepare`，返回 `UNKNOWN_METHOD`）：脚本里的 `try{...}catch{}` 会吞掉，`page.*` 内容调用自带 `ensureInjected` 自动注入，流程仍可跑；只有防冻结不生效。
- **打开网址走 `tabs.resolve`（v0.3.9+），不要自己挑 tab**（2026-09 补充）。过去脚本里的 `tabs.find(t => t.url.includes(站点)) || tabs.find(t => t.active)` 有个坏 fallback：找不到匹配 tab 就拿用户当前正在看的页面去 `page.navigate`，直接把人家看的页面顶掉。`tabs.resolve` 把这条规则收进扩展：只复用**非活动**的同类 tab（排除聚焦窗口的活动页、pinned、discarded），没有就 `active:false` 静默新开后台 tab。**自己写脚本时也不要再写「fallback 到 active tab」这句。**

## 已知状态：后台 tab 节流（静默模式的代价）

- Chrome 把后台 tab 定时器压到 1 秒级、长闲后可能冻结：依赖 rAF/轮询渲染的页面（瀑布流、懒加载）可能看似无响应。
- 处理：`page.waitForSelector` / `page.waitForUrl` 超时放宽到 30s+；仍无响应再 `tabs.activate`（代价是抢一次焦点）。不要把「页面没反应」误判成站点风控。

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


- 现象：`page.evaluate` 报 `EVAL_ERROR: Evaluating a string as JavaScript violates the following Content Security Policy...`，且 `world:"ISOLATED"` 同样被拦（Chrome 83+ 内容脚本隔离世界也受页面 CSP 约束）。
- 原因：桥的 `page.evaluate` 内部是 `eval(expression)` 字符串求值；chatgpt.com 的 `script-src` 不含 `'unsafe-eval'`。
- 解决：走 CDP。`session.attach` + `session.send { method: "Runtime.evaluate", params: { expression, returnByValue:true, awaitPromise } }`（DevTools 协议不受页面 CSP 约束）。已封装为 `scripts/cdp-eval.mjs`，ChatGPT 专项（`chatgpt/SKILL.md`）已按此实现全部求值。
- 不受影响的 RPC：`page.click/type/press/scroll/waitForSelector/waitForUrl/waitForReady/waitLoad`、`page.snapshot/inspect/screenshot`、`tabs.*`、`session.*`（它们不依赖字符串 eval）。

## 已知状态：导航超时后该 tab 会连续超时（扩展 v0.3.3 起快速失败）

- 现象（host.log 实测 201 次 TIMEOUT，其中 110 次 `page.evaluate`）：`page.navigate` 超时后，**该 tab 后续每个 `page.evaluate` 都挂满 60s**，一个坏 tab 能把整条流程拖死。
- **根因（v0.3.6 才修到点子上）**：`chrome.tabs.sendMessage` 对「content script 不存在」**不会 reject，会一直挂起**。扩展 reload 前的旧标签页、content script 实例被销毁的页面都会命中——`ensureInjected` 的 ping 永不返回，外层 RPC 只能等满超时。此前几轮只在外层打补丁，没解决挂起。
- 修法：给所有 `sendMessage` / `executeScript` 加超时（ping 3s、注入 10s、求值 12s），把「挂起」变成「快速可判定」；配合 `brokenTabs` 标记（30s TTL）让后续调用立即失败。实测坏 tab：首次 20s 判定，后续毫秒级失败。
- `indicatorCall` 同样处理过——它是每个 `page.*` 的前置步骤，曾是一大卡点。
- 另一个触发源：导航超时往往意味着页面上下文已销毁。
- v0.3.3 起：导航超时会给 tab 打「上下文失效」标记（30s TTL），后续 evaluate **立即返回 `PAGE_CONTEXT_TIMEOUT` 快速失败**，不再空等。`tabs.prepare` 注入成功会自动清除标记。
- Agent 侧应对：收到 `PAGE_CONTEXT_TIMEOUT` 时，先 `tabs.prepare`（或 `page.navigate` 重来）恢复上下文，再继续；不要盲目重试同一个调用。

## 已知状态：操作报 PAGE_CONTEXT_TIMEOUT（页面上下文失效）

- 含义：目标 tab 的 content script 不在了——常见于**扩展刚被重载过**（reload 前打开的旧标签页）、标签页被冻结/丢弃、或页面正在导航。
- 处理：先 `tabs.prepare` 重新注入；仍不行则 `tabs.reload` 刷新该页面再操作。
- 该错误是**快速失败**（毫秒级），不会挂死。若发现每个调用都要等几十秒才报这个错，说明扩展版本过旧（v0.3.6 以前），到 `chrome://extensions` 刷新扩展即可。

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
