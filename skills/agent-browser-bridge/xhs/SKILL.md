---
name: xhs
description: agent-browser-bridge 的子技能——小红书（Xiaohongshu）笔记与全部评论深度抓取专项。当任务需要在站内检索信息、抓取笔记正文、完整评论区（含楼中楼二级回复）或做避坑/口碑调研时，读取本文件执行。前置：根 SKILL.md 的桥已就绪（host 存活、扩展已连接）。
---

# 小红书专项：笔记与全部评论深度抓取

在小红书进行信息检索、避坑调研或口碑分析时，**切忌仅抓取正文或首屏评论**。小红书正文往往含有软广或滤镜，真实体验、踩雷槽点与深度博弈往往集中在**评论区**，尤其是折叠的**二级回复（楼中楼）**中。

> ⚠️ 行为约束（必须先读）：本专项受根 SKILL.md「Agent 行为约束」和根目录 `KNOWN_ISSUES.md` 约束。遇到验证码页（`website-login/captcha` /「Security Verification」）或大量 404 时，**立即停止并等待用户手动验证**，禁止疯狂重试；**优先用页面内弹窗**查看笔记，看完关闭弹窗再点下一条，不要为每条内容开新标签页。

## 核心规约

1. **展开评论区为强制动作**：只要进入小红书笔记，必须完整向下滚动评论容器加载一级评论，并**逐一点击展开所有「展开 X 条回复」/「展开更多回复」**，尽量搜集全部评论信息给下游分析。
2. **免手写，优先使用内置专属脚本**：已内置开箱即用的自动化抓取脚本 `extract-xhs-comments.mjs`。

## 一键抓取全部评论命令

```bash
# 自动寻找小红书标签页，全量滚动触底并递归展开所有二级回复，输出完整格式化评论树
BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node ~/.agents/skills/agent-browser-bridge/scripts/extract-xhs-comments.mjs

# 指定标签页 ID 与最大滚动轮数，并保存完整 JSON
node ~/.agents/skills/agent-browser-bridge/scripts/extract-xhs-comments.mjs <tabId> --max-scrolls 35 --out xhs_comments.json

# 若在搜索结果列表页，自动打开第 0 张卡片并抓取全量评论
node ~/.agents/skills/agent-browser-bridge/scripts/extract-xhs-comments.mjs <tabId> --card 0
```

脚本内置拦截：检测到验证码页 / Security Verification / 404 时自动退出并提示，不会继续滚动请求。

## 页面内搜索（示例脚本，不新开标签页）

优先用页面内搜索框搜索，不要用 URL 打开新的 search_result 标签页。一键脚本：

```bash
BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node ~/.agents/skills/agent-browser-bridge/scripts/xhs-search-inpage.mjs <tabId> "<关键词>" [--max-results N]
```

实测要点（2026-09-10 验证通过）：
- 桌面端顶部搜索栏的真实输入框是**可见的 `textarea.textarea`**，不是隐藏的 `input.search-input`（0×0 不可见，向它输入不生效）
- 受控组件输入必须用 `HTMLTextAreaElement` 的 native value setter + InputEvent
- 提交用 Enter（keydown）或点 `.bottom-box-right-submit-button`；结果跳转到 `/search_result` 或 `/search_result_ai`
- 结果卡片：`section.note-item` 内的 `.title`（标题）+ `a[href*="/explore/"]`（链接）
- 多关键词时：**复用同一 tab**，输入框输入新词 → Enter，循环即可，不要开新标签页

## 自动化执行逻辑（底层规范）

1. **滚动加载一级评论**：小红书为流式虚拟容器，定位 `.note-scroller` / `.interaction-container`，执行 `scroller.scrollTop = scroller.scrollHeight` 循环滚动，直到连续多次无新增评论项判定触底。
2. **递归展开二级回复**：扫描所有带有 `show-more`、`expand-btn` 或包含 `展开` / `条回复` 的折叠元素，执行 `.click()`，并在多轮内处理展开后新冒出的“展开更多回复”，直到彻底无折叠按钮。
3. **评论树结构化提取**：
   - 提取一级评论：作者、正文、点赞数、发布时间与属地、是否作者赞过；
   - 提取楼中楼二级回复：回复人、回复内容、时间属地、点赞数；
   - 提取笔记元数据：标题、正文、作者、点赞/收藏/评论数。

## 单条笔记全量抓取（示例脚本，所有图片 + 所有文字 + 所有评论）

一条笔记的全部信息一次拿全：笔记元数据（标题/作者/正文/时间地点/赞藏评）+ **全部轮播图 URL** + **全部评论（含楼中楼二级回复）**，全程不新开标签页。

```bash
# 笔记详情页直接抓
BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node ~/.agents/skills/agent-browser-bridge/scripts/xhs-note-full.mjs <tabId> [--max-scrolls 30] [--out note.json]

# 在搜索/列表页，用页面内弹窗点开第 N 张卡片再抓（不新开 tab）
BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node ~/.agents/skills/agent-browser-bridge/scripts/xhs-note-full.mjs <tabId> --card 0 --out note.json

# 输出结构化 JSON（默认是易读文本）
... --format json
```

