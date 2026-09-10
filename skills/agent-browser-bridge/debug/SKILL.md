---
name: agent-browser-debug
description: 浏览器页面临场 debug 通用能力。当通过 Agent Browser Bridge 操作真实浏览器遇到页面行为异常（404/风控误判、取不到内容、选择器失败、数量不对、URL 打不开）、需要理解陌生页面结构、或需要在交付前验证提取结果时使用。核心：先探查后假设、不猜类名、异常先查 DOM 再下结论、输出独立验证。首选插件内置 page.inspect / page.record RPC（一次调用拿页面结构与变化时间线）；兜底脚本 scripts/browser-debug.mjs。
---

# 浏览器页面临场 Debug

在真实浏览器里干活（抓取、点选、输入、验证）时，**第一版选择器必须来自 DOM 探查，不是来自想象**。本 skill 提供探查工具 + 工作流 + 实测踩坑，适用于任何站点，不限小红书。

## 首选：插件内置 page.inspect（不用读脚本、不用写 JS）

插件已内置 `page.inspect` RPC，Agent 只需一次调用即可拿到结构化探查结果：

```js
await bridge.rpc("page.inspect", { tabId, focus: "overview" });              // 页面概览
await bridge.rpc("page.inspect", { tabId, focus: "links", limit: 6 });       // 列表卡片链接+可见性
await bridge.rpc("page.inspect", { tabId, focus: "media" });                 // 图片/视频/live/blob
await bridge.rpc("page.inspect", { tabId, focus: "scroll" });                // 可滚动容器
await bridge.rpc("page.inspect", { tabId, focus: "modal" });                 // 弹窗详情
await bridge.rpc("page.inspect", { tabId, focus: "sel", selector: ".foo" }); // 任意选择器 dump
```

CLI 等价：`node agent/cli.mjs inspect <tabId> [overview|links|media|scroll|modal|sel:<css>]`（在仓库根目录执行，见下方工具用法）

探查函数内置在扩展 background 里（函数引用直接注入，无模板字符串转义坑），**只读、无副作用**：不点元素、不滚动页面。遇到 404/异常/取不到内容/交付前验证，**第一步就是 page.inspect**。

> ⚠️ **扩展版本提示**：`page.inspect` / `page.record` 需要扩展 background.js 含对应实现（2026-09-10 后刷新扩展）。若调用返回 `UNKNOWN_METHOD`，说明扩展还是旧版——请用户到 `chrome://extensions` 刷新 Agent Browser Bridge，或先用下方兜底脚本 `browser-debug.mjs` 继续探查。

`scripts/browser-debug.mjs` 保留为兜底（host 扩展版本过旧没有 page.inspect 时用）。

## 变化过程分析（Clarity 式会话记录）

一次性快照只能看到"现在的样子"，很多问题是**过程性**的（打开正常→滚动后 404→DOM 被替换）。插件内置**会话记录器**：先开启记录，复现问题过程，再拉时间线分析：

```js
await bridge.rpc("page.record.start", { tabId });        // 开始记录
// …复现问题（打开/滚动/点开笔记等）…
await bridge.rpc("page.record.get", { tabId });          // 拉取完整时间线
await bridge.rpc("page.record.stop", { tabId });
```

事件类型：
- `nav`：URL 变化（pushState/replaceState/popstate/页面隐藏）
- `modal`：详情弹窗打开/关闭
- `err`：页面出现异常文本（验证码/404/风控/参数错误等关键词，自动扫描）
- `dom`：DOM 变化摘要（新增/删除节点数、新增标签统计、文本变化，500ms 合并）
- `console`：页面 console.error（节流 2s）
- `recordStart/recordStop/recordReady`：录制生命周期

特性：按 tab 环形缓冲（上限 1000 条）；**导航重载后 content 自动恢复录制**（不影响时间线连续性）；只读监听不修改页面行为。

## 何时使用

- 页面行为异常：404、风控页、验证码、空数据、取不到内容
- 需要理解陌生页面结构：类名、链接、滚动容器、弹窗、懒加载
- 交付前验证：图片数量、URL 可访问性、正则匹配、评论是否加载全
- 任何"第一版提取/操作没按预期工作"的场景

## 核心原则（每一条都是实测教训）

1. **先探查后假设**：写任何选择器/点击逻辑前，先 `page.inspect`（或兜底 `browser-debug.mjs`）dump 目标区域。不猜类名——SPA 的类名多是编译后的哈希（`data-v-xxx`），猜不中很正常，dump 一次全看见。
2. **全量 dump 关键信息**：链接要带**可见性**（`display:none` 的链接 click() 会触发风控/404）、图片要带 `currentSrc/src/data-src` + `naturalWidth`（懒加载图 naturalWidth=0 不能过滤）、滚动要确认容器。
3. **异常先查 DOM 再下结论**：404 先 dump 页面上有哪些链接可点、哪些可见；不要想当然归因"风控/验证码"。
4. **输出独立验证**：交付前自验——数量核对（图片数 vs 轮播 slide 数）、URL 可访问性（curl/urlopen 实测）、正则结果（返回正则 toString + 中间值诊断）。
5. **每轮只验证一个假设**：最小实验，一次改一个变量，用返回的中间值定位（如返回正则源码看反斜杠是否丢失）。

