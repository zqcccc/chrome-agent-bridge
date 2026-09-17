---
name: linkedin
description: agent-browser-bridge 的子技能——LinkedIn（linkedin.com）职业档案的读取与编辑专项。当任务需要读 LinkedIn 档案（工作经历/项目/教育/技能）、改 Headline 与 About、增删改经历与项目、维护中英文双语言档案时，读取本文件执行。价值点：LinkedIn 是「严格 CSP + 表单全是 React 受控组件 + 富文本 TipTap 编辑器 + URL 无统一规律 + SDUI 懒渲染」五重叠加的站点，照直觉写脚本会在五个地方各踩一次坑，且报错信息都指向错误的方向。前置：根 SKILL.md 的桥已就绪（host 存活、扩展已连接，建议 ≥ v0.3.11），用户在浏览器中已登录 linkedin.com。
---

# LinkedIn 职业档案专项：读取与编辑

> **路径约定**：本文的 `<skill 目录>` 指本 skill 目录（即 `agent-browser-bridge/linkedin/`），`<仓库根>` = `<skill 目录>/../../..`，主 CLI 为 `<仓库根>/agent/cli.mjs`。**这些位置是可推导的，不要用 `find ~` 之类全盘搜索去定位**；完整约定见根 `SKILL.md`「路径约定（读本 skill 任何命令前先看这里）」一节。

用真实登录态读写 LinkedIn 职业档案。**本专项的核心价值不是「会点按钮」，而是把 LinkedIn 五个反直觉的坑一次性收敛掉**——每一条都是实测踩出来的，且错误现象都指向错误的方向（详见下文「五个坑」）。

> ⚠️ 必须先读：本专项受根 `SKILL.md`「Agent 行为约束」与根目录 `KNOWN_ISSUES.md` 约束。遇到登录墙 / 验证码 / 二次验证时**立即停止并让用户手动处理**，禁止替用户登录或绕过验证。

## 第一原则：用现成脚本与公共层，不要从零写

| 需求 | 用什么 |
| --- | --- |
| 读档案（经历/项目/教育/技能） | `scripts/linkedin-read.mjs`（只读，无副作用） |
| 改 Headline / About | `scripts/linkedin-edit.mjs` |
| 写自己的多步流程 | `scripts/lib/linkedin.mjs` 的公共层 |

```bash
export BRIDGE_TOKEN=$(cat ~/.chrome-agent-bridge/token)

# 只读：看现状（改任何东西之前都先跑这个）
node <skill 目录>/scripts/linkedin-read.mjs "https://www.linkedin.com/in/<你的slug>/" --all

# 改 Headline（先 --dry-run 看要写什么，再去掉它真正写）
node <skill 目录>/scripts/linkedin-edit.mjs <slug> --headline "前端 / AI 应用工程师 · ..." --dry-run
node <skill 目录>/scripts/linkedin-edit.mjs <slug> --headline "前端 / AI 应用工程师 · ..."

# 改 About（支持 --lang en 写英文档案；正文可用 --file 从文件读，避免长文本转义）
node <skill 目录>/scripts/linkedin-edit.mjs <slug> --about "正文..." --lang en
node <skill 目录>/scripts/linkedin-edit.mjs <slug> --about --file ./about-en.md --lang en
```

> ⚠️ **写公开档案的两个安全默认值**（`linkedin-edit.mjs` 已内置）：
> 1. **`--dry-run` 建议先跑**：只读现状并打印「将写什么」，不修改任何东西。
> 2. **非空字段默认拒绝覆盖**：字段已有内容时会报 `refused-non-empty` 并以退出码 1 结束，
>    确认要覆盖才加 `--force`。写公开档案是对外可见、不可撤销的动作，
>    静默覆盖不是安全的默认值。
> 3. **缺值/旗标被当成值会直接报错退出（码 2）**，不会把 `--dry-run` 这类字面量写进档案。

