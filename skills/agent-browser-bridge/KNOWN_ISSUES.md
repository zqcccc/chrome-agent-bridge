# Agent Browser Bridge —— Agent 行为约束与已知状态

> 本文件是给**所有使用本 skill 的 Agent** 的行为约束，不只是故障记录。
> 使用本桥操作任何网站前，先读本文件；违反约束会被视为执行错误。

## 约束一：遇到风控/安全验证 → 立即停止，不要疯狂重试

- 现象特征：页面跳转到验证码页（如小红书的 `website-login/captcha` /「Security Verification」）、滑块验证、人机校验、或大量页面返回 404 /「页面不见了」。
- **正确做法**：一旦发现上述特征，**立即停止该站点的所有后续请求**。不要换参数重试、不要加大滚动轮数、不要重新批量打开页面、不要换个标签页再试。
- 停下来，向用户说明被拦截的原因，等待用户手动完成验证（或风控解除）后再继续。
- **为什么**：疯狂重试会加重风控，导致账号/会话被更长时间限制，甚至触发更严格的验证。等待是最快恢复路径。
- 桥本身（host / 扩展）几乎从不是这类问题的原因：先查 `/status` 确认 `extConnected:true`，确认桥正常后，把原因归于站点侧风控。

## 约束二：优先页面内跳转/点开，少开标签页

- 目标站点的内容本身就能在页面内点开（如小红书每个笔记都是可点开的页面内弹窗），**优先在当前 tab 内 `page.navigate` 跳转或直接点开内容**，看完后**关闭弹窗**，再点下一条。
- **不要**为每条内容都新开一个浏览器标签页；确需新开时，用完立即 `tabs.close`。同一任务同时打开的标签页应控制在个位数，确需保留的只有搜索/列表页本身。
- **为什么**：大量并发标签页 = 大量并发请求 = 更容易触发风控；同时标签页过多会让快照、截图、tab 管理混乱，还会挤占「同一 tab 串行、跨 tab 并行」的队列。
- 全局同理：能用单页交互/跳转完成的，不要开新 tab。

## 已知状态：严格 CSP 站点（chatgpt.com 等）上 page.evaluate 不可用

- 现象：`page.evaluate` 报 `EVAL_ERROR: Evaluating a string as JavaScript violates the following Content Security Policy...`，且 `world:"ISOLATED"` 同样被拦（Chrome 83+ 内容脚本隔离世界也受页面 CSP 约束）。
- 原因：桥的 `page.evaluate` 内部是 `eval(expression)` 字符串求值；chatgpt.com 的 `script-src` 不含 `'unsafe-eval'`。
- 解决：走 CDP。`session.attach` + `session.send { method: "Runtime.evaluate", params: { expression, returnByValue:true, awaitPromise } }`（DevTools 协议不受页面 CSP 约束）。已封装为 `scripts/cdp-eval.mjs`，ChatGPT 专项（`chatgpt/SKILL.md`）已按此实现全部求值。
- 不受影响的 RPC：`page.click/type/press/scroll/waitForSelector/waitForUrl/waitForReady/waitLoad`、`page.snapshot/inspect/screenshot`、`tabs.*`、`session.*`（它们不依赖字符串 eval）。

## ChatGPT 网页版专项已知坑（2026-09-10 实测）

- 图片-only 的 assistant 轮有 `conversation-turn` 容器但**没有** `data-message-author-role` 属性——按 role 取消息会漏掉图片轮；统一以 `[data-testid^="conversation-turn"]` 为准读取。
- 生成图片 URL 是带会话签名的临时地址（`backend-api/estuary/content?id=…&ts=…&sig=…`），必须在页面上下文内 fetch（带 cookie）下载，外部直连可能 403/过期。
- 生图通常 30~90s；「等待完成」不能只看 stop 按钮，纯图片回复要以「新 turn 出现 + 图片数增加 + 生成结束」判完成，否则会等到超时。
- 生图额度/服务暂时不可用时，ChatGPT 会以文本回复 `It looks like image creation is temporarily unavailable...`——按文本正常返回，不要自动重试生图。
