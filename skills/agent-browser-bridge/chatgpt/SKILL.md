---
name: chatgpt
description: agent-browser-bridge 的子技能——网页版 ChatGPT（chatgpt.com）问答与生图专项。当任务需要在 ChatGPT 网页端提问、读回复、选高级模型、生成图片或读取图片结果时，读取本文件执行。价值点：网页端额度按「单端/浏览器」独立计算，可与 API 额度分开使用；网页端有最新高级模型（如 GPT-5.x 系列）与图片生成能力。前置：根 SKILL.md 的桥已就绪（host 存活、扩展已连接），用户在浏览器中已登录 chatgpt.com。
---

# ChatGPT 网页版专项：问答、读回复、选模型、生图

用真实登录态驱动 chatgpt.com：发提问 → 等回复 → 读文本/图片结果。**网页额度单端计算**，与 API 额度互不占用；网页端模型通常比 API 更新（当前实例默认模型为 GPT-5.6 Luna）。

> ⚠️ 必须先读：本专项受根 SKILL.md「Agent 行为约束」与根目录 `KNOWN_ISSUES.md` 约束。遇到登录墙/额度弹窗/升级引导时，**立即停止并让用户手动处理**，禁止替用户登录、绕过验证或反复重试。

## 核心约束：chatgpt.com 有严格 CSP，page.evaluate 不可用（必须先读）

实测（2026-09-10）：chatgpt.com 的 `script-src` 不含 `'unsafe-eval'`，任何**字符串求值**都会被拦——`page.evaluate` 报 `EVAL_ERROR`（MAIN 世界与 `world:"ISOLATED"` 隔离世界**均被拦**，Chrome 83+ 内容脚本也受页面 CSP 约束）。

**因此本专项内所有页面内 JS 一律走 CDP：**

```
# 一键求值（自包含脚本，等价于 page.evaluate 但绕过 CSP）
BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node <skill 目录>/scripts/cdp-eval.mjs <tabId> "<JS 表达式>"
# 表达式返回 Promise 时加 --awaitPromise；要原样 JSON 输出加 --json
```

`cdp-eval.mjs` 内部：`session.attach` → `Runtime.evaluate { returnByValue:true, awaitPromise }` → `session.detach`。CDP 走 DevTools 协议，**不受页面 CSP 约束**；且运行在页面主世界，可访问 window/document。

**可用（不走 eval）的 RPC**：`page.type` / `page.click` / `page.press` / `page.scroll` / `page.waitForSelector` / `page.waitForUrl` / `page.waitForReady` / `page.waitLoad` / `page.snapshot` / `page.inspect` / `page.screenshot` / `tabs.*` / `session.*`。**不可用**：`page.evaluate`、`page.waitFor`（带 expression 时）。

## 一键提问（推荐入口）

```bash
# 在当前 chatgpt tab 提问并读回复（自动等待生成完成，输出 JSON）
BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node <skill 目录>/scripts/chatgpt-ask.mjs <tabId> "<提问>"

# 先开新会话再问
... node chatgpt-ask.mjs <tabId> "<提问>" --new

# 尽力选模型（UI 变化频繁，找不到不阻塞主流程）
... node chatgpt-ask.mjs <tabId> "<提问>" --new --model "GPT-5"

# 生成图片并下载到本地（每张图消耗一次生图额度）
... node chatgpt-ask.mjs <tabId> "画一只圆脸小猫头像，扁平插画" --new --images ./out

# 保存结果 JSON / 自定义超时（生图通常 30~90s，默认 180s）
... node chatgpt-ask.mjs <tabId> "<提问>" --timeout 240000 --out result.json
```

输出 JSON：`{ url, prompt, reply, thinking?, images[], savedImages[], modelApplied, quotaHint, elapsedMs }`。

## 手工驱动路径（不用脚本时按此流程）

### 1. 前置检查（每个任务开始）
- `curl -s http://127.0.0.1:8778/status` → `extConnected:true`。
- `tabs.list` 找 chatgpt tab（URL 含 `chatgpt.com`）；找不到就让用户在浏览器打开并**登录后**再继续。
- 登录墙判断（CDP）：URL 含 `auth/login`，或 body 前 120 字含 `Log in`/`Sign up` 且无 `#prompt-textarea` → **停下，请用户手动登录**，不替用户登录。

### 2. 定位输入框与发送按钮（2026-09-10 实测结构）
- 输入框：`#prompt-textarea`（`div[contenteditable="true"]`，ProseMirror，`aria-label="Chat with ChatGPT"`）。
- 输入：`page.type { tabId, selector: "#prompt-textarea", text }` —— content script 走 `execCommand("insertText")`，ProseMirror 兼容，实测有效。
- 发送按钮：`button[data-testid="send-button"]`（`aria-label="Send prompt"`）。**先等它 `disabled === false` 再点**（空输入时可能 disabled）。
- 提交也可用 `page.press { tabId, key: "enter" }`（焦点在 composer 时）。
- 生成中指示：`button[data-testid="stop-button"]` 出现；生成结束后消失。

### 3. 等待回复完成（不要用固定 sleep）
轮询（CDP `READ_EXPR`，见下）直到 **生成结束且文本连续两次读取一致**；纯图片回复以「新 turn 出现 + 图片数增加 + 生成结束」判定完成（**图片-only 的 assistant 轮有 `conversation-turn` 容器但可能没有 `data-message-author-role`，不能只按 role 取消息**——实测踩坑，否则漏图/等到超时）。

