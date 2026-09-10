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

## 页面内搜索 + 筛选 + 频道切换（示例脚本，不新开标签页）

优先用页面内搜索框搜索，不要用 URL 打开新的 search_result 标签页。一键脚本：

```bash
BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node ~/.agents/skills/agent-browser-bridge/scripts/xhs-search-inpage.mjs <tabId> "<关键词>" [--max-results N] [--channel 全部|图文|视频|用户] [--filter "分组:选项;分组:选项"]
```

支持的筛选分组（实测普通版 search_result 页可用，与右侧筛选面板一致；**AI 新版搜索页无筛选按钮，会自动跳过**）：

| 分组 | 可选项（实测 2026-09-10，含截图对照） |
|---|---|
| 排序依据 | 综合 / 最新 / 最多点赞 / 最多评论 / 最多收藏 |
| 笔记类型 | 不限 / 视频 / 图文 |
| 发布时间 | 不限 / 一天内 / 一周内 / 半年内 |
| 搜索范围 | 不限 / 已看过 / 未看过 / 已关注 |
| 位置距离 | 不限 / 同城 / ~~附近~~（**需浏览器定位权限，默认跳过**） |

示例：搜「瑞士 一天 往返 意大利」，只看一周内的最新视频笔记：

```bash
BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node ~/.agents/skills/agent-browser-bridge/scripts/xhs-search-inpage.mjs <tabId> "瑞士 一天 往返 意大利" --channel 视频 --filter "排序依据:最新;发布时间:一周内;笔记类型:视频" --max-results 20
```

示例：看「未看过」的「最多评论」笔记：

```bash
... --filter "排序依据:最多评论;搜索范围:未看过"
```

筛选面板实测结构与选项激活（2026-09-10）：
- 面板 DOM：`.filter-panel > .filter-container > .filters-wrapper > .filters`（每个 `.filters` 是一组，组名在直接子 `span`；组内选项是 `.tag-container .tags`，文本在 `span`，当前选中项带 `.active`）；底部 `.operation-container` 有「重置」「收起」
- **每个选项点选后脚本会验证是否真的获得 `.active`**（实测「最多评论 / 未看过 / 图文」都验证通过）。**「位置距离:附近」默认视为无定位权限，直接跳过不点击**（输出 `skipped:true, reason:'需要浏览器定位权限，默认不可用'`），不尝试授权也不假装成功；如需使用，先在 `chrome://settings/content/location` 允许 www.xiaohongshu.com 定位后再用
- 页面里另一个扩展注入的隐藏副本带 `button-hp-installed` / `aria-hidden="true"`，点 `.tags` 时必须过滤掉（脚本已处理）

实测要点（2026-09-10 验证通过）：
- **搜索框有两种形态**：展开态 `textarea.textarea`（首页/探索页）、紧凑态 `input.search-input`（结果页 sticky 头部，实测 489×40 可见可输入）。页面上可能同时存在 0×0 的隐藏 `input.search-input`，必须按「宽高 > 0 且 display 非 none」过滤后再取。脚本已内置两种形态的兼容与隐藏元素过滤
- **操作前先 `window.scrollTo(0, 0)`**：页面滚动后顶部搜索框移出视口，旧的可见性检查（要求 `r.y >= 0`）会误判「找不到搜索框」（实测踩坑）
- 受控组件输入必须用 native value setter + InputEvent：`textarea` 用 `HTMLTextAreaElement.prototype`，`input` 用 `HTMLInputElement.prototype`（按 `ta.tagName` 选原型）
- 提交用 Enter（keydown）或点 `.bottom-box-right-submit-button`；结果跳转到 `/search_result` 或 `/search_result_ai`
- **布局判定只看 `.channel-scroll-container-ai`**：`document.documentElement` 上的 `ai-layout-active` 是**账号级全局类**（开了 AI 布局的账号在普通 search_result 页也有），不是页面类型标志，用它判断会误报 AI 布局
- **筛选按钮只在笔记类频道（全部/图文/视频）显示**：若当前停在「用户」频道，脚本会自动先切回「全部」再应用筛选
- 结果卡片：`section.note-item` 内的 `.title`（标题）+ 可见封面链接 `a.cover.mask.ld`（卡片里第一个 `a[href*="/explore/"]` 是 `display:none` 隐藏链接，禁止点击）
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

## 问点点 AI 问答（搜索页 AI 功能，示例脚本）

部分搜索结果页带「问点点」频道（新版 AI 搜索页 `/search_result_ai` 或 `/ai_chat_tab`）。脚本在 AI 回答完成后取回完整输出（markdown 全文 + 总结标题 + 是否带引用笔记）。

