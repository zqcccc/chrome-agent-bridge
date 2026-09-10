// BOSS 直聘送达验证 helper（纯 DOM/字符串层面，可单测）
// 提取自独立 skill boss-zhipin-apply，作为 agent-browser-bridge 的 BOSS 直聘子技能资产（见 boss/SKILL.md）。
// 设计原则：
//  1. 在“当前 selected 会话”内定位本人消息气泡（.message-item.item-myself 或等价）
//  2. 用“本次发送的精确文本”匹配本人气泡（trim+压缩空白后相等或包含）
//  3. 在“同一个本人气泡或其父级”内检查“送达|已读”，不取最短 text node
//  4. 检测平台拦截文案
//  5. 结构化返回：messageFound / ownMessage / delivery / inputCleared / blocked / matchedBubbleText
//  6. UNKNOWN 不代表未发送：调用方应先只读核对，确认已存在且已送达则视为成功
//
// 本模块所有函数都不依赖真实浏览器，输入是 DOM 字符串快照描述（normalize 后）。
// boss-send-chat.mjs 在页面里跑一段 evaluate 把结构化数据取回，再调 analyzeDelivery。

"use strict";

// 压缩空白，便于跨节点比较（BOSS 消息气泡里 text node 可能被 <br> 切碎）
function normalize(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

// 平台拦截文案集合（实测）。命中即 blocked。
const BLOCK_PATTERNS = [
  /平台暂不支持直接发送/,
  /为保护用户信息安全[^]*联系方式/,
  /暂不支持直接发送手机号/,
];

export function isBlocked(text) {
  const t = normalize(text);
  return BLOCK_PATTERNS.some((p) => p.test(t));
}

// delivery 文案匹配：返回 "delivered" | "read" | null
const DELIVERED_RE = /送达/;
const READ_RE = /已读/;
export function matchDelivery(text) {
  const t = normalize(text);
  if (READ_RE.test(t)) return "read";
  if (DELIVERED_RE.test(t)) return "delivered";
  return null;
}

// 气泡对象最小结构：
//   { isMyself: boolean, bubbleText: string, statusText: string, fullText: string }
//   - bubbleText: 本人消息气泡内的“消息正文”（可能不含状态文案）
//   - statusText: 与本气泡关联的“送达/已读”文案所在的同级文本
//   - fullText:   整个气泡容器（含状态）的文本，供 fallback
//
// bubbles 应当只包含 selected 会话内的本人气泡（由页面 evaluate 先筛选 selected）。
export function analyzeDelivery({ sentText, bubbles, inputText, blockedText }) {
  const needle = normalize(sentText).slice(0, 60);
  const result = {
    messageFound: false,
    ownMessage: false,
    delivery: null,          // "delivered" | "read" | null
    inputCleared: normalize(inputText) === "",
    blocked: false,
    matchedBubbleText: "",
    blockedText: blockedText ? normalize(blockedText) : "",
  };

  if (result.blockedText && isBlocked(result.blockedText)) {
    result.blocked = true;
    return result;
  }

  // 1) 在本人气泡里找精确匹配（不是父容器、不是旧消息）
  let matched = null;
  for (const b of bubbles) {
    if (!b || !b.isMyself) continue;
    const bt = normalize(b.bubbleText);
    if (!bt) continue;
    // 精确等于优先；否则包含（本人气泡通常就是发送全文）
    if (bt === needle || bt.includes(needle) || needle.includes(bt)) {
      // 选最贴近的一条：长度差最小的
      if (!matched || Math.abs(bt.length - needle.length) < Math.abs(normalize(matched.bubbleText).length - needle.length)) {
        matched = b;
      }
    }
  }

  if (matched) {
    result.messageFound = true;
    result.ownMessage = true;
    result.matchedBubbleText = normalize(matched.bubbleText).slice(0, 200);
    // 2) 状态文案：优先 statusText，其次 fullText
    const statusSource = matched.statusText || matched.fullText || "";
    result.delivery = matchDelivery(statusSource);
    return result;
  }

  // 3) 没匹配到本人气泡：再扫所有气泡全文，看是否被平台拦截（兜底）
  if (matched === null) {
    for (const b of bubbles) {
      const ft = normalize(b.fullText || "");
      if (isBlocked(ft)) { result.blocked = true; return result; }
    }
  }

  // 4) 消息不存在
  return result;
}

// 决策：UNKNOWN 不能代表未发送。
//  - blocked -> "blocked"
//  - messageFound && ownMessage && delivery -> "sent"
//  - messageFound && ownMessage && !delivery -> "pending"（已发出但未送达）
//  - !messageFound && inputCleared -> "unknown"（可能已发出但 DOM 未渲染；调用方先只读核对）
//  - !messageFound && !inputCleared -> "input_not_cleared"
export function decideOutcome(analysis) {
  if (analysis.blocked) return "blocked";
  if (analysis.messageFound && analysis.ownMessage && analysis.delivery) return "sent";
  if (analysis.messageFound && analysis.ownMessage) return "pending";
  if (!analysis.messageFound && analysis.inputCleared) return "unknown";
  if (!analysis.messageFound && !analysis.inputCleared) return "input_not_cleared";
  return "unknown";
}

// 供 boss-send-chat.mjs 注入页面的 evaluate 脚本：返回 bubbles 数组 + 输入框文本。
// 只读 DOM，不修改页面。当前 selected 会话内取本人消息气泡。
export const COLLECT_BUBBLES_EXPR = String.raw`(()=>{
  // 定位当前 selected 会话的消息容器。BOSS 聊天页主区常见结构：
  //   .chat-message / .chat-conversation / [class*=chat-content]
  // 本人气泡选择器优先级：.message-item.item-myself > [class*=item-myself] > [class*=myself]
  const mySelectors = [
    '.message-item.item-myself',
    '[class*="item-myself"]',
    '[class*="myself"]',
  ];
  function textOf(el){ return (el && (el.innerText||el.textContent||"")) || ""; }
  function statusIn(bubble){
    // 状态文案通常在气泡内的 .message-status / .send-status / [class*=status]，
    // 或与气泡同级的兄弟节点。先查气泡内子节点，再查父级。
    const inner = bubble.querySelector('[class*="status"],[class*="delivery"],[class*="read"]');
    if (inner) return textOf(inner);
    const parent = bubble.parentElement;
    if (parent){
      const p = parent.querySelector('[class*="status"],[class*="delivery"],[class*="read"]');
      if (p) return textOf(p);
    }
    return "";
  }
  let bubbles = [];
  for (const sel of mySelectors){
    const els = document.querySelectorAll(sel);
    if (!els.length) continue;
    bubbles = [...els].map(b=>({
      isMyself: true,
      bubbleText: textOf(b),
      statusText: statusIn(b),
      fullText: textOf(b.parentElement || b),
    }));
    break;
  }
  const input = document.querySelector('.chat-input');
  return JSON.stringify({
    bubbles,
    inputText: textOf(input),
    // 兜底：若上面没取到本人气泡，抓可见的平台拦截提示
    blockedText: (()=>{
      const body = textOf(document.body);
      const m = body.match(/平台暂不支持直接发送[^\n]{0,40}/);
      return m ? m[0] : "";
    })(),
  });
})()`;

export const _internal = { normalize };
