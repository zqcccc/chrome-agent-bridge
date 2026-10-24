---
name: agent-browser-captcha
description: agent-browser-bridge 的子技能——Cloudflare 挑战页（"Just a moment..."、"Checking your browser"、Turnstile 人机验证框、URL 含 /cdn-cgi/challenge-platform/ 或 __cf_chl_rt_tk）的识别与处置专项。当页面出现上述任一特征时读取本文件：先判定挑战类型，停止一切驱动，保证标签页在前台渲染，等待自动通过；超时后把页面交给用户完成人机验证，并按目标态复核是否真的通过。覆盖 marker 识别、自动等待与人工接管两条路径、可直接运行的 cf-wait.mjs、等价手写 RPC 代码、禁止动作清单、商业求解服务参考、Turnstile 测试 sitekey 与错误码速查。前置：根 SKILL.md 的桥已就绪（host 存活、扩展已连接）。
---

# Cloudflare 挑战页处置

> **路径约定**：本文的 `<skill 目录>` 指本文件所在目录，`<仓库根>` = `<skill 目录>/../../..`（本 skill 位于 `skills/agent-browser-bridge/captcha/`），主 CLI 为 `<仓库根>/agent/cli.mjs`。**这些位置是可推导的，不要用 `find ~` 之类全盘搜索去定位**；完整约定见根 `SKILL.md`「路径约定（读本 skill 任何命令前先看这里）」一节。

本文件只处理一件事：真实 Chrome 撞上 Cloudflare 挑战页时，Agent 应该做什么。默认路径是「停手、等它自己过、复核」，失败则把页面交给用户。任何「让 Agent 自己把挑战解掉」的做法都不在默认路径里。

## 与现有约束的关系

根 `KNOWN_ISSUES.md`「约束一：遇到风控/安全验证 → 立即停止」**继续有效**，且优先于本文：

- 小红书 `website-login/captcha` /「Security Verification」、BOSS 直聘 `_security_check`、滑块、短信/扫码二次验证等**站点自身的强风控**，一律立即停止该站点所有后续请求，等用户处理。本文不改变这条。
- 本文覆盖的是 **Cloudflare 挑战页**：`_cf_chl_opt`、`/cdn-cgi/challenge-platform/`、Turnstile widget 这一类。它们通常不需要账号层面的处置，等待或让用户点一下就能过。
- 两者都可能出现在同一站点上。判定顺序是：先看页面是不是 Cloudflare 挑战页；是，走本文流程；不是，按约束一立即停止。

本文的处置**不包含**刷新、点击挑战、切换标签页重试。挑战页在等待期间保持原样。

## 识别 Cloudflare 挑战