```bash
# 默认 text 可读输出
BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node ~/.agents/skills/agent-browser-bridge/scripts/xhs-ask-diandian.mjs <tabId> "瑞士 一天 往返 意大利"

# 输出纯 markdown 回答正文（可直接投喂下游）
... --format markdown --out diandian.md

# 回答较长时增大等待
... --wait 120 --format json
```

实测要点（2026-09-10 验证通过）：
- 进入路径：若当前是 AI 搜索页，直接点频道 `.channel-scroll-container-ai #ask_diandian`；否则脚本自动 `page.navigate` 到 `search_result_ai` 再点（**不要**在页面内改 `location.href`）
- 回答完成标志：`.ai-message.ai-message-finished`；生成中为 `.ai-message:not(.ai-message-finished)`
- 回答正文：`.xhs-ai-md-container .markdown-block` 的 `data-original-text` 属性是**完整 markdown 原文**，`innerText` 是渲染文本
- 总结标题：`.progress-wrapper .progress-text`（如「ai总结67篇笔记生成」）；`data-has-reference="true"` 表示回答带引用笔记
- 追问输入框：`textarea.textarea--v1-caret`（placeholder「搜索或者输入任何问题」），Enter 或 `.bottom-box-right-submit-button` 发送
- 回答生成耗时随笔记量变化，默认等 90s；**若页面出现验证码/安全验证立即停止，不要重试**

## 搜索用户（示例脚本）

小红书搜索页支持搜用户（「用户」频道）。脚本：输入关键词 → Enter → 切「用户」频道 → 读用户卡片（姓名/小红书号/粉丝/笔记数/最近更新/主页链接）。

```bash
BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node ~/.agents/skills/agent-browser-bridge/scripts/xhs-search-user.mjs <tabId> "囍欢" [--max-results 10]
```

实测要点（2026-09-10 验证通过）：
- 频道 Tab：普通版 `#channel-container #user`；AI 新版 `.channel-scroll-container-ai #user`（都叫「用户」），脚本两种都兼容
- 用户卡片：`.user-list-item`，卡片整块是 `a[href*="/user/profile/"]` 链接（主页链接可直接给下游 `xhs-user-notes.mjs` 用）
- **卡片行序不固定**：部分用户卡片多一行品类标签（如「服饰鞋帽」），`.user-desc-box` 按下标取粉丝/笔记会错位（实测踩坑：`TheBrideParis` 的粉丝被取成「服饰鞋帽」）。正确做法：姓名/最近更新用结构化选择器 `.user-name`/`.user-tag`（实测可靠），粉丝/笔记/小红书号用整卡文本按语义正则匹配
- 自己的账号会以「我」卡片置顶（无 xsec_token）

## 用户主页全部笔记（示例脚本）

从用户主页拉取该用户发布的全部笔记列表（作者名 + 笔记 ID + 标题 + 赞数 + 封面 + 带 xsec_token 的详情链接），自动滚动加载。

```bash
BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) node ~/.agents/skills/agent-browser-bridge/scripts/xhs-user-notes.mjs <tabId> [--max-scrolls 20] [--out user_notes.json] [--format json|text]
```

实测要点（2026-09-10 验证通过）：
- 用户信息：`.info`（简介/小红书号）+ `.data-info`（关注/粉丝/获赞与收藏，纯数字+标签成对取）
- 笔记卡片：`.feeds-container .note-item`，从卡片链接里提取真实 `noteId`（`/user/profile/<uid>/<noteId>` 段）
- **⚠️ 主页上的「笔记・N」计数 chip 是「收藏」子分类数**（与「文件・0」同排，属于收藏 tab 的三级标签），**不是本人笔记总数**，不要用它判断是否抓全或做截断告警（实测踩坑：误以为某用户 143 条只加载 15 条，实际 143 是收藏数、本人笔记就 15 条）
- 滚动加载：脚本对 window 与页面内可滚动容器都触发滚动；连续多轮条数不增长即视为加载完毕
- 需要逐条详情（正文/图片/全部评论）时，把 `noteId` 拼成 `https://www.xiaohongshu.com/explore/<noteId>`（或直接用输出的带 token 链接），再跑 `xhs-note-full.mjs` 逐条抓

## 端到端示例：搜用户 → 拉全部笔记 → 逐条抓详情

