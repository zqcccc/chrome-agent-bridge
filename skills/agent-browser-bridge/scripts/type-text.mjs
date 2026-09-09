#!/usr/bin/env node
// 通用"向页面元素输入文本"脚本（受控组件友好）
// 用法: BRIDGE_TOKEN=xxx node type-text.mjs <tabId> <selector> <text>
// selector 支持 CSS 选择器；元素须是 input/textarea/contenteditable
const token = process.env.BRIDGE_TOKEN;
const [, , tabId, selector, text] = process.argv;
if (!token || !tabId || !selector || text === undefined) {
  console.error("usage: BRIDGE_TOKEN=xxx node type-text.mjs <tabId> <selector> <text>");
  process.exit(1);
}
const safe = JSON.stringify(text);
const expression = `(()=>{
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return JSON.stringify({ok:false, err:'selector not found: '+${JSON.stringify(selector)}});
  el.focus();
  const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLElement.prototype;
  const key = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? 'value' : 'innerText';
  const setter = Object.getOwnPropertyDescriptor(proto, key).set;
  setter.call(el, ${safe});
  el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:${safe}}));
  el.dispatchEvent(new Event('change', {bubbles:true}));
  return JSON.stringify({ok:true, val:(el.value ?? el.innerText).slice(0,40)});
})()`;
fetch("http://127.0.0.1:8778/rpc", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ method: "page.evaluate", params: { tabId: Number(tabId), expression, awaitPromise: false }, timeoutMs: 20000 }),
})
  .then(r => r.json())
  .then(r => console.log(JSON.stringify(r.result && r.result.result)))
  .catch(e => { console.error("ERR", e.message); process.exit(1); });
