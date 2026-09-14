#!/usr/bin/env node
// 小红书「软风控」弹窗一键处理 —— 区分软/硬风控，软的一键关掉继续，硬的不动
//
// 背景（2026-09-14 实测）：
//   小红书在被频繁操作/快速滚动/反复请求时会弹出 `.reds-alert` 软风控弹窗，
//   内含「我知道了」按钮，**点一下就能继续**——不是 `website-login/captcha` 那种硬风控。
//   之前的脚本（包括本目录其他 xhs-*.mjs）一律把任何"看起来像风控"的状态当成终止信号，
//   导致实际上点一下就能过的情况被误判为阻断。本脚本专门补这个洞。
//
// 策略：
//   - 枚举 `.reds-alert`、`.van-toast` / `.van-dialog` / `.van-popup` / `.reds-toast` 等容器；
//   - 按 `wrapper.display !== "none" && mask.display !== "none" && rect 非空` 判定"实际可见"；
//   - 取 `.reds-alert-title` / `.reds-alert-content` 文本，按关键词分流：
//       * 软风控（操作太频繁 / 稍后再试 / 网络异常点此重试 / 系统繁忙 / 内容加载失败 / 广告插件提示 / 温馨提示 …）
//         → 自动按优先级点「我知道了」/「确定」/「继续」/「重试」/「关闭×」/ 遮罩空白，关闭后继续
//       * 硬风控（账号异常 / 封禁 / 实名认证 / 申诉 / Security Verification / website-login/captcha / 滑块 …）
//         → 不点，回报 { kind: "hard", ... }，让上层脚本停下来等用户
//   - 一轮巡检；`--loop` + `--interval-ms` 进入持续巡检（连续 N 轮都干净才退出）
//
// 用法:
//   BRIDGE_TOKEN=xxx node xhs-dismiss-softblock.mjs <tabId>                     # 单轮巡检
//   BRIDGE_TOKEN=xxx node xhs-dismiss-softblock.mjs <tabId> --loop             # 持续巡检
//   BRIDGE_TOKEN=xxx node xhs-dismiss-softblock.mjs <tabId> --loop --interval-ms 4000 --stable-rounds 3
//   BRIDGE_TOKEN=xxx node xhs-dismiss-softblock.mjs <tabId> --dry-run          # 只看、不点
//   BRIDGE_TOKEN=xxx node xhs-dismiss-softblock.mjs <tabId> --format json
//
// 退出码：0=无弹窗 / 软风控已全部关掉 / 用户指定的 --loop 稳定退出
//        2=发现硬风控（脚本必须停），3=巡检异常
//
// 踩坑记录（已实测 2026-09-14）：
//   - `.reds-alert` 容器平时就常驻 DOM，只是 wrapper `display:none`；
//     判"可见"必须看 `wrapper.display !== "none" && mask.display !== "none"`，
//     不能用 `rect.width > 0` —— 容器 rect 即使 1272x0 也常驻
//   - 同名类可能挂多个模板（如广告插件提示），按可见性筛掉隐藏的
//   - 「我知道了」按钮文本里可能夹全角空格；按 `trim()` 后严格等值
//   - 软风控弹窗按钮被点过后可能再弹新的（一题接一题），所以 `--loop` 模式要按 stable-rounds 连续干净才退出

const token = process.env.BRIDGE_TOKEN;

const [, , tabIdArg, ...rest] = process.argv;
let loop = false;
let intervalMs = 3500;
let stableRounds = 2;
let dryRun = false;
let format = "text";
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--loop") loop = true;
  else if (rest[i] === "--interval-ms") intervalMs = parseInt(rest[++i], 10) || intervalMs;
  else if (rest[i] === "--stable-rounds") stableRounds = parseInt(rest[++i], 10) || stableRounds;
  else if (rest[i] === "--dry-run") dryRun = true;
  else if (rest[i] === "--format") format = rest[++i] || "text";
}
const tabId = Number(tabIdArg);
if (!token || !tabId) {
  console.error('usage: BRIDGE_TOKEN=xxx node xhs-dismiss-softblock.mjs <tabId> [--loop] [--interval-ms N] [--stable-rounds N] [--dry-run] [--format text|json]');
  process.exit(1);
}

