// bb —— skill 自带的命令行入口，只依赖 scripts/lib/bridge.mjs（token 自动从 ~/.chrome-agent-bridge/token 读取）。
// 用法：node <skill 目录>/scripts/bb.mjs <命令> [参数]，不带参数列出全部命令。
// 退出码：0 成功；1 失败（stderr 输出 [错误码] 消息）；3 用户点了「停止 Agent」（AGENT_STOPPED）。
import path from "node:path";
import { Rpc, BridgeRpcError } from "./lib/bridge.mjs";

const INSPECT_FOCUS = ["overview", "links", "media", "scroll", "modal"];
const WAIT_KINDS = { ready: "page.waitForReady", url: "page.waitForUrl", selector: "page.waitForSelector" };
const RECORD_ACTIONS = ["start", "stop", "status", "get", "clear"];
const READ_TEXT_PREVIEW = 6000;
const SNAP_LINES = 80;

const COMMANDS = {
  status: ["", "host 状态：版本、扩展连接、停止状态"],
  methods: ["[method]", "列出全部 RPC 方法与参数；给方法名只看一个"],
  call: ["<method> [json]", "调用任意 RPC，如 call page.info '{\"tabId\":1}'"],
  errors: ["[tabId]", "近期错误与错误码统计"],
  tabs: ["", "列出标签页（* 为活动页）"],
  open: ["<url> [--exact]", "打开网址：复用非活动同类 tab，否则静默新开后台 tab"],
  read: ["<url|tabId> [--keep-open] [--json]", "一键读网页正文、主链接与阻断诊断"],
  snap: ["<tabId> [compact|elements|a11y|text|full]", "页面快照，compact 输出 [e1] 元素编号"],
  click: ["<tabId> <selector|@e1>", "DOM 点击 el.click()"],
  "click-real": ["<tabId> <selector|@e1 | x y>", "CDP 真实鼠标点击"],
  type: ["<tabId> <selector|@e1> <text>", "DOM 输入"],
  "type-real": ["<tabId> <selector|@e1> <text> [--enter]", "CDP 受控输入并回读校验"],
  press: ["<tabId> <key>", "按键（Enter / Escape / Tab …）"],
  scroll: ["<tabId> <up|down|left|right>", "滚动"],
  upload: ["<tabId> <selector> <file...>", "给 input[type=file] 注入本地文件"],
  eval: ["<tabId> <js>", "CDP 求值（不受页面 CSP 限制）"],
  wait: ["<tabId> ready|url|selector [arg] [timeoutMs]", "条件等待"],
  inspect: ["<tabId> [overview|links|media|scroll|modal|sel:<css>] [limit]", "只读探查，overview 含阻断诊断 blocker"],
  record: ["<tabId> start|stop|status|get|clear [types]", "会话时间线（types: nav,modal,err,dom,console）"],
  shot: ["<tabId> [out.png]", "静默截图（默认 .scratch/screenshots/）"],
  "ensure-active": ["<tabId> [restoreAfterMs]", "后台 tab 渲染暂停时临时切为活动页"],
  "restore-active": ["<tabId>", "立即归还借走的活动页"],
  stop: ["[tabId]", "停止 Agent 写操作"],
  resume: ["[tabId]", "解除停止"],
};