判定顺序：**先判断是不是挑战页，再看状态码**。挑战页的 HTTP 状态可能是 `200`，也可能是 `403`；只看状态码会把 200 的挑战页当成正常页面，随后读到的是挑战页的空壳 DOM。官方对挑战响应的判据是响应头 `cf-mitigated: challenge`（[detect-response](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)），200 与 403 两种形态的实测见 [Crawlbase 复盘](https://crawlbase.com/blog/solving-cloudflare-turnstile-a-technical-postmortem/)。

| marker | 怎么读 | 可信度 |
| --- | --- | --- |
| `window._cf_chl_opt` | `page.evaluate` 默认在 MAIN world 执行，可直接读页面变量；`cType` 实测取值 `managed` / `non-interactive` / `interactive`（旧站点可能是 `jsd`），`cTplC` 为 `1` 表示站点用了自定义模板 | 高 |
| `document.title` 含 `Just a moment...` 或以 `Checking your browser` 开头 | `document.title`，**先剥掉桥的接管前缀**（`page.*` 会把它改成 `● [Agent 接管中 | <原标题>`，见「脚本用法」） | 中：`cTplC: 1` 时站点可用 `::CF_WIDGET_BOX::` 自定义模板改写全部文案，文案不能单独作判据 |
| `<script src*="/cdn-cgi/challenge-platform/">` | DOM 查询 | 低：**JS Detections 的注入片段也是这个路径前缀，且 Bot Fight Mode 默认开启**，开了 JSD 的普通页面同样命中。单独出现不能判定为挑战页，必须结合 `_cf_chl_opt`、标题或 URL 中的挑战 marker |
| `iframe[src*="challenges.cloudflare.com"]`、`.cf-turnstile` 容器、隐藏字段 `cf-turnstile-response` | DOM 查询 | 高；页面内独立 widget 也会命中，需结合 URL 与 `_cf_chl_opt` 区分挑战页与站点自带 widget |
| URL 含 `/cdn-cgi/challenge-platform/` 或 `__cf_chl_rt_tk` | `location.href` | 高；`__cf_chl_rt_tk` 由挑战页脚本用 `history.replaceState` 附加 |
| 响应头 `cf-mitigated: challenge` | 仅页面内 `fetch` / XHR 可读（官方只文档化了这一种用法）；主文档响应头需要在扩展侧观察，本架构未把它做成可靠判据 | 高，适用范围有限 |
| `.cf-browser-verification`、`/cdn-cgi/l/chk_jschl` | DOM 查询 / URL | 中：老式 5 秒盾，现代站点少见 |

页面内一次取全（这段表达式与 `cf-wait.mjs` 完全一致）：

```js
const DETECT_EXPR = `(() => ({
  title: (document.title || "").replace(/^●\s*\[[^\]]+\]\s*接管中\s*\|\s*/, ""),
  url: location.href,
  hasCfOpt: !!window._cf_chl_opt,
  cType: window._cf_chl_opt?.cType ?? null,
  cTplC: window._cf_chl_opt?.cTplC ?? null,
  hasChlScript: !!document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]'),
  hasTurnstile: !!document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]'),
  hasLegacy: !!document.querySelector('.cf-browser-verification')
}))()`;
```

判定函数：

```js
function isChallenge(state) {
  if (!state) return false;
  // hasChlScript 单独不作判据：JS Detections 的普通页面也带该脚本，误判会白等 30 秒
  if (state.hasCfOpt || state.hasTurnstile || state.hasLegacy) return true;
  if (/Just a moment|Checking your browser/.test(String(state.title || ""))) return true;
  const url = String(state.url || "");
  return url.includes("/cdn-cgi/challenge-platform/") || url.includes("__cf_chl_rt_tk");
}
```

这个顺序的出处是 Crawlbase 的 2026-09 复盘：挑战页返回 200 是常见形态，把 200 直接当成功会拿到空正文。见文末来源。

`cType` 只用于给挑战分类，不参与「是不是挑战」的判定：较新模板或页面刚导航时 `_cf_chl_opt` 可能读不到，`cType` 为 `null`（nowsecure.nl 实测 `cType=未知` 但确实是挑战页），判定仍按 title / URL / DOM 其余 marker 进行。不要把「`cType` 为空」当成「没有挑战」。

## 挑战类型与行为

| 类型 | `cType` 取值 | 页面行为 | 预期耗时 |
| --- | --- | --- | --- |
| Non-Interactive | `non-interactive`（旧资料写作 `js_challenge` / `jsd`） | 纯 JS 计算，浏览器自己完成，不需要点击 | 官方称通常少于 5 秒 |
| Managed（官方推荐） | `managed` | 先跑一串非交互子挑战（proof-of-work、Web API 探测、行为检测），信号足够强直接放行，信号弱才给可视化或点击 | 多数访客自动通过 |
| Interactive | `interactive` | 必须人工交互才能通过 | 取决于用户 |
| Turnstile widget | 不在 `_cf_chl_opt` 里 | 页面内嵌的独立验证框，加载 → 交互（仅 Managed 模式）→ 成功 | 多数自动通过 |

通过后 `cf_clearance` 默认有效期 30 分钟（Challenge Passage 可配 15–45 分钟），且与访客、设备绑定。2026 年 7 月起全量铺开的 **Precursor** 是会话级持续验证：Armed 模式下即使 cookie 未过期，也可能重新挑战。

**因此每次导航后都要重新检测**，不要假设「刚刚通过了，后面就一直在」。同一标签页内连续访问同一站点时，检测成本只有一次 `page.evaluate`。

