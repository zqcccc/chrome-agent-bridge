---
name: notebooklm
description: 通过 Bridge 操作真实 Chrome 里的 NotebookLM（Gemini Notebook）网页版——新建笔记本、上传来源（含视频/音频/图片/PDF）、提问取回答、生成并下载 Studio 产物（音频概览/视频/演示文稿/思维导图/报告/闪卡/测验/信息图/数据表格）。当需要让 NotebookLM 分析视频、音频、图片或文档，或要把网页/YouTube 作为来源喂给它时使用。注意：网页版只接受本地文件上传（走 CDP 注入），不依赖任何非官方 API。
---

# NotebookLM（Gemini Notebook）via Bridge

用 Bridge 驱动**真实 Chrome 的登录态**操作 NotebookLM 网页版。不需要 API key、
不需要非官方库、不受官方 API 的上传格式白名单限制——**网页版收视频、音频、图片**。

## 前置条件（每次开始前检查）

1. Bridge 就绪：`curl -s http://127.0.0.1:8778/status` → `extConnected:true`
2. **网络出口必须在 NotebookLM 开放地区**。未开放时会强制跳转
   `https://notebook.google/?location=unsupported`（落地页标题是 Gemini Notebook 但进不去应用）。
   香港 / 中国大陆实测不可用。**美国节点可用**。
   切换（Clash Verge，external-controller `127.0.0.1:9097`，secret `examplepass`）：
   ```bash
   G=$(python3 -c "import urllib.parse;print(urllib.parse.quote('手动选择'))")
   curl -s -H "Authorization: Bearer examplepass" "http://127.0.0.1:9097/proxies/$G" \
     | python3 -c "import json,sys;print('当前:',json.load(sys.stdin).get('now'))"
   # 列出 P3(日本/新加坡/美国) 的活节点
   curl -s -H "Authorization: Bearer examplepass" "http://127.0.0.1:9097/providers/proxies/3.subscribe" \
     | python3 -c "
import json,sys,re
for x in json.load(sys.stdin).get('proxies',[]):
    n=x.get('name',''); h=(x.get('history') or [{}])[-1]
    if re.search(r'美国|US|日本|JP|新加坡|SG',n) and h.get('delay',0)>0: print(n, h['delay'])
"
   # 切换
   curl -s -X PUT -H "Authorization: Bearer examplepass" -H "Content-Type: application/json" \
     "http://127.0.0.1:9097/proxies/$G" -d '{"name":"P3| 美国USLA-A"}'
   ```
   切完**必须**验证出口变了：`curl -s -x http://127.0.0.1:7897 https://ifconfig.co/json`
   注意延时测试为 0 的节点是死的，别选。
3. Chrome 登录了 Google 账号（PRO 订阅额度更高）。

## 路径约定

沿用根 SKILL.md：`<skill 目录>` = 本文件所在目录，`$ROOT` = 上两级，`<cli>` = `$ROOT/agent/cli.mjs`。
本子 skill 脚本自包含，不依赖 CLI。

```bash
NB="<skill 目录>"        # 本目录
export BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token)
```

## 核心脚本（优先直接跑，禁止自己重造）

`upload.mjs` / `ask.mjs` / `scripts/nblm-*.mjs` 已处理 NotebookLM 的坑（文件输入需先点「添加来源」再点「上传文件」并轮询、严格 CSP 下页面内 JS 走 CDP、Studio 产物生成等待）。**自己写脚本容易卡在这些交互时序上，也会绕过既有等待策略。** 需求不匹配时先改参数；确实缺功能才以现有脚本为模板复制改写，并在交付说明注明来源。

| 脚本 | 用途 |
|---|---|
| `upload.mjs` | 上传本地文件到笔记本（含视频/音频/图片） |
| `ask.mjs` | 提问并取回回答 |

### 上传文件

```bash
node "$NB/upload.mjs" <tabId> /path/to/a.mp4 /path/to/b.png
node "$NB/upload.mjs" --new "笔记本标题" <tabId> /path/to/file   # 先新建笔记本
```