```js
// 读取当前状态（CDP Runtime.evaluate 表达式；以 turn 容器为准）
const READ_EXPR = `(() => {
  const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn"]'));
  const last = turns[turns.length - 1] || null;
  const roleEl = last && last.querySelector('[data-message-author-role]');
  const role = roleEl ? roleEl.getAttribute('data-message-author-role') : '';
  const imgs = last ? Array.from(last.querySelectorAll('img[alt^="Generated image"]')).map(im => im.src).filter(Boolean) : [];
  const isAssistant = role === 'assistant' || imgs.length > 0;
  const reply = roleEl && role === 'assistant' ? (roleEl.innerText || '').trim() : '';
  const thinkingEl = roleEl && roleEl.querySelector('[data-testid="thinking-visualization"]');
  const thinking = thinkingEl ? (thinkingEl.innerText || '').trim().slice(0, 2000) : '';
  return { turnCount: turns.length, role, isAssistant, reply, thinking,
           images: Array.from(new Set(imgs)),
           generating: !!document.querySelector('button[data-testid="stop-button"]') };
})()`;
```

### 4. 读取回复
- 文本：最后一条 turn 内 `[data-message-author-role="assistant"]` 的 `innerText`（思考过程在 `[data-testid="thinking-visualization"]` 内，单独取）。
- 图片：**最后一条 turn 内** `img[alt^="Generated image"]`，去重取 `src`（不要全页取，会把同一会话历史轮的图带出来）。URL 形如 `https://chatgpt.com/backend-api/estuary/content?id=…&ts=…&sig=…` —— **带会话签名的临时 URL，需在页面上下文内 fetch（带 cookie）下载**，过期/外部直连可能 403：
  ```js
  // CDP 内执行（页面同源 fetch → base64 → 落盘）
  const r = await fetch(img.src, { credentials: 'include' });
  const buf = await r.arrayBuffer(); // → base64 → Buffer.from(b64, 'base64')
  ```
  （`chatgpt-ask.mjs --images <dir>` 已内置该下载逻辑。）

### 5. 新会话 / 换会话
- 新会话：`page.navigate { url: "https://chatgpt.com/" }`（等价侧边栏 New chat 链接 `a[href="/"]`），然后等 `#prompt-textarea` 出现。
- 打开历史会话：侧边栏 `a[href*="/c/"]` 的 href 直接 `page.navigate`。
- **复用同一 tab**，不要为每个提问开新标签页（遵循根 SKILL.md 行为约束）。

## 模型选择与额度（用户关注点，UI 变化频繁，先探查再操作）

- 当前模型/计划：`page.inspect { focus: "overview" }` 看主区顶部；账号为免费/过期 Plus 时会出现「Rejoin Plus」按钮，`quotaHint` 只是尽力抓取，不作为硬依赖。
- 模型选择器入口随版本变化：历史版本是 composer 顶部模型名按钮（如 `GPT-5`）+ 弹层 `[role="option"]`；当前版本顶部有 `Chat` / `Work` 等 tab（模型即 tab 绑定），消息区有 `aria-label="Switch model"` 按钮。**做法：先用 `page.inspect`/`cdp-eval` 找到含模型名或 `Switch model` 的可见按钮，点击后再在 `[role="option"]/[role="menuitem"]` 中找同名项**。
- `chatgpt-ask.mjs --model "<名>"` 内置了上述尽力选择逻辑；找不到会置 `modelApplied:false` 继续提问，不阻塞。
- 额度：网页端按「单端/浏览器」计算（与 API 额度分离）。额度显示通常在模型选择弹层/设置页，不在 DOM 常驻文本里；脚本的 `quotaHint` 为尽力抓取。**遇到额度用尽弹窗/升级引导 → 立即停止并告知用户，不要重试**。

## 生图专项

- 生图 = 正常提问，prompt 里写清画面要求（风格/构图/主体/背景），ChatGPT 自动用图片模型生成。生成耗时通常 30~90s，把 `--timeout` 放到 180000 以上。
- 结果读取与下载见上文「读取回复-图片」。实测：`chatgpt-ask.mjs --images ./out` 下载成功（1254×1254 PNG，约 800KB）。
- 侧边栏有 `Images` 入口（图片库），可 `page.navigate` 查看历史生成。

## 行为约束与踩坑清单（实测 2026-09-10）

1. **CSP**：本专项一切 JS 求值走 `cdp-eval.mjs`（CDP），不走 `page.evaluate`；写新脚本时不要引入字符串 eval。
2. **登录墙/额度墙**：出现登录页、`Rejoin Plus` 弹窗、额度提示 → 停下让用户处理，禁止绕过。
3. **生图不可用提示**：实测遇到回复文本为 `It looks like image creation is temporarily unavailable...`——生图额度/服务暂时不可用（如当日额度用尽）。此时按文本回复正常返回即可，**不要自动重试生图**；告知用户后等待额度恢复/升级。
4. **发送前先验证输入**：`page.type` 后读 `#prompt-textarea` 的 `innerText` 确认文本已进入，再等 `send-button` 可用后点击；不要盲点。
5. **图片轮读取**：图片-only 的 assistant 轮有 `[data-testid^="conversation-turn"]` 容器但可能没有 `data-message-author-role`，一律以 turn 容器为准读取文本/图片（见上文 `READ_EXPR`）。
6. **多轮追问**：同一对话内直接复用当前 tab 继续输入提问即可（上一条回复已稳定）；新话题再 `--new`。
7. **模型/UI 结构随版本变**：选择器以实测为准；先 `page.inspect overview` 探查，再操作，不要依赖固定类名。
8. **生图消耗额度**：每次生图消耗一次图片额度；批量任务前先和用户确认数量，避免一次跑几十张。