## 默认流程：等待自动通过

官方口径是 "Most visitors will pass Challenges automatically without interaction"。真实 Chrome、真实 profile、真实 IP 正是 Managed Challenge 设计服务的对象，所以第一顺位是等待它自动通过。

```
检测到挑战
  → 立即停止一切驱动（不刷新、不点击、不导航）
  → page.ensureActive（临时把该标签页设为活动以恢复渲染；不聚焦窗口，空闲后还原）
  → 每 1.5 秒轮询，自动等待上限 15–30 秒（可配）
  → 复核恢复判据
  → 恢复流程
```

四步的细节：

1. **停止驱动**。挑战脚本在页面里跑，任何导航、刷新、点击都会重置或干扰它。刷新会重新发起挑战，Precursor 的会话信号也会累积，等待时间只会变长。
2. **`page.ensureActive`**。这一步是功能前提：Chrome 对后台标签页**完全暂停** `requestAnimationFrame`，并进入 intensive throttling（每分钟只唤醒一次定时器）。挑战脚本依赖定时器与渲染帧做 proof-of-work 和行为采集，后台标签页会把它拖慢甚至停在半途。`page.ensureActive` 只切标签页、不聚焦窗口，空闲 `restoreAfterMs` 后自动把活动标签页还给用户。见 Chrome 官方 timer throttling 博客与 MDN `requestAnimationFrame`。
3. **轮询**。间隔 1.5 秒足够，更密只会增加 RPC 次数。每次轮询只读页面状态，不做任何写操作。
4. **复核恢复判据**。判定依据是**目标态**：挑战态消失只是必要条件，业务元素出现才说明页面真的到了。
   - URL 离开挑战页（不再含 `/cdn-cgi/challenge-platform/`、`__cf_chl_rt_tk`）；
   - 标题不再是等待文案；
   - 目标元素出现（列表、正文、登录表单等业务元素）；
   - `_cf_chl_opt` 消失、`/cdn-cgi/challenge-platform/` 脚本消失。

   只等「挑战 marker 消失」会误判：挑战页可能先移除 DOM 再跳转，中间有几百毫秒的空窗。业务元素出现才说明页面真的到了。

自动等待超时后的去向由调用参数决定：`cf-wait.mjs` 不带 `--human` 时截图、读 Ray ID，以退出码 2 结束，把决定权留给调用方；带 `--human` 时直接进入下一节的人工接管。

## 需要人工点击时（HITL）

进入条件：调用带 `--human`（`cType` 为 `interactive` 时应直接这样调；`cType` 读不到或为 `null` 时按 Managed 处理），或调用方收到退出码 2 后决定交人、按下述流程自己实现。

```
tabs.activate（把窗口带到前台，用户才看得见）
  → page.screenshot（留现场）
  → 明确提示「请完成页面上的人机验证」
  → 每 1.5 秒轮询，人工等待 60–120 秒（可配）
  → 复核恢复判据（同上）
  → 通过则恢复流程；超时则失败并保留现场
```

要点：

- **人工步骤用 `tabs.activate`**。它会把窗口一起拉到前台，用户才看得见；`page.ensureActive` 只切标签页、不聚焦窗口，用户可能根本不知道有验证框在等他。
- **截图留现场**：`page.screenshot` 默认走 CDP 静默截图，后台标签页也能截。已经把窗口拉到前台时，`page.activateAndShot` 一步完成激活与截图，效果相同。截图路径写进 stderr，方便用户核对。
- **提示语明确**：告诉用户「请完成页面上的人机验证」，不要只说「需要你处理一下」。
- **超时保留现场**：截图、`document.title`、`location.href`、页面里的 Ray ID（`_cf_chl_opt.cRay`，或页面文案里的 Ray ID 一行）。不要关标签页，不要刷新。
- **绝不刷新挑战页**：刷新会重新发起挑战，Precursor 的会话级信号会累积。这是 Browser Use、Steel、Cloudflare Browser Run 三个实现的共同约束。
- **官方立场**：自动化浏览器不支持解生产挑战。Cloudflare 自己的 Browser Run 对 "CAPTCHA that cannot be bypassed programmatically" 给出的方案就是 human-in-the-loop：把 Live View 交给真人，人点完成后事件回传，脚本恢复。见文末来源。