**禁止从零手写 LinkedIn 自动化脚本。** 自己写的脚本必然在下面五个坑里各踩一次，而且每个坑的报错都指向错误方向（例如 CSP 报错让你以为表达式写错、懒渲染让你以为这个人没填经历）。需求不匹配时**先改参数**；确实缺功能才自己写，且必须**以 `scripts/lib/linkedin.mjs` 为公共层**（不要绕过它自己拼 RPC），并在交付说明里注明改写来源。

## 五个坑（每一条都实测过，且现象都会误导你）

### 坑 1：严格 CSP —— `page.evaluate` 被拦，必须走 CDP

linkedin.com 的 `script-src` 不含 `'unsafe-eval'`，任何**字符串求值**都被拦：

```
EVAL_ERROR: Evaluating a string as JavaScript violates the following Content Security Policy
directive because 'unsafe-eval' is not an allowed source of script
```

**误判方向**：错误信息在说 CSP，很容易被当成「表达式语法写错了」去反复改表达式。实际与表达式无关。

**正确做法**：一律走 CDP `Runtime.evaluate`（走 DevTools 通道，不受页面 CSP 约束）。本 skill 的 `ev()` / `evJson()` 已封装：

```js
import { withProfile, ev, evJson } from "./lib/linkedin.mjs";
await withProfile(slug, async (tabId, rpc) => {
  const title = await ev(rpc, tabId, "document.title");              // 绕过 CSP
  const obj = await evJson(rpc, tabId, `(() => ({ n: 1 }))()`);      // 自动 JSON 解析
});
```

> 扩展 v0.3.3 起 `page.evaluate` 内部会自动兜底到 CDP，但**不要依赖这个兜底**：显式走 CDP 更快，也避开兜底路径上的会话状态问题（见坑 5）。

### 坑 2：SDUI 懒渲染 —— 后台标签页永远拿不到条目

LinkedIn 档案页已是 **SDUI**（server-driven UI），条目靠 `requestAnimationFrame` / 可见性懒渲染。Chrome 对**后台标签页把 rAF 完全暂停**（实测 2s 内 0 帧），于是：

- 页面能打开，正文里有导航、页脚、姓名、Headline；
- **就是没有条目**（工作经历 0 条、技能 0 条）；
- 不报任何错。

**误判方向**：极容易得出「这个人没填这段经历」「我的选择器写错了」的结论。实测某次技能区块读出 0 条，实际有 15 条——只差一次 `ensureActive`。

**正确做法**：操作档案页前先激活标签页（只切标签页、**不聚焦窗口**，不会把用户从别的应用里弹出来）。本 skill 的 `gotoForm()` 已默认做这件事：

```js
// gotoForm 内部默认先 page.ensureActive，再导航，等渲染完
await gotoForm(rpc, tabId, { slug, path: "/details/skills/" });
```

判据是 `document.hidden`（不是 `tab.active`）：非聚焦窗口里的活动标签页 rAF 正常，不需要动它。若自己写，用 `rpc.call("page.ensureActive", { tabId, restoreAfterMs: 60000 })`。

> 这同时是「为什么不能只看 `main li`」的原因：SDUI 后条目**不是** `<li>`（`main li` 数量为 0），类名是构建哈希（`_61ca0bf0` 之类，每次发版都变）。

### 坑 3：表单字段没有稳定 id / name，且 About 是 TipTap 富文本

- **字段 id 是 React 生成的**（实测形如 `«r0»`、`«Rmscom59j6»`），每次渲染都可能变 → 按 id 找必失效。
- **多数字段没有 `name` 属性** → 按 name 找全军覆没。
- **About / 项目描述等是 TipTap / ProseMirror 富文本**（`.tiptap.ProseMirror[contenteditable=true]`，外包 `[data-testid="ui-core-tiptap-text-editor-wrapper"]`）：赋 `innerText` 会被 ProseMirror **静默忽略**，必须写 `innerHTML` 再派发 `InputEvent`。

**正确做法**：按 **`aria-label` / label 文本**定位（稳定），富文本下钻到 `.ProseMirror`。本 skill 的 `fieldExpr()` / `fillField()` 已封装：

