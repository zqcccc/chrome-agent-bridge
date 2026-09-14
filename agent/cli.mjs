#!/usr/bin/env node
// Agent Browser Bridge - CLI demo
// 用法示例：
//   node cli.mjs status
//   node cli.mjs tabs
//   node cli.mjs active
//   node cli.mjs open "https://example.com"
//   node cli.mjs snap <tabId> [mode]
//   node cli.mjs shot <tabId> [out.png]
//   node cli.mjs eval <tabId> "document.title"
//   node cli.mjs click <tabId> "button#submit"
//   node cli.mjs type <tabId> "input#q" "hello"
//   node cli.mjs press <tabId> Enter
//   node cli.mjs scroll <tabId> down
//   node cli.mjs cursor <tabId> move <x> <y>
"use strict";

import { Bridge, BridgeError } from "./client.mjs";

const bridge = new Bridge();
const [cmd, ...rest] = process.argv.slice(2);

function die(e) {
  if (e instanceof BridgeError) {
    console.error(`✗ [${e.code}] ${e.message}`);
  } else {
    console.error("✗", e && e.message || e);
  }
  process.exit(1);
}

function short(s, n = 60) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function printTabs(tabs) {
  for (const t of tabs) {
    const mark = t.active ? "*" : " ";
    console.log(`${mark} #${t.id}  ${short(t.title, 40)}  ${short(t.url, 70)}`);
  }
}