失败时向用户说明：页面停在哪个 URL、什么标题、截图在哪里、Ray ID 是多少。

## 脚本用法

`<skill 目录>/scripts/cf-wait.mjs`（即 `skills/agent-browser-bridge/captcha/scripts/cf-wait.mjs`），自包含，不依赖 CLI：

```bash
node <skill 目录>/scripts/cf-wait.mjs <tabId> [--auto-timeout 30] [--human-timeout 120] [--human] [--shot <png 路径>]
```

| 参数 | 含义 |
| --- | --- |
| `<tabId>` | 必填。目标标签页，用 `tabs.list` RPC 查（便利命令：`node <仓库根>/agent/cli.mjs tabs`） |
| `--auto-timeout N` | 自动等待秒数，默认 30 |
| `--human-timeout N` | 人工等待秒数，默认 120 |
| `--human` | 跳过自动等待，直接进入人工流程 |
| `--shot <路径>` | 截图保存位置（自动等待超时与人工流程都会用）；默认存到 `~/.chrome-agent-bridge/captcha-shots/cf-<tabId>-<时间戳>.png` |
| `--help` / `-h` | 打印用法，退出码 0 |

**前置：扩展 ≥ 0.3.10**（`page.ensureActive` 的版本门槛）。更旧的扩展在检测到挑战、开始等待时报 `UNKNOWN_METHOD`，脚本以退出码 1 结束——按根 SKILL.md「前置条件」升级扩展后重跑。无挑战页不调用该 RPC，不受版本影响。

退出码与输出：

| 退出码 | 含义 |
| --- | --- |
| `0` | 本来就没有挑战，或挑战已通过 |
| `1` | 桥/页面异常（RPC 失败、tab 不可用、用户叫停等） |
| `2` | 页面仍需用户处理：不带 `--human` 时自动等待超时（截图与 Ray ID 已写 stderr），或带 `--human` 时人工等待超时 |

stdout 输出单行 JSON，字段固定：

```json
{"tabId":123,"challenge":false,"cType":"managed","solved":true,"attempts":9,"waitedMs":12000,"title":"示例站点","url":"https://example.com/"}
```

- `challenge`：最近一次检测是否仍在挑战页。
- `solved`：是否已通过。
- `attempts`：检测次数。
- `waitedMs`：从开始到结束的毫秒数。

脚本行为：初始检测无挑战直接退出 0；有挑战时，**不带 `--human`** 先 `page.ensureActive` 恢复渲染再每 1.5 秒轮询，自动等待超时即截图、读 Ray ID 写进 stderr，以退出码 2 结束，不转人工、不挂起；**带 `--human` 跳过 `page.ensureActive`**（紧接着就 `tabs.activate`，再借前台只会留下一条把标签页切回原页的计时器），改为 `tabs.activate` + 截图 + stderr 打印「等待用户完成人机验证」，轮询到人工超时，再读一次 Ray ID 后以退出码 2 结束。全程不刷新、不点击、不导航。页面导航瞬间的 `PAGE_CONTEXT_TIMEOUT` / `NAV_TIMEOUT` 按「本轮未知」跳过，连续 5 次才判失败。

### 只有 skill 目录时：手写 RPC 等价流程

拿不到仓库根代码、也不想用脚本时，用下面这段完整代码。它只依赖 Node 内置模块与本地桥的 HTTP 接口，与 `cf-wait.mjs` 的判定逻辑一致。

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const token =
  process.env.BRIDGE_TOKEN ||
  fs.readFileSync(path.join(os.homedir(), ".chrome-agent-bridge", "token"), "utf8").trim();

