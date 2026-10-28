// 方法注册表与源码一致性：扩展 switch / host 本地处理的方法必须全部登记在 methods.js，反之亦然。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { METHODS, resolveMethod, suggestMethods } = require("./methods.js");
const here = path.dirname(new URL(import.meta.url).pathname);
const bg = fs.readFileSync(path.join(here, "..", "extension", "background.js"), "utf8");
const host = fs.readFileSync(path.join(here, "host.js"), "utf8");

// bidi.* 是扩展反向调用 host 的通道，不是给 Agent 的方法
const isAgentMethod = (m) => !m.startsWith("bidi.");
const extMethods = new Set(
  [...bg.matchAll(/case "([a-zA-Z.]+)":/g), ...bg.matchAll(/method === "([a-zA-Z.]+)"/g)]
    .map((m) => m[1])
    .filter((m) => m.includes(".") && isAgentMethod(m))
);
const hostMethods = Object.keys(METHODS).filter((k) => resolveMethod(k).host);

test("扩展实现的方法都已登记", () => {
  const missing = [...extMethods].filter((m) => !METHODS[m]);
  assert.deepEqual(missing, [], `background.js 有但 methods.js 没登记：${missing.join(", ")}`);
});

test("登记的方法都有实现", () => {
  const orphan = Object.keys(METHODS).filter((m) => !extMethods.has(m) && !resolveMethod(m).host);
  assert.deepEqual(orphan, [], `methods.js 登记了但扩展没实现：${orphan.join(", ")}`);
});

test("host:true 的方法在 host.js 本地处理", () => {
  const missing = hostMethods.filter((m) => !host.includes(`method === "${m}"`));
  assert.deepEqual(missing, [], `标了 host:true 但 host.js 没处理：${missing.join(", ")}`);
});

test("别名指向存在的方法，且每个方法都有说明", () => {
  for (const [name, m] of Object.entries(METHODS)) {
    if (m.aliasOf) assert.ok(METHODS[m.aliasOf] && !METHODS[m.aliasOf].aliasOf, `${name} 的 aliasOf 无效`);
    else assert.ok(m.desc, `${name} 缺 desc`);
    for (const r of m.required || []) assert.ok(m.params && m.params[r], `${name} 的必填参数 ${r} 不在 params 里`);
  }
  assert.equal(resolveMethod("page.open").aliasOf, "tabs.resolve");
  assert.equal(resolveMethod("nope.nope"), null);
});

test("UNKNOWN_METHOD 建议命中常见误写", () => {
  assert.ok(suggestMethods("page.eval").includes("page.evaluate"));
  assert.ok(suggestMethods("tabs.closeTab").includes("tabs.close"));
  assert.ok(suggestMethods("help").length > 0);
});
