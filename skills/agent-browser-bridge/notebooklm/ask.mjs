#!/usr/bin/env node
/**
 * NotebookLM —— 向笔记本提问并取回回答
 *
 * 前置: 目标 tab 已在某个笔记本页面(URL 含 /notebook/<id>)
 *
 * 用法:
 *   node ask.mjs <tabId> "<问题>" [--timeout 120000]
 *
 * 环境: BRIDGE_TOKEN
 */
const token = process.env.BRIDGE_TOKEN;
const [, , tabIdArg, question, ...rest] = process.argv;
if (!token || !tabIdArg || !question) {
  console.error("用法: BRIDGE_TOKEN=xxx node ask.mjs <tabId> \"<问题>\" [--timeout 120000]");
  process.exit(1);
}
let timeoutMs = 120000;
for (let i = 0; i < rest.length; i++) if (rest[i] === "--timeout") timeoutMs = parseInt(rest[i + 1], 10) || timeoutMs;

const tabId = Number(tabIdArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error("[nblm-ask]", ...a);

async function rpc(method, params = {}, t = 30000) {
  const res = await fetch("http://127.0.0.1:8778/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, params, timeoutMs: t }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method} failed: ${JSON.stringify(json.error || json).slice(0, 200)}`);
  return json.result;
}

async function ev(expression, awaitPromise = false, t = 60000) {
  const r = await rpc("session.send", {
    tabId,
    method: "Runtime.evaluate",
    params: { expression, returnByValue: true, awaitPromise, userGesture: true },
  }, t);
  const { result, exceptionDetails } = r.result || {};
  if (exceptionDetails) {
    const ex = exceptionDetails.exception || {};
    throw new Error(ex.description || ex.value || JSON.stringify(exceptionDetails));
  }
  return result?.value;
}

/**
 * 取最后一条 AI 回答。
 * 实测: 回答在 .to-user-container (内含 .message-text-content)。
 * 千万别用「抓页面最长文本」的兜底 —— 会抓到 Studio 侧边栏(概览/演示/思维导图…)。
 */
const LAST_ANSWER_JS = `(() => {
  const cands = [...document.querySelectorAll('.to-user-container .message-text-content')];
  if (!cands.length) {
    // 退而求其次
    const alt = [...document.querySelectorAll('.to-user-container')];
    if (alt.length) {
      const t = (alt[alt.length - 1].innerText || '').trim();
      return JSON.stringify({ via: 'to-user', len: t.length, text: t });
    }
    return JSON.stringify({ via: 'none', len: 0, text: '' });
  }
  const last = cands[cands.length - 1];
  let t = (last.innerText || '').trim();
  // 去掉开头的 Thoughts / expand_more 等折叠思维链噪音
  t = t.replace(/^Thoughts\\s*expand_more\\s*/i, '').trim();
  return JSON.stringify({ via: 'message-text-content', len: t.length, text: t });
})()`;

/** 输入问题并发送 */
const ASK_JS = (q) => `(() => {
  const box = [...document.querySelectorAll('textarea')].find(t => /提问或创作内容/.test(t.placeholder || ''));
  if (!box) return 'no-input';
  box.focus();
  // Angular 受控组件: 必须用原生 setter + input 事件, 直接改 .value 不触发
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(box, ${JSON.stringify(q)});
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.dispatchEvent(new Event('change', { bubbles: true }));
  return 'typed';
})()`;

const SEND_JS = `(() => {
  const btns = [...document.querySelectorAll('button')];
  const send = btns.find(b => (b.getAttribute('aria-label')||'').match(/send|发送/i) || /arrow_forward/.test(b.innerText||''));
  if (send && !send.disabled) { send.click(); return 'clicked'; }
  return 'send-not-found-or-disabled';
})()`;

async function main() {
  await rpc("session.attach", { tabId }, 15000);
  try {
    const url = await ev("location.href");
    if (!/\/notebook\//.test(url)) {
      console.error("当前页不是笔记本页:", url);
      process.exit(1);
    }
    log("笔记本:", url);

    const typed = await ev(ASK_JS(question));
    if (typed !== "typed") throw new Error("找不到提问框: " + typed);
    await sleep(800);

    const sent = await ev(SEND_JS);
    log("发送:", sent);
    if (sent !== "clicked") {
      // 退路: 回车发送
      await ev(`(() => {
        const box = [...document.querySelectorAll('textarea')].find(t => /提问或创作内容/.test(t.placeholder || ''));
        if (!box) return 'nf';
        box.focus();
        box.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true}));
        return 'pressed-enter';
      })()`);
      log("改用回车发送");
    }

    // 等回答稳定: 连续两次抓取长度不变即认为完成
    const deadline = Date.now() + timeoutMs;
    let prev = "", stable = 0, answer = "";
    while (Date.now() < deadline) {
      await sleep(4000);
      const raw = await ev(LAST_ANSWER_JS).catch(() => '{"via":"err","len":0,"text":""}');
      let j = { via: "err", len: 0, text: "" };
      try { j = JSON.parse(raw); } catch {}
      answer = j.text || "";
      if (answer.length > 20 && answer === prev) {
        stable++;
        if (stable >= 2) break;
      } else {
        stable = 0;
      }
      prev = answer;
      log(`等待回答... 当前 ${answer.length} 字 (${j.via})`);
    }

    // 顺便抓引用来源
    const cites = await ev(`(() => {
      return JSON.stringify([...document.querySelectorAll('[data-source-id],.citation,.source-chip')]
        .map(e => (e.innerText||'').trim()).filter(Boolean).slice(0, 10));
    })()`).catch(() => "[]");

    console.log(JSON.stringify({
      ok: answer.length > 20,
      notebookUrl: url,
      question,
      answer,
      citations: (() => { try { return JSON.parse(cites); } catch { return []; } })(),
    }, null, 2));
  } finally {
    await rpc("session.detach", { tabId }, 10000).catch(() => {});
  }
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
