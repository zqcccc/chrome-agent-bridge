#!/usr/bin/env node
// Agent Browser Bridge - 仓库开发用 CLI
// 本文件只保留开发命令（reload-ext / verify / cursor / listen）；
// 其余命令转交 skill 自带的 skills/agent-browser-bridge/scripts/bb.mjs，两边不重复实现。
//   node agent/cli.mjs reload-ext        # 扩展自重载并等待重连
//   node agent/cli.mjs verify            # 回归自检
//   node agent/cli.mjs read <url>        # 等价于 node skills/agent-browser-bridge/scripts/bb.mjs read <url>
"use strict";

import path from "node:path";
import { spawn } from "node:child_process";
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

const BB = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "skills", "agent-browser-bridge", "scripts", "bb.mjs");

function delegateToBb() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BB, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
    p.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main() {
  switch (cmd) {
    case "verify": {
      // 回归自检：验证各修复项是否生效（方法注册、错误码归一、会话状态、CSP 兜底前提）
      // 用法: node agent/cli.mjs verify
      const script = path.join(path.dirname(new URL(import.meta.url).pathname), "verify-bridge.mjs");
      process.exitCode = await new Promise((resolve) => {
        const p = spawn(process.execPath, [script], { stdio: "inherit", env: process.env });
        p.on("exit", (code) => resolve(code ?? 1));
      });
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
      process.exitCode = await delegateToBb();
  }
}

main().catch(die);