async function rpc(method, params = {}, timeoutMs = 20000) {
  const res = await fetch("http://127.0.0.1:8778/rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Agent-Id": "captcha-wait",
    },
    body: JSON.stringify({ method, params, timeoutMs }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method} 失败：${JSON.stringify(json.error || json)}`);
  return json.result;
}

const DETECT_EXPR = `(() => ({
  // 剥掉桥的接管前缀（indicator.js 会给 document.title 加「● [Agent] 接管中 | 」），
  // 否则标题兜底判据永远不命中
  title: (document.title || "").replace(/^●\\s*\\[[^\\]]+\\]\\s*接管中\\s*\\|\\s*/, ""),
  url: location.href,
  hasCfOpt: !!window._cf_chl_opt,
  cType: window._cf_chl_opt?.cType ?? null,
  cTplC: window._cf_chl_opt?.cTplC ?? null,
  hasChlScript: !!document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]'),
  hasTurnstile: !!document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]'),
  hasLegacy: !!document.querySelector('.cf-browser-verification')
}))()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isChallenge(state) {
  if (!state) return false;
  // hasChlScript 单独不作判据：JS Detections 的普通页面也带该脚本
  if (state.hasCfOpt || state.hasTurnstile || state.hasLegacy) return true;
  if (/Just a moment|Checking your browser/.test(String(state.title || ""))) return true;
  const url = String(state.url || "");
  return url.includes("/cdn-cgi/challenge-platform/") || url.includes("__cf_chl_rt_tk");
}

async function detect(tabId) {
  // 裸 HTTP 返回 {ok:true, result:{result:值}}，rpc() 已剥掉外层，取 .result 即页面返回值
  const raw = await rpc("page.evaluate", { tabId, expression: DETECT_EXPR, awaitPromise: false });
  return raw && raw.result;
}

async function waitChallenge(tabId, { autoTimeoutMs = 30000, humanTimeoutMs = 120000, human = false } = {}) {
  let state = await detect(tabId);
  if (!isChallenge(state)) return { solved: true, challenge: false, state };

  // 后台标签页会暂停 rAF、节流定时器，挑战脚本可能停在半途。
  // 只在自动等待路径借前台：human 路径紧接着就 tabs.activate，借了只会留下切回原页的计时器。
  if (!human) await rpc("page.ensureActive", { tabId, restoreAfterMs: 60000 });

  if (!human) {
    const autoDeadline = Date.now() + autoTimeoutMs;
    while (Date.now() < autoDeadline) {
      await sleep(1500);
      state = await detect(tabId);
      if (!isChallenge(state)) return { solved: true, challenge: false, state };
    }
    // 自动等待超时：不擅自转人工，把决定权留给调用方（对应 cf-wait.mjs 不带 --human 时的退出码 2）
    return { solved: false, challenge: true, state };
  }

  // 人工接管（human: true）：把窗口交给用户
  await rpc("tabs.activate", { tabId });
  await sleep(400);
  const shot = await rpc("page.screenshot", { tabId, format: "png" });
  console.error("请完成页面上的人机验证。现场截图：", shot && shot.image ? shot.image.slice(0, 40) + "…" : "无");

  const humanDeadline = Date.now() + humanTimeoutMs;
  while (Date.now() < humanDeadline) {
    await sleep(1500);
    state = await detect(tabId);
    if (!isChallenge(state)) return { solved: true, challenge: false, state };
  }
  return { solved: false, challenge: true, state };
}