## 工作流（page.inspect 优先，脚本兜底）

1. **快照**：`page.inspect { focus:"overview" }`（或 `browser-debug.mjs <tabId>`）看页面概览——URL、弹窗、滚动位置、卡片数、可滚动元素、搜索框。
2. **探查**：按目标选 focus——
   - 列表/卡片 → `focus:"links"`（链接 + 可见性，防点隐藏链接）
   - 图片/视频 → `focus:"media"`（含 live photo、blob）
   - 滚动容器 → `focus:"scroll"`（哪些元素真正可滚动）
   - 弹窗 → `focus:"modal"`（存在、尺寸、内部滚动区、评论数）
   - 任意元素 → `focus:"sel", selector:"<css>"`
   - 过程性问题 → `page.record.start` 开启记录，复现后 `page.record.get` 拉时间线
3. **最小实验**：`page.evaluate` 执行一段 JS 验证假设（一次一个）；兜底脚本用 `--js "<expr>"`。
4. **验证**：对输出做独立验证（数量、URL 可访问、正则 test）。
5. **记录**：把确认的坑写回对应子 skill 或 KNOWN_ISSUES.md，避免下个 Agent 重踩。

## 实测踩坑清单（通用化）

1. **隐藏链接陷阱**：列表卡片里第一个 `a` 可能是 `display:none` 的隐藏链接（如 href 指向 `/explore/`），`click()` 它会跳转到风控/404 页。必须点**可见**的链接（`getBoundingClientRect().width > 0 && display !== 'none'`），如 `a.cover.mask.ld`。
2. **模板字符串反斜杠**：脚本内嵌的 JS 表达式如果写在模板字符串里，**正则必须写双反斜杠**（`\\d`/`\\s`/`\\.`）——单反斜杠 `\d` 会被模板字符串丢弃成 `d`，导致数字/空白匹配**静默失败**（表现为取数全空，很难从输出定位；诊断方法：返回正则 `.toString()` 看是否变形）。
3. **图床 URL 参数**：某些 CDN URL（如 `sns-webpic-qc.xhscdn.com/...!nd_dft_wlteh_webp_3`）**必须保留参数**，`split('!')[0]` 去参后 403。提取时保留原样。
4. **懒加载图片**：不可见/未加载的图片 `naturalWidth=0`，不能用它过滤；用 `img.currentSrc || img.src || data-src`。
5. **同类元素干扰**：页面多处有同名 wrapper（如评论区的 `.like-wrapper` 和主互动区的），选择器必须**限定作用域**（如 `.engage-bar .like-wrapper`），否则取到错误的值。
6. **滚动污染**：滚动加载只滚**目标容器**（弹窗内滚动区如 `.note-scroller`），**绝不滚 window**——否则弹窗背后的页面滚动位置被带跑，关闭弹窗后位置丢失。找容器用 `focus:"scroll"`。
7. **轮播副本**：swiper 会在首尾插入 `.swiper-slide-duplicate` 副本，提取时要跳过，否则数量翻倍或去重逻辑混乱。
8. **live photo/blob**：实况照片的 slide 内含 `<video src="blob:…">`，blob URL 仅当前页面会话有效，不能保存/外部访问；静态图 URL 才是可交付的。
9. **页面状态是快照**：弹窗是否开着、滚动到哪、懒加载加载到哪，都影响结果。操作前先确认状态（`focus:"modal"` / overview），操作后验证。

## 工具用法

**首选（插件内置，无需脚本）——RPC 代码已在上文自包含，任何环境可用**。以下 CLI 是**本机仓库的便利命令**（依赖仓库根的 `agent/cli.mjs`，其他 Agent 若只有 skill 目录则用上文 RPC 示例）：

```bash
export BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token)
cd <chrome-agent-bridge 仓库根>   # 含 agent/ 与 extension/ 的代码仓库，不是 skill 目录

node agent/cli.mjs inspect <tabId>                  # 页面概览
node agent/cli.mjs inspect <tabId> links 6          # 前 6 张卡片链接 + 可见性
node agent/cli.mjs inspect <tabId> media            # 图片/视频/live/blob
node agent/cli.mjs inspect <tabId> scroll           # 可滚动容器
node agent/cli.mjs inspect <tabId> modal            # 弹窗详情
node agent/cli.mjs inspect <tabId> sel:.note-item   # 任意选择器 dump
node agent/cli.mjs record <tabId> start             # 开始会话记录
node agent/cli.mjs record <tabId> get               # 拉变化时间线
node agent/cli.mjs record <tabId> stop              # 停止记录
```

**兜底脚本（随 skill 分发的 `scripts/browser-debug.mjs`，任何环境可用）**：

```bash
cd <skill 目录>/scripts          # 即 skills/agent-browser-bridge/scripts
node browser-debug.mjs <tabId> [--links N|--media|--scroll|--modal|--sel "<css>"|--js "<expr>"]
```

tabId 用 `node agent/cli.mjs tabs`（本机）或 `page.inspect` 无此能力时用 `tabs.list` RPC 现查，用户操作会变。