```js
await fillField(rpc, tabId, "关于", aboutText);   // 自动识别富文本 vs input
await fillField(rpc, tabId, "名", "<你的名>");       // 受控 input：用原型 setter + input/change 事件
await dumpFields(rpc, tabId);                     // 不确定标签文本时先 dump 全部字段
```

受控组件的正确写法（`fillField` 内部）：用**原型上的原生 setter** 绕开 React 的 value 拦截器，再派发事件让 React 同步 state：

```js
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
setter.set.call(el, v);                                   // 不是 el.value = v
el.dispatchEvent(new Event("input", { bubbles: true }));
el.dispatchEvent(new Event("change", { bubbles: true }));
```

直接 `el.value = v` 只改 DOM、React 的 state 没变，**提交时值被 state 覆盖回空**——表现为「明明填进去了，保存后是空的」。

### 坑 4：表单 URL 无统一规律 + 两种点击语义

实测的各区块 URL（**不要靠猜，照抄**）：

| 区块 | URL |
| --- | --- |
| Intro / Headline | `/edit/intro/` |
| About | `/edit/forms/summary/new/?profileFormEntryPoint=GUIDANCE_CARD` |
| 经历 | `/edit/forms/position/<id>/` 或 `/details/experience/edit/forms/<id>/` |
| 教育 | `/edit/forms/education/new/` 或 `/details/education/edit/forms/<id>/` |
| 项目 | `/details/projects/edit/forms/<id>/`（**没有** `/edit/forms/project/new/`） |
| 技能 | `/skills/edit/forms/new/`（**`/edit/forms/skill/new/` 是 404**） |
| 语言档案切换 | `/edit/secondary-language/` |

注意 `/edit/summary/` **是 404**（实测显示「此页面不存在」）；About 必须从上面的 `forms/summary/new/` 进。

**两种点击语义并存，且不等价**（实测）：

- 表单里的「删除项目」只认 `el.click()`（合成事件），真实鼠标事件无效；
- 确认框里的「删除」只认真实鼠标事件（CDP `Input.dispatchMouseEvent`），`el.click()` 无效。

所以两种都要有：`clickEl()` 与 `clickReal()`。**不要试出一种就以为另一种也行。**

同名按钮还必须**限定作用域**：表单底部和确认框里都有「删除」。确认框的取消按钮文案是「**不，谢谢**」（不是「取消」），确认框文本形如「删除项目 删除&lt;名称&gt;？此操作不可撤消。」——用它作为「确实是确认框」的判据，不要只数 dialog 个数（表单本身也是一个 dialog）。

### 坑 5：CDP 兜底会拆掉你自己的调试会话（扩展 ≤ v0.3.11 的 bug）

在严格 CSP 站点上「先 `page.evaluate`（触发 CDP 兜底）再 `ev()`」会连锁失败：

```
EVAL_ERROR: ... Content Security Policy ...          ← 兜底自己因竞态拿不到结果
SESSION_SEND_FAILED: Debugger is not attached to the tab with id: ...   ← 下一次 ev 失败
```

根因：扩展里 CDP 兜底求值**无条件** `chrome.debugger.detach()`，把 agent 自己 `session.attach` 的会话一并拆了，而扩展的 `cdpSessions` 集合仍留着 tabId → 两边状态不一致。

**已修**（扩展侧收敛为 `withBorrowedDebugger()`，谁借的谁还）。**若遇到 `SESSION_SEND_FAILED` 且消息是「Debugger is not attached」，先确认扩展版本 ≥ 0.3.12**，不要怀疑自己的脚本：

```bash
curl -s http://127.0.0.1:8778/status | python3 -c 'import json,sys;print(json.load(sys.stdin).get("version"))'
```

版本偏低时告知用户升级扩展（升级步骤见根 `SKILL.md` / 仓库 `AGENTS.md`，不在本子技能重复）。
在此之前的绕开办法：**全程只用 `ev()` / `evJson()`，不要混用 `page.evaluate`**，就不会触发那个兜底路径。

## 语言档案（中英文各一份）