const [cmd, ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const pos = args.filter((a) => !a.startsWith("--"));

function usage(name) {
  if (name) return `用法: bb ${name} ${COMMANDS[name][0]}`;
  const w = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  return ["用法: node <skill 目录>/scripts/bb.mjs <命令> [参数]", "", ...Object.entries(COMMANDS).map(([k, [a, d]]) => `  ${k.padEnd(w)}  ${a}${a ? "  " : ""}— ${d}`)].join("\n");
}

function need(n) {
  if (pos.length < n) throw new BridgeRpcError("BAD_PARAMS", usage(cmd), cmd);
}

const tab = (i = 0) => {
  const n = Number(pos[i]);
  if (!Number.isInteger(n)) throw new BridgeRpcError("BAD_PARAMS", `tabId 应为整数，收到 ${pos[i]}\n${usage(cmd)}`, cmd);
  return n;
};

// 选择器参数：@e3 / e3 交给扩展按快照引用解析，其余按 CSS
const target = (s) => ({ selector: s });

const print = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
const short = (s, n) => {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

async function run(rpc) {
  switch (cmd) {
    case "status":
      return print(await rpc.status());
    case "methods":
      return print(await rpc.call("bridge.methods", pos[0] ? { name: pos[0] } : {}));
    case "call": {
      need(1);
      const params = pos[1] ? JSON.parse(pos[1]) : {};
      return print(await rpc.callRaw(pos[0], params, params.timeoutMs ? params.timeoutMs + 5000 : 30000));
    }
    case "errors": {
      const r = await rpc.recentErrors({ tabId: pos[0] ? tab() : undefined, limit: 20 });
      console.log(`近期错误 ${r.matched}/${r.total} 条  分布 ${JSON.stringify(r.byCode)}`);
      for (const e of r.errors) console.log(`  [${e.at}] tab=${e.tabId ?? "-"} ${e.method} → ${e.code}: ${short(e.message, 100)}`);
      return;
    }
    case "tabs": {
      const { tabs } = await rpc.call("tabs.list");
      for (const t of tabs) console.log(`${t.active ? "*" : " "} #${t.id}  ${short(t.title, 40)}  ${short(t.url, 80)}`);
      return;
    }
    case "open": {
      need(1);
      const r = await rpc.call("tabs.resolve", { url: pos[0], match: flags.has("--exact") ? "exact" : "host", waitLoad: true }, 45000);
      return print({ tabId: r.tabId, reused: r.reused, navigated: r.navigated, url: r.tab && r.tab.url, reason: r.reason });
    }
    case "read": {
      need(1);
      const params = /^\d+$/.test(pos[0]) ? { tabId: Number(pos[0]) } : { url: pos[0] };
      const r = await rpc.readPage({ ...params, keepOpen: flags.has("--keep-open") });
      if (flags.has("--json")) return print(r);
      console.log(`== ${r.title || "(无标题)"} ==\n${r.url}  tab #${r.tabId}${r.closed ? "（已关闭）" : ""}  正文 ${r.textLength} 字${r.truncated ? "（已截断）" : ""}`);
      if (r.blocker) console.log(`⚠ 阻断: ${JSON.stringify(r.blocker)}`);
      console.log(`\n${(r.text || "").slice(0, READ_TEXT_PREVIEW)}`);
      if (r.links && r.links.length) {
        console.log("\n── 链接 ──");
        for (const l of r.links.slice(0, 15)) console.log(`  · ${short(l.text, 40)} → ${l.href}`);
      }
      return;
    }
    case "snap": {
      need(1);
      const mode = pos[1] || "compact";
      const s = await rpc.call("page.snapshot", { tabId: tab(), mode, includeText: mode !== "compact" });
      if (mode !== "compact") return print(s);
      console.log(`${s.url}  (${s.title})  元素 ${s.elementCount} 个，可用 @e1 形式传给 click / type`);
      console.log(String(s.compact || "").split("\n").slice(0, SNAP_LINES).join("\n"));
      return;
    }
    case "click":
      need(2);
      return print(await rpc.call("page.click", { tabId: tab(), ...target(pos[1]) }));
    case "click-real": {
      need(2);
      const isXY = pos.length >= 3 && /^-?\d+(\.\d+)?$/.test(pos[1]) && /^-?\d+(\.\d+)?$/.test(pos[2]);
      return print(isXY ? await rpc.clickReal(tab(), Number(pos[1]), Number(pos[2])) : await rpc.clickReal(tab(), target(pos[1])));
    }
    case "type":
      need(3);
      return print(await rpc.call("page.type", { tabId: tab(), ...target(pos[1]), text: pos.slice(2).join(" ") }));
    case "type-real":
      need(3);
      return print(await rpc.typeReal(tab(), pos[1], pos.slice(2).join(" "), { pressEnter: flags.has("--enter") }));
    case "press":
      need(2);
      return print(await rpc.call("page.press", { tabId: tab(), key: pos[1] }));
    case "scroll":
      need(2);
      return print(await rpc.call("page.scroll", { tabId: tab(), direction: pos[1] }));
    case "upload":
      need(3);
      return print(await rpc.uploadFile(tab(), pos[1], pos.slice(2).map((f) => path.resolve(f))));
    case "eval":
      need(2);
      return print(await rpc.ev(tab(), pos.slice(1).join(" "), { awaitPromise: true }));
    case "wait": {
      need(2);
      const method = WAIT_KINDS[pos[1]];
      if (!method) throw new BridgeRpcError("BAD_PARAMS", `wait 只支持 ${Object.keys(WAIT_KINDS).join(" / ")}`, cmd);
      const params = { tabId: tab() };
      if (pos[1] === "url") params.match = pos[2];
      if (pos[1] === "selector") params.selector = pos[2];
      const timeoutArg = pos[1] === "ready" ? pos[2] : pos[3];
      if (timeoutArg) params.timeoutMs = Number(timeoutArg);
      return print(await rpc.call(method, params, (params.timeoutMs || 30000) + 5000));
    }
    case "inspect": {
      need(1);
      const arg = pos[1] || "overview";
      const params = { tabId: tab() };
      if (arg.startsWith("sel:")) Object.assign(params, { focus: "sel", selector: arg.slice(4) });
      else if (INSPECT_FOCUS.includes(arg)) params.focus = arg;
      else throw new BridgeRpcError("BAD_PARAMS", `focus 只支持 ${INSPECT_FOCUS.join(" / ")} / sel:<css>`, cmd);
      if (pos[2]) params.limit = Number(pos[2]);
      return print(await rpc.call("page.inspect", params));
    }
    case "record": {
      need(2);
      if (!RECORD_ACTIONS.includes(pos[1])) throw new BridgeRpcError("BAD_PARAMS", usage(cmd), cmd);
      const params = { tabId: tab() };
      if (pos[1] === "get" && pos[2]) params.types = pos[2].split(",");
      return print(await rpc.call(`page.record.${pos[1]}`, params));
    }
    case "shot": {
      need(1);
      const out = pos[1] || path.join(process.cwd(), ".scratch", "screenshots", `shot-${Date.now()}.png`);
      return print(await rpc.screenshot(tab(), out));
    }
    case "ensure-active":
      need(1);
      return print(await rpc.ensureActive(tab(), pos[1] ? { restoreAfterMs: Number(pos[1]) } : {}));
    case "restore-active":
      need(1);
      return print(await rpc.restoreActive(tab()));
    case "stop":
      return print(await rpc.stop(pos[0] ? tab() : undefined, { reason: "cli" }));
    case "resume":
      return print(await rpc.resume(pos[0] ? tab() : undefined));
    default:
      console.log(usage());
      if (cmd) process.exit(1);
  }
}

const rpc = new Rpc({ agentName: process.env.AGENT_NAME || "bb" });
try {
  await run(rpc);
} catch (e) {
  console.error(e instanceof BridgeRpcError ? `✗ ${e.message}` : `✗ ${e && e.stack ? e.stack : e}`);
  if (e && e.details && e.details.suggestions) console.error(`  最接近的方法: ${e.details.suggestions.join(" / ")}`);
  process.exitCode = e && e.code === "AGENT_STOPPED" ? 3 : 1;
} finally {
  await rpc.cleanup();
}
