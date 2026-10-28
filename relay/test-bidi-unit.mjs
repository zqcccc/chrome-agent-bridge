// 离线单测：Firefox 版的纯函数部分（不启动浏览器）。
//   - CDP→BiDi 翻译层的值还原与按键映射：保证 Agent 在两种浏览器上拿到同样形状的结果
//   - Firefox manifest 生成：源码只有一份，manifest 由脚本派生
//   - 客户端按 BRIDGE_BROWSER 选端口
// 真机行为见 test-firefox-e2e.mjs。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defaultPort, BROWSER_PORTS } from "../skills/agent-browser-bridge/scripts/lib/bridge.mjs";

const require = createRequire(import.meta.url);
const { deserialize, toRemoteObject, toExceptionDetails, webdriverKey, modifierValues, SUPPORTED_CDP_METHODS } = require("./bidi-cdp.js");
const { firefoxManifest, GECKO_ID } = require("./build-firefox.js");
const HERE = path.dirname(fileURLToPath(import.meta.url));

// BiDi 对 ({a:1,b:[1,'x',null],c:undefined,d:{e:true},m:new Map(),dt:new Date()}) 的序列化
const BIDI_OBJECT = {
  type: "object",
  value: [
    ["a", { type: "number", value: 1 }],
    ["b", { type: "array", value: [{ type: "number", value: 1 }, { type: "string", value: "x" }, { type: "null" }] }],
    ["c", { type: "undefined" }],
    ["d", { type: "object", value: [["e", { type: "boolean", value: true }]] }],
    ["m", { type: "map", value: [] }],
    ["dt", { type: "date", value: "2026-01-01T00:00:00.000Z" }],
  ],
};

test("returnByValue：普通对象/数组还原，undefined 属性省略，Map/Date 为 {}（与 CDP 一致）", () => {
  assert.deepEqual(deserialize(BIDI_OBJECT), { a: 1, b: [1, "x", null], d: { e: true }, m: {}, dt: {} });
});

test("数组里的 undefined 变 null，特殊数值在嵌套位置变 null", () => {
  assert.deepEqual(deserialize({ type: "array", value: [{ type: "undefined" }, { type: "number", value: "NaN" }] }), [null, null]);
});

test("顶层 RemoteObject 的形状", () => {
  assert.deepEqual(toRemoteObject({ type: "undefined" }, true), { type: "undefined" });
  assert.deepEqual(toRemoteObject({ type: "null" }, true), { type: "object", subtype: "null", value: null });
  assert.deepEqual(toRemoteObject({ type: "string", value: "s" }, true), { type: "string", value: "s" });
  assert.deepEqual(toRemoteObject({ type: "number", value: "-0" }, true), { type: "number", unserializableValue: "-0", description: "-0" });
  assert.deepEqual(toRemoteObject({ type: "bigint", value: "12" }, true), { type: "bigint", unserializableValue: "12n", description: "12n" });
  assert.deepEqual(toRemoteObject({ type: "array", value: [] }, true), { type: "object", subtype: "array", value: [] });
  assert.equal(toRemoteObject({ type: "node", sharedId: "x" }, false).subtype, "node");
});

test("异常：description 含消息与堆栈，抛出的原始值保留", () => {
  const ed = toExceptionDetails({
    text: "Error: boom",
    lineNumber: 0,
    columnNumber: 6,
    exception: { type: "error" },
    stackTrace: { callFrames: [{ functionName: "", url: "", lineNumber: 0, columnNumber: 6 }] },
  });
  assert.equal(ed.exception.subtype, "error");
  assert.match(ed.exception.description, /^Error: boom\n {4}at <anonymous>/);
  const thrown = toExceptionDetails({ text: "uncaught x", lineNumber: 0, columnNumber: 0, exception: { type: "string", value: "x" } });
  assert.deepEqual(thrown.exception, { type: "string", value: "x" });
});

test("按键映射：DOM key 名、单字符、\\r", () => {
  assert.equal(webdriverKey({ key: "Enter" }), "");
  assert.equal(webdriverKey({ key: "F5" }), "");
  assert.equal(webdriverKey({ key: "中" }), "中");
  assert.equal(webdriverKey({ text: "\r" }), "");
  assert.throws(() => webdriverKey({ key: "Unidentified" }), { code: "BAD_PARAMS" });
  assert.deepEqual(modifierValues(2 | 8), ["", ""]);
});

test("支持列表覆盖扩展内部与 skill 脚本用到的全部 CDP 方法", () => {
  const used = new Set();
  const scan = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) scan(p);
      else if (/\.(m?js)$/.test(ent.name)) {
        const src = fs.readFileSync(p, "utf8");
        const re = /(?:send\(\s*|method:\s*|cdp\([^,()]+,\s*)"((?:Runtime|Input|DOM|Page|Emulation)\.[A-Za-z]+)"/g;
        for (const m of src.matchAll(re)) used.add(m[1]);
      }
    }
  };
  scan(path.join(HERE, "..", "extension"));
  scan(path.join(HERE, "..", "skills", "agent-browser-bridge"));
  assert.ok(used.has("Runtime.evaluate") && used.has("DOM.setFileInputFiles"), `扫描结果异常: ${[...used]}`);
  // Chrome 独有：渲染器解冻。Firefox 没有 Memory Saver 冻结，扩展在 Firefox 上不走这条路径。
  used.delete("Page.setWebLifecycleState");
  const missing = [...used].filter((m) => !SUPPORTED_CDP_METHODS.includes(m));
  assert.deepEqual(missing, []);
});

test("Firefox manifest：去掉 service_worker / debugger，带 gecko id，版本与 Chrome 版相同", () => {
  const src = JSON.parse(fs.readFileSync(path.join(HERE, "..", "extension", "manifest.json"), "utf8"));
  const ff = firefoxManifest(src);
  assert.deepEqual(ff.background, { scripts: ["background.js"] });
  assert.ok(!ff.permissions.includes("debugger"));
  assert.ok(ff.permissions.includes("nativeMessaging"));
  assert.equal(ff.minimum_chrome_version, undefined);
  assert.equal(ff.browser_specific_settings.gecko.id, GECKO_ID);
  assert.equal(ff.version, src.version);
  assert.deepEqual(ff.options_ui, { page: src.options_page, open_in_tab: true });
});

test("BRIDGE_BROWSER 选端口，BRIDGE_PORT 优先", () => {
  assert.equal(defaultPort({}), BROWSER_PORTS.chrome);
  assert.equal(defaultPort({ BRIDGE_BROWSER: "firefox" }), 8779);
  assert.equal(defaultPort({ BRIDGE_BROWSER: "firefox", BRIDGE_PORT: "9000" }), 9000);
  assert.throws(() => defaultPort({ BRIDGE_BROWSER: "safari" }), /BRIDGE_BROWSER/);
});