- **语言档案靠 URL 参数切换**，不是页面内 tab（页面里那对「简体中文（主档案）| English」链接本身就是带参 URL）：`?language=en&country=US`。
- 不带参数 = 主档案（primary）。
- **About 与经历支持本地化**（表单里会出现语言页签）；**Headline 不可单独本地化**（LinkedIn 平台限制：保存时不发任何 voyager 请求，静默不生效）。
- **项目 / 教育 / 技能没有语言维度**。

```js
langParams("en")      // "language=en&country=US"（**不带 ?**，用 withQuery 合并）
langParams("primary") // ""
withQuery("/edit/intro/", langParams("en"))                         // "/edit/intro/?language=en&country=US"
withQuery("/edit/forms/summary/new/?profileFormEntryPoint=X", langParams("en"))
// → "...?profileFormEntryPoint=X&language=en&country=US"
```

> ⚠️ **不要自己拼 `?language=en`**：About 的表单路径本身就带查询串（`?profileFormEntryPoint=GUIDANCE_CARD`），
> 直接再拼一个 `?` 会拼出**双问号的非法 URL**。实测 LinkedIn 会把 `?language=en` 当成前一个参数值的
> 一部分（变成 `...GUIDANCE_CARD%3Flanguage%3Den`），于是**静默回退到主档案内容**——
> 你以为在读英文档案，读到的是中文，**而且不报任何错**（实测英文 About 应为 1576 字符，
> 拼错时拿到 768 字符的中文）。用 `withQuery()` 合并。

**建议顺序：先中文、后英文。** 先建英文档案时，LinkedIn 会把空白的版块按主语言复制一遍，造成中英混杂。

## 变更类操作必须回读验证（强制）

**不要以「点了保存」为成功依据。** LinkedIn 保存失败时可能弹校验错误、也可能静默无反应，而脚本已经打印了 ✓。本 skill 的 `saveAndVerify()` 做三重验证：

1. 表单弹窗是否关闭（保存成功会关）
2. 是否出现错误提示（`[role=alert]` / `.artdeco-toast-item`；成功文案是「保存成功。」）
3. 调用方传入的 `verify()` 回读校验

```js
const r = await saveAndVerify(rpc, tabId, {
  verify: async () => {
    const sec = await readSection(rpc, tabId, { slug, section: "skills" });
    return { ok: sec.items.some((i) => i.text === "Rust") };
  },
});
if (!r.ok) throw new Error(`保存未生效: ${r.reason}`);
```

删除同理，用 `deleteEntry()`，并传 `expectGone` 回读确认真的没了：

```js
await deleteEntry(rpc, tabId, {
  slug, editPath: "/details/projects/edit/forms/708454961/",
  deleteButtonText: "删除项目",
  confirmPattern: "删除项目",          // 确认框文本特征
  expectGone: async () => {
    const s = await readSection(rpc, tabId, { slug, section: "projects" });
    return { ok: !s.items.some((i) => i.editId === "708454961") };
  },
});
```

> **写操作前的安全底线**：先 `--dry-run`（或先 `linkedin-read.mjs`）确认现状；改公开档案是**对外可见**的动作，无法撤销历史。

## 公共层 API（`scripts/lib/linkedin.mjs`）