执行流程与实测要点（2026-09-10 验证）：
- 状态检查：验证码/404 立即停止不重试
- **⚠️ 点卡片必须点「可见」的封面链接 `a.cover.mask.ld`（带 xsec_token）；卡片内第一个 `a[href*="/explore/"]` 是 `display:none` 的隐藏链接，`click()` 会触发风控 404，禁止使用**（实测已确认：选错就 404，选对就正常打开）
- 列表页自动弹窗点开卡片；**只滚动弹窗内右侧滚动区 `.note-scroller` 触底加载全部一级评论——绝不滚动 window**（否则弹窗背后的列表页滚动位置被带跑，关闭后列表位置丢失；实测列表页 scrollY 全程不变）；无 `.note-scroller` 时回退弹窗容器内第一个可滚动元素
- **递归展开所有「展开 X 条回复」/「展开更多回复」折叠按钮（最多 6 轮）**，再提取楼中楼
- 提取：标题 `.title`、正文 `.desc`、作者 `.author-wrapper .name`、时间/地点 `.date`/`.location`、图片 `.swiper-slide`（跳过 `.swiper-slide-duplicate` 副本后按 URL 去重；**保留 `!nd_dft_wlteh_webp_3` 等完整参数——去掉会 403，必须原样保留**；live photo 的 slide 内含 `<video src="blob:…">`，标记 `isLive:true` 并提取 `liveVideo`(blob URL，仅会话内有效，不可外部访问)；实测 6 图含 2 张 live photo 全部 200 可访问；**轮播图全部渲染在 DOM，新打开不滚动也能拿全**）
- 互动计数：**限定在 `.engage-bar` 内**取 `.like-wrapper`/`.collect-wrapper`/`.chat-wrapper`（评论区也有同名 wrapper）；小红书网页端**不提供**喜欢/收藏的人列表，只能取计数
- 脚本内嵌表达式是模板字符串：**正则必须写双反斜杠**（`\\d`/`\\s`/`\\.`）——单反斜杠 `\d` 会被模板字符串丢弃成 `d`，数字/空白匹配会静默失败（实测踩坑：赞藏评全空，诊断见正则变成 `/^d+/`）
- `--close`：抓取完成后健壮关闭弹窗（Esc → 关闭按钮 → 点遮罩空白，三级兜底 + 轮询验证），回到列表页可继续 `--card` 点下一条
- 已验证（实测）：展开触发 6 次、楼中楼对话树完整提取、close-btn 关闭成功、列表页恢复后继续点开
- 注意：小红书对当前会话有风控时，新点开的笔记可能返回 404（列表可见但详情不可达）——此时立即停止，等待用户手动完成验证码/风控解除

## 批量跨笔记抓取（多关键词 → 一次性拿全，实测补充 2026-09-10）

单篇抓取用上面的 `--card N` 循环即可；但**一次跑几十个关键词、上百篇笔记**时，有三个坑必须自己兜住（内置脚本未覆盖）：

1. **去重必须按「笔记真实 ID」而非卡片 href**。列表页卡片的 `a[href]` 是带 `xsec_token` 的 `search_result` 链接，**同一条笔记在不同关键词下 href 不同、ID 也对不上**，按 href 去重必然失败（同一篇会被抓 3～5 次）。正确做法：从**弹窗打开后**（或 `note` 数据里）取真实 URL，用其中的 `explore/<id>` 段去重。
2. **复用 tab 时校验关键词没漂移**。脚本复用一个 search tab 连续换词，但小红书可能把结果页落到 `/search_result_ai` 或残留上一次结果；只判断 URL 含 `search_result` 会误判「已在新结果页」。必须 `decodeURIComponent(location.href).includes(kw)` 再往下走，否则会拿 A 关键词的结果当 B 的。
3. **陈旧遮罩要取「最后一个可见」并全部关闭**。连续点开笔记会让小红书残留多个 `.note-detail-mask`，若按 `querySelector` 取第一个，拿到的是上一次的旧 DOM（内容和图片全错），且遮罩叠着会挡住下一次点击。做法：筛出**可见**遮罩，取**最后一个**读取数据，然后**关闭全部可见遮罩**再点下一条。

补充：图片 URL 可直接在页面外 `curl` 下载（带上 `Referer: https://www.xiaohongshu.com/`），不必在浏览器里逐张存盘；批量下载后再用 `sips -s formatOptions 66 -Z 560` 之类压缩，能显著减小本地体积。

## 页面交互注意

- **优先页面内跳转/点开，不要开新标签页**：每个笔记都是可点开的页面内弹窗——在搜索/列表页点开卡片即弹窗，弹窗内可完成正文与评论读取；看完关闭弹窗（点遮罩或关闭按钮）再点下一条。换目标时优先在当前 tab 内跳转，确需新开 tab 时用完立即关闭。
- 受控组件输入（搜索框等）用 native setter + InputEvent，参考根 SKILL.md「实战踩坑清单」第 5 条。