const rpc = async (method, params = {}, timeoutMs = 15000) => {
  const res = await fetch("http://127.0.0.1:8778/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, params, timeoutMs }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method} failed: ${JSON.stringify(json.error || json)}`);
  return json.result;
};
const safeParse = (s) => { try { return JSON.parse(s); } catch { return s; } };
const evaluate = async (expression, timeoutMs = 20000) => {
  const r = await rpc("page.evaluate", { tabId, expression, awaitPromise: false }, timeoutMs);
  const val = r && r.result;
  return typeof val === "string" ? safeParse(val) : val;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 把 ".reds-alert", ".van-dialog" 等容器结构化成统一列表
// 返回 [{ kind, title, content, btns:[{text,priority}], visible, root, dismissExpr }]
const SCAN_EXPR = `(() => {
  // 收集所有 .reds-alert 实例（包括隐藏的）和可见的 van-* 弹窗
  const redsAlerts = Array.from(document.querySelectorAll('.reds-alert'));
  const vanDialogs = Array.from(document.querySelectorAll('.van-dialog, .van-popup, .reds-toast, .toast-container > *'));
  const noteMasks = Array.from(document.querySelectorAll('.note-detail-mask'));

  const visCheck = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 5 || r.height <= 5) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0.01;
  };

  const fromReds = redsAlerts.map((e, i) => {
    const wrapper = e.querySelector('.reds-alert-wrapper');
    const mask = e.querySelector('.reds-alert-mask');
    // 行内 style 优先（实际生效的）—— getComputedStyle 在某些位置上下文里会继承祖先的 display
    const inlineDisp = (el, prop) => {
      if (!el) return null;
      const s = el.getAttribute('style') || '';
      const m = s.match(new RegExp(prop + '\\\\s*:\\\\s*([^;]+)', 'i'));
      return m ? m[1].trim() : null;
    };
    const wrapperDisp = inlineDisp(wrapper, 'display') || (wrapper ? getComputedStyle(wrapper).display : 'none');
    const maskDisp = inlineDisp(mask, 'display') || (mask ? getComputedStyle(mask).display : 'none');
    // 行内 display 为 'none' 才算隐藏；其他值（含空字符串/null）一律视为可见
    const wrapperHidden = wrapperDisp === 'none';
    const maskHidden = maskDisp === 'none';
    const title = e.querySelector('.reds-alert-title')?.innerText?.trim() || '';
    const content = e.querySelector('.reds-alert-content')?.innerText?.trim() || '';
    // 内容是空模板时跳过（小红书 DOM 里常驻的占位 alert）
    if (!title && !content) return null;
    const btns = Array.from(e.querySelectorAll('button')).map((b) => {
      const t = (b.innerText || '').replace(/\\s+/g, ' ').trim();
      let priority = 0;
      if (/^(我知道了|知道了)$/.test(t)) priority = 100;
      else if (/^(确定|确认|继续|重试|刷新|好的)$/.test(t)) priority = 80;
      else if (/^(取消|关闭|稍后)$/.test(t)) priority = 60;
      else if (/^(申诉|我要申诉|反馈|我要反馈)$/.test(t)) priority = 40;
      return { text: t, priority };
    }).filter((b) => b.text);
    return { source: 'reds-alert', idx: i, title, content, btns, visible: !wrapperHidden && !maskHidden,
             wrapperDisp, maskDisp,
             rootClass: 'reds-alert', rootIdx: i };
  });

  const fromVan = vanDialogs.filter(visCheck).map((e, i) => {
    const title = e.querySelector('.van-dialog__title, .title, h3')?.innerText?.trim() || '';
    const content = e.querySelector('.van-dialog__content, .content, .text')?.innerText?.trim() || (e.innerText || '').trim();
    const btns = Array.from(e.querySelectorAll('button, .van-button, .van-dialog__confirm, .van-dialog__cancel')).map((b) => {
      const t = (b.innerText || '').replace(/\\s+/g, ' ').trim();
      let priority = 0;
      if (/^(我知道了|知道了)$/.test(t)) priority = 100;
      else if (/^(确定|确认|继续|重试|刷新|好的|好)$/.test(t)) priority = 80;
      else if (/^(取消|关闭|稍后)$/.test(t)) priority = 60;
      else if (/^(申诉|我要申诉|反馈)$/.test(t)) priority = 40;
      return { text: t, priority };
    }).filter((b) => b.text);
    return { source: 'van', idx: i, title, content, btns, visible: true,
             rootClass: Array.from(e.classList).join(' '), rootIdx: i };
  });

  return { reds: fromReds.filter(Boolean), van: fromVan, noteMaskVisible: noteMasks.some(visCheck) };
})()`;

// 文案分类：软风控 / 硬风控 / 未知
// 实测命中（2026-09-14）：
//   软: "操作太频繁" "操作频繁" "稍后再试" "请稍后" "网络异常" "网络不给力" "加载失败" "点此重试"
//       "系统繁忙" "请求失败" "服务异常" "广告屏蔽" "广告拦截" "温馨提示" "内容加载失败"
//   硬: "账号异常" "账号被封" "已被封禁" "实名认证" "申诉" "Security Verification" "滑块"
//       "登录异常" "cookie 失效" "登录已失效" "人机验证"
const SOFT_PATTERNS = [
  /操作\s*(过于|太|过)?\s*频繁/,
  /操\s*作\s*频\s*繁/,
  /稍后\s*(再)?\s*试/,
  /请\s*稍\s*后/,
  /稍\s*等\s*片\s*刻/,
  /网\s*络\s*(异常|不给力|出错|错误|超时)/,
  /(内容|页面)?\s*加\s*载\s*失\s*败/,
  /点\s*此\s*重\s*试/,
  /系\s*统\s*繁\s*忙/,
  /请\s*求\s*失\s*败/,
  /服\s*务\s*异\s*常/,
  /广\s*告\s*(屏\s*蔽|拦\s*截|过\s*滤\s*插\s*件)/,
  /温\s*馨\s*提\s*示/,
  /请\s*移\s*除\s*插\s*件/,
  /请\s*将.*\s*加\s*入\s*白\s*名\s*单/,
  /浏\s*览\s*器\s*版\s*本\s*过\s*低/,
  /内\s*容\s*正\s*在\s*审\s*核/,
  /页\s*面\s*没\s*有\s*响\s*应/,
  /(刷新|重\s*新\s*尝\s*试)\s*(页\s*面|后)/,
];
const HARD_PATTERNS = [
  /账\s*号\s*异\s*常/,
  /账\s*号\s*被\s*封/,
  /已\s*被\s*封\s*禁/,
  /违\s*规/,
  /实\s*名\s*认\s*证/,
  /申\s*诉/,
  /Securit\s*y\s*Verif\s*ication/i,
  /人\s*机\s*验\s*证/,
  /滑\s*块\s*(验\s*证|校\s*验)/,
  /登\s*录\s*(异\s*常|失\s*效|已\s*过\s*期)/,
  /cookie\s*失\s*效/i,
  /网\s*站\s*登\s*录/,
  /网\s*页\s*不\s*存\s*在/,
  /页\s*面\s*不\s*见\s*了/,
  /Sorry/i,
];

const classify = (text) => {
  const t = (text || "").trim();
  if (!t) return null;
  for (const re of HARD_PATTERNS) if (re.test(t)) return "hard";
  for (const re of SOFT_PATTERNS) if (re.test(t)) return "soft";
  return "unknown";
};

// 点哪一个按钮：按 priority 选最大；没有则返回 null（fallback 到 mask-click / Escape）
const pickDismiss = (alert) => {
  if (!alert.btns || !alert.btns.length) return null;
  const sorted = [...alert.btns].sort((a, b) => b.priority - a.priority);
  return sorted[0];
};

// 单轮巡检 → 报告
async function inspect() {
  const expr = SCAN_EXPR;
  const snap = await evaluate(expr, 20000);
  const all = [...(snap.reds || []), ...(snap.van || [])];
  const visible = all.filter((a) => a.visible);
  // 软风控 → 自动关
  const dismissable = [];
  const hard = [];
  const unknown = [];
  for (const a of visible) {
    const kind = classify((a.title || "") + "\n" + (a.content || ""));
    if (kind === "soft") dismissable.push(a);
    else if (kind === "hard") hard.push(a);
    else unknown.push(a);
  }
  return { all, visible, dismissable, hard, unknown, noteMaskVisible: !!snap.noteMaskVisible };
}

// 实际操作：按 rootClass/rootIdx 在页面上找到那个节点，按策略关
async function dismiss(alert) {
  // 找按钮（按文本严格匹配最高 priority 的）
  const pick = pickDismiss(alert);
  const expr = `(() => {
    const sel = alert => {
      const nodes = document.querySelectorAll('.' + alert.rootClass.split(' ')[0]);
      return nodes[alert.rootIdx] || null;
    };
    const root = sel(${JSON.stringify(alert)});
    if (!root) return { ok: false, reason: 'root-gone' };
    const wrapper = root.querySelector('.reds-alert-wrapper');
    if (wrapper && getComputedStyle(wrapper).display !== 'none') {
      // 是 .reds-alert 路径：按按钮
      const want = ${JSON.stringify(pick ? pick.text : "")};
      const btns = Array.from(root.querySelectorAll('button'));
      let target = null;
      if (want) target = btns.find(b => (b.innerText||'').replace(/\\s+/g,' ').trim() === want);
      if (!target && btns.length) {
        // 退而求其次：第一个 button
        target = btns[0];
      }
      if (target) { target.click(); return { ok: true, via: 'btn:' + (target.innerText||'').trim().slice(0,10) }; }
      // 找不到按钮：点 wrapper 内非按钮区（兜底）—— 直接把 wrapper display 设为 none
      wrapper.style.display = 'none';
      const mask = root.querySelector('.reds-alert-mask'); if (mask) mask.style.display = 'none';
      return { ok: true, via: 'force-hide' };
    }
    // van-* 路径
    const closeBtn = root.querySelector('.van-dialog__close, .van-popup__close-icon, [class*=close]');
    if (closeBtn) { closeBtn.click(); return { ok: true, via: 'close-x' }; }
    // 兜底：点遮罩或根节点
    const r = root.getBoundingClientRect();
    if (r.width > 5) {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4, view: window });
      root.dispatchEvent(ev);
      return { ok: true, via: 'mask-click' };
    }
    return { ok: false, reason: 'no-button' };
  })()`;
  return await evaluate(expr, 15000);
}

function report(insp, dismissed) {
  const out = {
    noteMaskVisible: insp.noteMaskVisible,
    visibleCount: insp.visible.length,
    softDismissed: dismissed.filter(d => d.ok).length,
    softFailed: dismissed.filter(d => !d.ok).length,
    hard: insp.hard.map(a => ({ title: a.title, content: a.content, btns: a.btns.map(b=>b.text) })),
    unknown: insp.unknown.map(a => ({ title: a.title, content: a.content, btns: a.btns.map(b=>b.text) })),
    dismissed: dismissed,
  };
  return out;
}

(async () => {
  // 1. 准备工作：尝试 prepare；如遇 PAGE_CONTEXT_TIMEOUT，等待 1.5s 让 context 失效标记过期再试
  const prepareOnce = async () => {
    try { return await rpc("tabs.prepare", { tabId }, 15000); }
    catch (e) {
      const msg = String(e && e.message || e);
      if (/PAGE_CONTEXT_TIMEOUT/.test(msg)) {
        await sleep(1500);
        return await rpc("tabs.prepare", { tabId }, 15000);
      }
      throw e;
    }
  };
  try { await prepareOnce(); } catch {}
  if (!loop) {
    const insp = await inspect();
    let dismissed = [];
    if (!dryRun) {
      for (const a of insp.dismissable) {
        try { dismissed.push(await dismiss(a)); } catch (e) { dismissed.push({ ok: false, error: String(e) }); }
      }
    }
    const out = report(insp, dismissed);
    if (format === "json") {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`ℹ️ 可见弹窗: ${out.visibleCount} | 软风控已处理: ${out.softDismissed}${out.softFailed?` (失败 ${out.softFailed})`:""} | 硬风控: ${out.hard.length} | 未知: ${out.unknown.length}${out.noteMaskVisible?' | 笔记弹窗在屏':''}`);
      if (out.hard.length) {
        console.log("⛔ 检测到硬风控（不动）:");
        for (const h of out.hard) console.log(`   - ${h.title || '(无标题)'} | ${(h.content || '').slice(0, 80)}`);
      }
      if (out.unknown.length) {
        console.log("⚠️ 未知弹窗（未自动关，避免误操作）:");
        for (const u of out.unknown) console.log(`   - ${u.title || '(无标题)'} | ${(u.content || '').slice(0, 80)} | 按钮: ${u.btns.join('/')}`);
      }
    }
    // 退出码：硬风控=2，未知弹窗=1，正常=0
    if (out.hard.length) process.exit(2);
    if (out.unknown.length) process.exit(1);
    process.exit(0);
  }

  // --loop 模式
  let stable = 0;
  let lastDismissed = 0;
  while (true) {
    const insp = await inspect();
    let dismissed = [];
    if (!dryRun && insp.dismissable.length) {
      for (const a of insp.dismissable) {
        try { dismissed.push(await dismiss(a)); } catch (e) { dismissed.push({ ok: false, error: String(e) }); }
      }
    }
    const okN = dismissed.filter(d => d.ok).length;
    if (insp.visible.length === 0) {
      stable++;
      if (format === "text") console.log(`[${new Date().toISOString()}] ✓ 干净 (连续 ${stable}/${stableRounds})`);
    } else {
      stable = 0;
      if (format === "text") {
        console.log(`[${new Date().toISOString()}] ⚙️ 处理 ${okN}/${insp.dismissable.length} 个软风控 | 硬=${insp.hard.length} 未知=${insp.unknown.length}`);
        for (const a of insp.dismissable) console.log(`   - 关: ${a.title || '(无标题)'} | ${(a.content||'').slice(0, 60)}`);
        for (const a of insp.hard) console.log(`   ⛔ 硬风控未关: ${a.title || '(无标题)'} | ${(a.content||'').slice(0, 60)}`);
      }
    }
    lastDismissed = okN;
    if (insp.hard.length) {
      // 硬风控出现 → 退出循环，让上层决定
      if (format === "json") console.log(JSON.stringify({ stopped: "hard", snapshot: report(insp, dismissed) }, null, 2));
      process.exit(2);
    }
    if (stable >= stableRounds) {
      if (format === "json") console.log(JSON.stringify({ stable: true, rounds: stable, lastDismissed }, null, 2));
      process.exit(0);
    }
    await sleep(intervalMs);
  }
})().catch((e) => {
  console.error("❌ 巡检异常:", e.message || e);
  process.exit(3);
});