| 函数 | 作用 |
| --- | --- |
| `withProfile(url, fn, opts)` | 开 tab → 跑 `fn(tabId, rpc, slug)` → 自动关掉自己开的 tab（复用用户 tab 时不动） |
| `normalizeSlug(input)` | 把 URL / slug / 带参 URL 统一成 `https://www.linkedin.com/in/<slug>` |
| `langParams(lang)` | `"en"` → `language=en&country=US`（不带 `?`）；`primary` → `""` |
| `withQuery(path, params)` | 安全合并查询参数（路径已带 `?` 时用 `&`，避免双问号） |
| `ev` / `evJson` | CDP 求值（绕过 CSP）；`evJson` 自动解析 JSON |
| `gotoForm(rpc, tabId, {slug, path, lang})` | **先激活标签页**再导航，并等到表单/内容真的渲染完 |
| `waitDialog` | 等对话框（表单/确认框）出现 |
| `fieldExpr(labelText)` | 生成「按 aria-label 找字段」的 JS 表达式（含富文本下钻） |
| `dumpFields(rpc, tabId)` | dump 当前表单全部字段（不确定标签文本时先看这个） |
| `fillField(rpc, tabId, label, value)` | 写字段（自动识别富文本 / 受控 input），**写完回读校验** |
| `readField(rpc, tabId, label)` | 读字段当前值 |
| `clickReal` / `clickEl` | 两种点击语义（真实鼠标 / `el.click()`） |
| `clickButtonByText(rpc, tabId, text, {scope})` | 按文本点击，**默认限定在最后一个 dialog 内** |
| `saveAndVerify(rpc, tabId, {verify})` | 点保存 + 三重验证 |
| `deleteEntry(rpc, tabId, {slug, editPath, ...})` | 删除条目（表单删除 + 确认框 + 回读） |
| `readSection(rpc, tabId, {slug, section})` | 读区块条目（靠 `/edit/forms/<id>` 锚点定位，兼容技能类 aria-label） |
| `readIntro(rpc, tabId, {slug})` | 读姓名 / Headline / 顶部信息 |

**返回值解包**：`lib/bridge.mjs` 的 `unwrap()` 已自适应三层差异（裸 HTTP → `json.result.result.value`；`client.mjs` → `r.result.value`；`bridge.evaluate()` → `{type,value}` 还要 `.value`）。**不要自己写解包。**

## 排错速查

| 现象 | 真正的原因 | 处理 |
| --- | --- | --- |
| `EVAL_ERROR` 提到 CSP | 用了 `page.evaluate` 做字符串求值 | 改用 `ev()` / `evJson()`（CDP） |
| `SESSION_SEND_FAILED`：Debugger is not attached | 扩展 CDP 兜底拆了你的会话（≤ v0.3.11） | 升级到 ≥ 0.3.12；或全程只用 `ev()` 不混用 `page.evaluate` |
| **英文档案读到中文内容** | 语言参数拼接出双问号（静默回退主档案） | 用 `withQuery()` 合并；别手拼 `?language=en` |
| 区块读出 0 条但页面「看起来正常」 | 后台标签页 SDUI 懒渲染没触发 | 先 `page.ensureActive`（`gotoForm` 已内置） |
| 字段找到了但写不进去 | 富文本 TipTap：赋 `innerText` 被忽略 | 写 `innerHTML` + `InputEvent`（`fillField` 已处理） |
| 填了值，保存后是空的 | 直接 `el.value = v`，React state 没同步 | 用原型 setter + `input`/`change` 事件 |
| 点了「删除」没反应 | 点错按钮（表单底部 vs 确认框） | 限定 dialog 作用域 + 用对点击语义 |
| `/edit/summary/` 显示「此页面不存在」 | 该路径本来就不存在 | 用 `/edit/forms/summary/new/?profileFormEntryPoint=GUIDANCE_CARD` |
| 英文 Headline 保存了但不生效 | Headline 不可本地化（平台限制） | 只能改主档案的 Headline |
| 保存后没变化 | 保存失败但脚本没察觉 | 用 `saveAndVerify` 的三重验证 + `verify` 回读 |

## 前置条件与边界

- 桥已就绪：`curl -s http://127.0.0.1:8778/status` 返回 `extConnected: true`。
- 用户已在浏览器登录 linkedin.com（**不要替用户登录**）。
- 扩展版本建议 ≥ **v0.3.12**（含 CDP 会话隔离修复与 SDUI 所需的 `page.ensureActive`，后者自 v0.3.10 起）。查版本：

```bash
curl -s http://127.0.0.1:8778/status | python3 -c 'import json,sys;print(json.load(sys.stdin).get("version"))'
```

- **公开档案是对外可见的**：改 Headline / About / 经历 / 项目都会立刻反映到公开主页。涉及删改前先 `linkedin-read.mjs` 确认现状，必要时先让用户确认。
- 本 skill **不包含任何个人数据**：所有示例用占位符（`<你的slug>`），档案 URL 由调用方传入。