const tabId = Number(process.argv[2]);
console.log(JSON.stringify(await waitChallenge(tabId)));
```

复核时不要只信 `solved`。返回后重新读一次业务目标元素（列表条数、正文长度、登录状态），确认页面真的到了目标态。

## 禁止清单

以下每条都在真实环境里被验证过风险，不要做。

- **改 UA / Canvas / WebGL 做「反检测」**：官方 Limitations 明确写「Cloudflare Challenges 不支持修改 `User-Agent` 或 `Canvas`、`WebGL` 等 Web API 的浏览器扩展」。来源：How Challenges work 的 Limitations 一节。
- **常规操作接 CDP（`chrome.debugger`）**：会引入 `Runtime.enable` 一类可检测面。本 skill 的等待与人工接管路径只走 `page.evaluate` / `page.screenshot` / `tabs.activate` / `page.ensureActive`，不为解挑战额外挂调试器（桥自身的 CDP 通道是另一回事：严格 CSP 站点的求值、后台截图、解冻都靠它）。官方点名 Selenium / Puppeteer / Playwright / Cypress 不支持解生产挑战。来源：Supported browsers 页。
- **程序化合成点击 Turnstile checkbox 当通用方案**：合成事件的 `isTrusted` 为 `false`，风险不可控；官方立场是自动化浏览器不参与生产挑战求解。来源：Supported browsers 页；社区案例见 pinchtab #394（该案例依赖其自带的拟人鼠标与特定站点，不能外推）。
- **用 `cf_clearance` 求解服务（如 CapSolver `AntiCloudflareTask`）**：该类任务强制要求提供 proxy，返回的 cookie 绑定求解方 IP 与 UA，与用户本机真实 IP 冲突；官方明确「求解请求来自与挑战请求不同的 IP 时，求解无效，并可能进入 challenge loop」。来源：How Challenges work 的 Limitations 一节、CapSolver Cloudflare Challenge 文档。
- **换 Camoufox / Patchright / playwright-stealth**：它们解决的是「没有真实浏览器」的问题，本架构已有真实 profile、登录态与指纹；换过去等于放弃这些，还要重新打指纹战争。来源：Supported browsers 页（自动化框架不受支持）、各项目 README。

## 商业求解服务参考

> 适用范围：**仅当用户明确授权**，且**只用于页面内独立 Turnstile widget**。挑战页（Challenge Page）不要用这类服务，原因见上一节第四条。

| 服务 | 任务类型 | 价格（USD / 1000 次） | 支持 challenge page |
| --- | --- | --- | --- |
| 2Captcha | `TurnstileTaskProxyless` | $1.45 | 是，但要求使用其返回的 User-Agent，与「不能改 UA」冲突 |
| Anti-Captcha | `TurnstileTaskProxyless` | $2.00 | 是，可传 `cData` / `chlPageData` |
| CapSolver | `AntiTurnstileTaskProxyLess` | $1.20 | 否，只返回 widget token |

价格取自 2026-10-19 各服务官方 pricing 页。

集成原理（以独立 widget 为例）：

1. 在 Turnstile 脚本加载前覆写 `window.turnstile.render`，保存入参里的 `sitekey`、`cData`、`action` 与 `callback`。
2. 把这几项提交给求解服务，轮询拿回 token。
3. 调用保存下来的原 `callback(token)`，让页面自己完成后续校验。

2Captcha 与 Anti-Captcha 的官方文档都给了这套流程的完整示例。失败时转人工接管，不要循环重试。

**ToS 风险**：Cloudflare 的服务协议禁止规避服务限制；目标站点的服务条款由用户判断。默认不启用商业求解，不代用户保管第三方 key。

## Turnstile 官方测试 sitekey

做测试时用官方测试 key，不会触发真实挑战：

| sitekey | 行为 | 类型 |
| --- | --- | --- |
| `1x00000000000000000000AA` | 总是通过 | Visible |
| `2x00000000000000000000AB` | 总是失败 | Visible |
| `1x00000000000000000000BB` | 总是通过 | Invisible |
| `2x00000000000000000000BB` | 总是失败 | Invisible |
| `3x00000000000000000000FF` | 强制交互 | Visible |

官方原文："Use dummy sitekeys and secret keys to test your Turnstile implementation without triggering real challenges that would interfere with automated testing suites." 测试 key 在 `localhost`、`127.0.0.1` 与任意域名都可用，生成的是 dummy token（`XXXX.DUMMY.TOKEN.XXXX`），生产 secret 会拒绝它。

## 错误码速查

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `NAV_TIMEOUT` | 导航 / 等待 URL / 等待 ready 超时 | 挑战页跳转期间常见。读一次当前 URL 与标题，仍在挑战页就继续等，不要重发导航 |
| `PAGE_CONTEXT_TIMEOUT` | 页面上下文失效（导航中、渲染器被冻结、坏标签页） | 挑战页跳转时常见。v0.3.10+ 会先尝试解冻；连续出现就 `tabs.prepare` 重新注入，或换标签页 |
| `TAB_UNHEALTHY` | 同一标签页连续 3 次上下文级失败，本库已熔断（只由 `bridge.mjs` 的 `ev()` 抛出；本脚本走 `rpc.call("page.evaluate")`，不会收到它） | 换标签页重来（`tabs.resolve`），不要原地重试 |
| `AGENT_STOPPED` | 用户在页面上按了「停止 Agent」 | 脚本立即以退出码 1 结束。等待轮询是只读的，停止闸门拦不住它：想让轮询真正停下，需要外部 kill 本进程 |
| `TIMEOUT` / `TAB_BUSY` | 桥通道层超时 / 标签页被其他 Agent 占用 | 脚本按「本轮未知」跳过，连续 5 次才判失败；反复出现时先查 `/status` 与 `tabs.list`，不要当导航瞬态忽略 |
| `UNKNOWN_METHOD` | 扩展版本不够新：`page.ensureActive` 的门槛是 v0.3.10+ | 脚本在检测到挑战、开始等待时报它；按根 SKILL.md「前置条件」查版本并升级扩展后重跑 |

## 来源

Cloudflare 官方：

- How Challenges work（Limitations、IP 与 UA 约束）：https://developers.cloudflare.com/cloudflare-challenges/concepts/how-challenges-work/
- Challenge pages（三类挑战的行为）：https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/
- Challenge pages 附加配置（`::CF_WIDGET_BOX::`、`cTplC`、`cf.response.error_type`）：https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/additional-configuration/
- 检测挑战响应头 `cf-mitigated: challenge`：https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/
- Supported browsers（自动化浏览器与框架不受支持）：https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/
- Clearance（分级、默认 30 分钟）：https://developers.cloudflare.com/cloudflare-challenges/concepts/clearance/
- Precursor（会话级持续验证）：https://developers.cloudflare.com/cloudflare-challenges/precursor/
- Cloudflare cookies（`cf_clearance` 属性）：https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/
- Turnstile widget 概念：https://developers.cloudflare.com/turnstile/concepts/widget/
- Turnstile 客户端渲染：https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
- Turnstile 测试 key：https://developers.cloudflare.com/turnstile/troubleshooting/testing/
- Browser Run human-in-the-loop：https://developers.cloudflare.com/browser-run/features/human-in-the-loop/
- Under Attack Mode（5 秒判定的官方说明）：https://developers.cloudflare.com/fundamentals/reference/under-attack-mode/

浏览器侧：

- Chrome timer throttling：https://developer.chrome.com/blog/timer-throttling-in-chrome-88
- MDN `requestAnimationFrame`（后台标签页暂停）：https://developer.mozilla.org/en-US/docs/Web/API/window/requestAnimationFrame

社区与第三方：

- Crawlbase 的 Turnstile 复盘（200/403 双形态、marker 清单）：https://crawlbase.com/blog/solving-cloudflare-turnstile-a-technical-postmortem/
- pinchtab #394（checkbox 点击案例）：https://github.com/pinchtab/pinchtab/issues/394
- Browser Use 的 CAPTCHA 处置约定：https://docs.browser-use.com/cloud/browser/captcha-handling
- Steel 的状态机轮询示例：https://raw.githubusercontent.com/steel-dev/docs/main/content/docs/cookbook/browser-use-captcha-manual.mdx

求解服务：

- 2Captcha pricing：https://2captcha.com/pricing
- 2Captcha Cloudflare Turnstile 文档：https://2captcha.com/api-docs/cloudflare-turnstile
- Anti-Captcha 价格：https://anti-captcha.com/apidoc/prices
- Anti-Captcha Turnstile 任务：https://anti-captcha.com/apidoc/task-types/TurnstileTaskProxyless
- CapSolver pricing：https://docs.capsolver.com/en/pricing/
- CapSolver Turnstile 指南：https://docs.capsolver.com/en/guide/captcha/cloudflare_turnstile/
- CapSolver Cloudflare Challenge 指南：https://docs.capsolver.com/en/guide/captcha/cloudflare_challenge/