```bash
BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token) TAB=<tabId>

# 1) 搜用户，拿到主页链接
node ~/.agents/skills/agent-browser-bridge/scripts/xhs-search-user.mjs $TAB "山姆" --max-results 5
#    → users[].href 形如 https://www.xiaohongshu.com/user/profile/<uid>

# 2) 同 tab 导航到该用户主页（用 page.navigate，勿改 location.href）
#    然后拉全部笔记
node ~/.agents/skills/agent-browser-bridge/scripts/xhs-user-notes.mjs $TAB --max-scrolls 20 --out user_notes.json --format json
#    → notes[].noteId

# 3) 同 tab 导航到笔记详情页（https://www.xiaohongshu.com/explore/<noteId>）
#    逐条全量抓取（正文 + 图片 + 全部评论含楼中楼）
node ~/.agents/skills/agent-browser-bridge/scripts/xhs-note-full.mjs $TAB --max-scrolls 30 --out note_1.json --format json
```

## 批量跨笔记抓取（多关键词 → 一次性拿全，实测补充 2026-09-10）

单篇抓取用上面的 `--card N` 循环即可；但**一次跑几十个关键词、上百篇笔记**时，有三个坑必须自己兜住（内置脚本未覆盖）：

1. **去重必须按「笔记真实 ID」而非卡片 href**。列表页卡片的 `a[href]` 是带 `xsec_token` 的 `search_result` 链接，**同一条笔记在不同关键词下 href 不同、ID 也对不上**，按 href 去重必然失败（同一篇会被抓 3～5 次）。正确做法：从**弹窗打开后**（或 `note` 数据里）取真实 URL，用其中的 `explore/<id>` 段去重。
2. **复用 tab 时校验关键词没漂移**。脚本复用一个 search tab 连续换词，但小红书可能把结果页落到 `/search_result_ai` 或残留上一次结果；只判断 URL 含 `search_result` 会误判「已在新结果页」。必须 `decodeURIComponent(location.href).includes(kw)` 再往下走，否则会拿 A 关键词的结果当 B 的。
3. **陈旧遮罩要取「最后一个可见」并全部关闭**。连续点开笔记会让小红书残留多个 `.note-detail-mask`，若按 `querySelector` 取第一个，拿到的是上一次的旧 DOM（内容和图片全错），且遮罩叠着会挡住下一次点击。做法：筛出**可见**遮罩，取**最后一个**读取数据，然后**关闭全部可见遮罩**再点下一条。

补充：图片 URL 可直接在页面外 `curl` 下载（带上 `Referer: https://www.xiaohongshu.com/`），不必在浏览器里逐张存盘；批量下载后再用 `sips -s formatOptions 66 -Z 560` 之类压缩，能显著减小本地体积。

## 抓下来的图怎么用（下游渲染，实测补充 2026-09-10）

抓到的 `note.images[]` 每篇都是**该笔记的全部轮播图**（去掉 `isLive` 即纯图片，顺序 = 发布顺序，第 1 张是封面、常带大字排版）。渲染给用户看时：

- **按笔记成组，别把图片平铺成一个大网格**。用户看的是"这位作者这一趟晒的照片集"，一篇笔记一张卡（标题 + 作者/赞藏 + 正文摘要 + 原文链接 + 该篇全部图）。平铺会把同一作者的图拆散到不同行，反而看不出"一趟走了哪几个点"。
- 缩略图用 `display:flex;flex-wrap:wrap` + 固定高度、宽度 auto（**别用固定 aspect-ratio + cover 裁切**，会切掉构图）；点图开 lightbox 放大，并支持 ← → 连续翻看全站图集。
- 本地化压缩：`sips -s format jpeg -s formatOptions 64 -Z 560 in --out out`（长边 560px / q64 ≈ 60KB 一张；560 张约 34MB）。`-Z` 只在原图大于目标时才缩，不会放大。
- **脚本里不要调 `os.remove` / `rm -rf` 清目录**：本机沙箱对批量删除有闸（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，阈值 50 个文件/轮），删除循环跑到第 50 个就被中断，留下半删状态。正确做法：输出到新目录，或把旧目录整体 `mv` 改名留作回滚。

## 页面交互注意

- **优先页面内跳转/点开，不要开新标签页**：每个笔记都是可点开的页面内弹窗——在搜索/列表页点开卡片即弹窗，弹窗内可完成正文与评论读取；看完关闭弹窗（点遮罩或关闭按钮）再点下一条。换目标时优先在当前 tab 内跳转，确需新开 tab 时用完立即关闭。
- 受控组件输入（搜索框等）用 native setter + InputEvent，参考根 SKILL.md「实战踩坑清单」第 5 条。