async function main() {
  switch (cmd) {
    case "status": {
      const s = await bridge.status();
      console.log(`name: ${s.name} v${s.version}`);
      console.log(`channel: ${s.channel}   extConnected: ${s.extConnected}`);
      console.log(`port: ${s.port}  pid: ${s.pid}  uptime: ${s.uptimeSec}s`);
      console.log(`token prefix: ${s.tokenPrefix}`);
      break;
    }
    case "tabs": {
      printTabs(await bridge.list());
      break;
    }
    case "active": {
      const t = await bridge.active();
      console.log(`#${t.id}  ${t.title}  ${t.url}`);
      break;
    }
    case "open": {
      const url = rest[0];
      if (!url) return die(new Error("用法: cli open <url>"));
      const t = await bridge.create(url);
      console.log(`opened #${t.id}  ${t.url}`);
      break;
    }
    case "snap": {
      const [tabId, mode] = rest;
      if (!tabId) return die(new Error("用法: cli snap <tabId> [mode]"));
      const s = await bridge.snapshot(Number(tabId), { mode: mode || "elements" });
      console.log(`${s.url}  (${s.title})  ready=${s.readyState}`);
      if (s.elements) {
        console.log(`交互元素 ${s.elements.length} 个:`);
        for (const el of s.elements.slice(0, 40)) {
          console.log(`  [${el.index}] <${el.tag}> role=${el.role || "-"} text="${short(el.label || el.text, 30)}" ${el.sensitive ? "🔒敏感 " : ""}css=${short(el.css, 40)}`);
        }
      }
      if (s.text) console.log(`\n页面文本(${s.text.length}字符):\n${s.text.slice(0, 600)}`);
      break;
    }
    case "shot": {
      const [tabId, out] = rest;
      if (!tabId) return die(new Error("用法: cli shot <tabId> [out.png]"));
      const r = await bridge.screenshot(Number(tabId), out || `/tmp/bridge-shot-${Date.now()}.png`);
      console.log(`saved ${r.path} (${r.captureMode})`);
      break;
    }
    case "eval": {
      const [tabId, ...exprParts] = rest;
      if (!tabId || !exprParts.length) return die(new Error("用法: cli eval <tabId> <expression>"));
      const r = await bridge.evaluate(Number(tabId), exprParts.join(" "));
      console.log(JSON.stringify(r, null, 2).slice(0, 3000));
      break;
    }
    case "record": {
      // 会话记录（Clarity 式变化时间线）：cli.mjs record <tabId> start|stop|status|get|clear [types:nav,modal,err,dom,console]
      const [tabId, action, typesArg] = rest;
      if (!tabId || !action) return die(new Error("用法: cli record <tabId> start|stop|status|get|clear [types:nav,modal,err,dom,console]"));
      const params = { tabId: Number(tabId) };
      if (action === "get" && typesArg) params.types = typesArg.split(",");
      const r = await bridge.rpc(`page.record.${action}`, params);
      if (action === "get") {
        console.log(`== record get @ tab ${tabId}: ${r.total} 条（返回 ${r.count}）==`);
        for (const e of r.events) {
          console.log(`[${new Date(e.t).toLocaleTimeString("zh-CN", { hour12: false })}] ${e.type}  ${JSON.stringify(e.data).slice(0, 160)}`);
        }
      } else {
        console.log(JSON.stringify(r, null, 2));
      }
      break;
    }
    case "verify": {
      // 回归自检：验证各修复项是否生效（方法注册、错误码归一、会话状态、CSP 兜底前提）
      // 用法: node agent/cli.mjs verify
      const { spawn } = await import("node:child_process");
      const path = await import("node:path");
      const script = path.join(path.dirname(new URL(import.meta.url).pathname), "verify-bridge.mjs");
      await new Promise((resolve) => {
        const p = spawn(process.execPath, [script], { stdio: "inherit", env: process.env });
        p.on("exit", (code) => resolve(code));
      });
      break;
    }
    case "wait": {
      // 增强等待：cli.mjs wait <tabId> ready|url|selector <match|selector> [timeoutMs]
      // 取代固定 sleep——之前脚本只能用裸 sleep，正是因为这几个等待方法没暴露到 CLI
      const [tabId, kind, arg, timeoutArg] = rest;
      if (!tabId || !kind) return die(new Error("用法: cli wait <tabId> ready|url|selector <match|selector> [timeoutMs]"));
      const t = Number(tabId);
      const timeoutMs = timeoutArg ? Number(timeoutArg) : undefined;
      let method, params = { tabId: t };
      if (kind === "ready") { method = "page.waitForReady"; params.timeoutMs = timeoutMs; }
      else if (kind === "url") { if (!arg) return die(new Error("url 模式需要 match 参数")); method = "page.waitForUrl"; params.match = arg; params.timeoutMs = timeoutMs; }
      else if (kind === "selector") { if (!arg) return die(new Error("selector 模式需要选择器参数")); method = "page.waitForSelector"; params.selector = arg; params.timeoutMs = timeoutMs; }
      else return die(new Error(`未知 kind: ${kind}（支持 ready/url/selector）`));
      const r = await bridge.rpc(method, params, (timeoutMs || 30000) + 5000);
      console.log(`✓ ${method} 满足：${JSON.stringify(r)}`);
      break;
    }
    case "inspect": {
      // 内置页面探查：cli.mjs inspect <tabId> [overview|links|media|scroll|modal|sel:<css>] [limit]
      const [tabId, arg, limitArg] = rest;
      if (!tabId) return die(new Error("用法: cli inspect <tabId> [overview|links|media|scroll|modal|sel:<css>]"));
      let focus = "overview";
      const params = {};
      if (arg) {
        if (arg.startsWith("sel:")) { focus = "sel"; params.selector = arg.slice(4); }
        else if (["overview", "links", "media", "scroll", "modal"].includes(arg)) focus = arg;
        else return die(new Error(`未知 focus: ${arg}（支持 overview/links/media/scroll/modal/sel:<css>）`));
      }
      if (limitArg && /^\d+$/.test(limitArg)) params.limit = parseInt(limitArg, 10);
      const r = await bridge.rpc("page.inspect", { tabId: Number(tabId), focus, ...params });
      console.log(`== inspect:${focus} @ tab ${tabId} ==`);
      console.log(JSON.stringify(r.result, null, 2));
      break;
    }
    case "click": {
      const [tabId, selector, by] = rest;
      if (!tabId || !selector) return die(new Error("用法: cli click <tabId> <selector> [css|xpath|text|index]"));
      const r = await bridge.click(Number(tabId), selector, { by });
      console.log("clicked:", JSON.stringify(r));
      break;
    }
    case "type": {
      const [tabId, selector, ...textParts] = rest;
      if (!tabId || !selector) return die(new Error("用法: cli type <tabId> <selector> <text>"));
      const r = await bridge.type(Number(tabId), selector, textParts.join(" "));
      console.log("typed:", JSON.stringify(r));
      break;
    }
    case "reload-ext": {
      // 重载扩展自身（免手工去 chrome://extensions 点刷新）。
      // 注意：扩展 reload 会连带关闭 native channel，host 进程随之退出并由 Chrome 重新拉起，
      // 因此 HTTP 响应会丢失。这里把「丢响应」当正常信号处理：发完请求就转而轮询 /status。
      const started = Date.now();
      const before = await bridge.status().catch(() => null);
      let ack = null;
      try {
        ack = await bridge.rpc("extension.reload", { delayMs: Number(rest[0]) || 300 }, 10000);
      } catch (e) {
        // 响应丢失（host 被回收）也算触发成功，后续轮询确认
        if (e && e.code !== "TIMEOUT" && e.code !== "EXT_DISCONNECTED") return die(e);
      }
      console.log(`已触发重载${ack ? `（from v${ack.fromVersion}）` : "（响应丢失，属预期）"}`);
      const deadline = Date.now() + 30000;
      let ok = false, ver = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 700));
        try {
          const st = await bridge.status();
          if (st.extConnected) {
            const r = await bridge.rpc("bridge.status", {}, 5000);
            ver = r.version; ok = true; break;
          }
        } catch (e) { /* host 重启中，继续等 */ }
      }
      if (!ok) return die(new Error("重载后 30s 内未重连，请检查 chrome://extensions"));
      console.log(`✓ 扩展已重载并重连：v${ver}（耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`);
      if (before && ver && before.version !== ver) console.log(`  注意: host /status 的 version 是启动缓存(${before.version})，实际扩展为 v${ver}`);
      break;
    }
    case "press": {
      const [tabId, key] = rest;
      if (!tabId || !key) return die(new Error("用法: cli press <tabId> <key>"));
      const r = await bridge.press(Number(tabId), key);
      console.log("pressed:", JSON.stringify(r));
      break;
    }
    case "scroll": {
      const [tabId, dir] = rest;
      if (!tabId || !dir) return die(new Error("用法: cli scroll <tabId> <up|down|left|right>"));
      const r = await bridge.scroll(Number(tabId), { direction: dir });
      console.log("scrolled:", JSON.stringify(r));
      break;
    }
    case "cursor": {
      const [tabId, action, x, y] = rest;
      if (!tabId || !action) return die(new Error("用法: cli cursor <tabId> <move|click|hide|stop> [x y]"));
      if (action === "move" || action === "click") {
        const r = await bridge.rpc(`page.indicator.${action}`, { tabId: Number(tabId), x: Number(x), y: Number(y) });
        console.log(JSON.stringify(r));
      } else if (action === "hide") {
        console.log(await bridge.indicatorHide(Number(tabId)));
      } else if (action === "stop") {
        console.log(await bridge.indicatorStop(Number(tabId), true));
      }
      break;
    }
    case "listen": {
      console.log("订阅事件中… (Ctrl+C 退出)");
      const ac = new AbortController();
      process.on("SIGINT", () => ac.abort());
      for await (const ev of bridge.subscribe(ac.signal)) {
        console.log("event:", JSON.stringify(ev));
      }
      break;
    }
    default:
      console.log(`未知命令: ${cmd}\n可用命令: status / tabs / active / open / snap / shot / eval / wait / reload-ext / verify / click / type / press / scroll / cursor / listen`);
  }
}

main().catch(die);
