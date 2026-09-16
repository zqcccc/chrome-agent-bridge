// send-chat 验证 helper 的纯逻辑测试（覆盖任务要求的 6 种情形）
// 运行: node --test relay/test-verify.mjs  或 node relay/test-verify.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = import.meta.dirname || dirname(fileURLToPath(import.meta.url));
// helper 是 skill 的一部分，从仓库内引用，保证 skill 自包含（见仓库 AGENTS.md）。
// 不要指向 ~/.agents/skills/... —— 那是安装后的路径，换个机器/换个人就不存在。
const helpersUrl = pathToFileURL(
  join(__dirname, "..", "skills", "agent-browser-bridge", "scripts", "boss-verify-helpers.mjs")
).href;
const { analyzeDelivery, decideOutcome, isBlocked, matchDelivery } = await import(helpersUrl);

const SENT = "您好！我是张三，5年前端 React 经验，住海淀大钟寺。简历：https://resume.onlylike.work 期待沟通！";

test("情形1：文本和送达同节点（气泡内含状态文案）", () => {
  const analysis = analyzeDelivery({
    sentText: SENT,
    bubbles: [{ isMyself: true, bubbleText: SENT, statusText: "", fullText: SENT + " 送达" }],
    inputText: "",
    blockedText: "",
  });
  assert.equal(analysis.messageFound, true);
  assert.equal(analysis.ownMessage, true);
  assert.equal(analysis.delivery, "delivered");
  assert.equal(decideOutcome(analysis), "sent");
});

test("情形2：文本在子节点、送达在父级（状态节点是气泡的兄弟）", () => {
  const analysis = analyzeDelivery({
    sentText: SENT,
    bubbles: [{ isMyself: true, bubbleText: SENT, statusText: "已读", fullText: SENT + " 已读" }],
    inputText: "",
    blockedText: "",
  });
  assert.equal(analysis.messageFound, true);
  assert.equal(analysis.delivery, "read");
  assert.equal(decideOutcome(analysis), "sent");
});

test("情形3：旧消息同文本但不是本人（ownMessage=false 不算成功）", () => {
  const analysis = analyzeDelivery({
    sentText: SENT,
    bubbles: [
      { isMyself: false, bubbleText: SENT, statusText: "已读", fullText: SENT }, // 对方气泡，文本相同
    ],
    inputText: "",
    blockedText: "",
  });
  // 旧消息/非本人：不应判为 sent
  assert.equal(analysis.ownMessage, false);
  assert.notEqual(decideOutcome(analysis), "sent");
});

test("情形3b：本人旧消息存在（文本相同）但本次未发出 —— 仍判定为存在本人消息，需调用方核对", () => {
  // 这正是 UNKNOWN 防误判的核心：旧本人气泡文本相同会被 messageFound=true，
  // 但状态可能是旧的。本 helper 只负责“结构化事实”，决策由调用方结合输入框判断。
  const analysis = analyzeDelivery({
    sentText: SENT,
    bubbles: [{ isMyself: true, bubbleText: SENT, statusText: "送达", fullText: SENT + " 送达" }],
    inputText: SENT, // 输入框未清空 —— 强烈提示本次未真正发出
    blockedText: "",
  });
  assert.equal(analysis.messageFound, true);
  assert.equal(analysis.ownMessage, true);
  assert.equal(analysis.delivery, "delivered");
  // 但 inputCleared=false，调用方可据此怀疑
  assert.equal(analysis.inputCleared, false);
});

test("情形4：平台拦截", () => {
  const analysis = analyzeDelivery({
    sentText: SENT,
    bubbles: [],
    inputText: "",
    blockedText: "平台暂不支持直接发送手机号、微信号等联系方式",
  });
  assert.equal(analysis.blocked, true);
  assert.equal(decideOutcome(analysis), "blocked");
});

test("情形5：输入框未清空", () => {
  const analysis = analyzeDelivery({
    sentText: SENT,
    bubbles: [],
    inputText: SENT,
    blockedText: "",
  });
  assert.equal(analysis.messageFound, false);
  assert.equal(analysis.inputCleared, false);
  assert.equal(decideOutcome(analysis), "input_not_cleared");
});

test("情形6：消息不存在", () => {
  const analysis = analyzeDelivery({
    sentText: SENT,
    bubbles: [],
    inputText: "",
    blockedText: "",
  });
  assert.equal(analysis.messageFound, false);
  assert.equal(analysis.inputCleared, true);
  // 不应判 sent
  assert.notEqual(decideOutcome(analysis), "sent");
  assert.equal(decideOutcome(analysis), "unknown");
});

test("matchDelivery：read 优先于 delivered", () => {
  assert.equal(matchDelivery("已读"), "read");
  assert.equal(matchDelivery("送达"), "delivered");
  assert.equal(matchDelivery(""), null);
  assert.equal(matchDelivery("送达 已读"), "read"); // 同时含已读
});

test("isBlocked：覆盖拦截文案", () => {
  assert.equal(isBlocked("平台暂不支持直接发送"), true);
  assert.equal(isBlocked("为保护用户信息安全，暂不支持直接发送手机号"), true);
  assert.equal(isBlocked("正常送达"), false);
});

test("压缩空白跨节点比较（normalize 在 helper 内部）", () => {
  // 气泡文本含换行/多空格，发送文本是单行 —— normalize 后应匹配
  const analysis = analyzeDelivery({
    sentText: "您好 我是张三 期待沟通",
    bubbles: [{ isMyself: true, bubbleText: "您好\n  我是张三   期待沟通", statusText: "送达", fullText: "送达" }],
    inputText: "",
    blockedText: "",
  });
  assert.equal(analysis.messageFound, true);
  assert.equal(analysis.delivery, "delivered");
});

// 结构化返回字段完整性
test("结构化返回包含所有要求字段", () => {
  const analysis = analyzeDelivery({ sentText: SENT, bubbles: [], inputText: "", blockedText: "" });
  for (const k of ["messageFound", "ownMessage", "delivery", "inputCleared", "blocked", "matchedBubbleText"]) {
    assert.ok(k in analysis, `缺字段 ${k}`);
  }
});