输出 JSON：`{ok, notebookUrl, sourcesBefore, sourcesAfter, files}`。
`sourcesAfter > sourcesBefore` 即成功。

### 提问

```bash
node "$NB/ask.mjs" <tabId> "请总结这个视频的核心观点" --timeout 120000
```

输出 JSON：`{ok, notebookUrl, question, answer, citations}`。

## 关键实现要点（踩过的坑，别改回去）

1. **file input 是懒加载的，必须点两次才出现**
   只点「添加来源」不够，还要再点「上传文件」按钮，`<input type=file>` 才被创建。
   `upload.mjs` 的 `waitForFileInput()` 已处理（先点添加来源 → 再点上传文件 → 轮询）。

2. **必须用 CDP `DOM.setFileInputFiles` 注入，伪造 DataTransfer 无效**
   用 JS 造 `new File()` + `dispatchEvent(new DragEvent('drop'))` —— 事件能派发、
   `dt.files.length` 也是 1，但 Angular 读不到内容，来源数不变。
   `DOM.setFileInputFiles` 传**真实文件路径**才有效（需 `DOM.getDocument {pierce:true}`
   + `DOM.querySelectorAll` 拿 nodeId）。

3. **提问框是 Angular 受控组件**
   直接改 `textarea.value` 不触发变更检测。必须用原生 setter：
   ```js
   const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
   setter.call(box, text);
   box.dispatchEvent(new Event('input',{bubbles:true}));
   ```

4. **抓回答别用「页面最长文本」兜底**
   会抓到 Studio 侧边栏（音频概览/演示文稿/思维导图/闪卡/测验/信息图/数据表格）。
   正确容器：`.to-user-container .message-text-content`。

5. **页面有强 CSP（Trusted Type）**
   `page.evaluate` 会报 `EVAL_ERROR: Evaluating a string as JavaScript violates...`。
   一律用 `scripts/cdp-eval.mjs`（走 CDP `Runtime.evaluate`，不受 CSP 约束）。

6. **域名会重定向**：`notebooklm.google.com` → `notebook.google.com`（产品改名 Gemini Notebook）。
   判定失败看 URL 尾巴是不是 `?location=unsupported`。

## 支持的文件格式（网页版 accept 实测）

- **视频**：`.mp4 .avi .mpeg .3gp .3g2`
- **音频**：`.mp3 .m4a .aac .aif .aiff .aifc .amr .au .ogg .opus .ra .snd .wav .wma`
- **图片**：`.png .jpg .jpeg .jpe .webp .gif .bmp .avif .heic .heif .jp2 .ico .tif .tiff`
- **文档**：`.pdf .txt .md .docx .csv .pptx .epub`

> 对比：官方/非官方 **API** 通道只收 `.csv .docx .epub .md .markdown .pdf .pptx .txt`
> （见 notebooklm-py `_UPLOAD_FILE_EXTENSIONS`），**不收视频/图片**。
> 所以要用视频/图片就必须走**网页版 + Bridge**，这正是本 skill 存在的理由。

## 典型流程：手机分享视频 → NotebookLM 分析

```bash
# 1) 手机发链接到 TG → watcher 落到 ~/inbox，URL 进 fetch-queue
# 2) 下载视频（yt-dlp；B站等需 cookie）
yt-dlp -o "$HOME/inbox/media/%(title)s.%(ext)s" "<url>"
# 3) 打开 NotebookLM 并上传
node "$NB/upload.mjs" --new "分析：xxx" <tabId> "$HOME/inbox/media/xxx.mp4"
# 4) 提问取回答
node "$NB/ask.mjs" <tabId> "总结这个视频的核心观点，列出关键时间点" 
```

## 已知限制

- 视频/音频上传后需等 NotebookLM 转码，提问可能暂时看不到该来源，
  等几分钟重试即可（来源区会显示 `video_audio_call <文件名>` 表示已识别）。
- Studio 产物（音频概览/视频概览等）的生成与下载尚未脚本化，需人工点。
- 地区限制是硬门槛，换节点是唯一解法；换完记得验证出口 IP 真的变了。
