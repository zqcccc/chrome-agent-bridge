#!/usr/bin/env node
/**
 * preflight —— 开工前一次性体检，避免在坏 tab / 不存在的能力上盲试几十轮。
 *
 * 为什么需要它（真实数据）：host.log 里单个 tab 上出现过 155 次 PAGE_CONTEXT_TIMEOUT，
 * 因为 agent 选了一个永远 status:"loading" 的 SPA，然后 evaluate 失败 → tabs.prepare
 * 失败 → 再 evaluate，循环几十轮。同期 UNKNOWN_METHOD 151 次，全是调了当前扩展版本
 * 还没注册的方法（page.waitForReady / page.waitForUrl / tabs.open ...）。
 *
 * 这两类失败都是**可以在开工前一次性判定**的。本脚本把它们合并成一条命令。
 *
 * 用法：
 *   node scripts/preflight.mjs              # 体检 + 列出可用 tab
 *   node scripts/preflight.mjs --json       # 机器可读
 *   node scripts/preflight.mjs --pick http  # 只输出一个「推荐 tab 的 id」，直接喂给后续步骤
 *
 * 退出码：0 = 可开工；2 = 桥/扩展不可用；3 = 没有可用 tab
 */

import { Rpc } from "./lib/bridge.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const pickIdx = args.indexOf("--pick");
const pickScheme = pickIdx >= 0 ? (args[pickIdx + 1] || "http") : null;

/** 不能注入的页面协议：桥无法在这些页面上执行任何 DOM 操作。 */
const UNINJECTABLE = /^(chrome|edge|about|devtools|chrome-extension|view-source):/i;

function classifyTab(t) {
  if (t.discarded) return "discarded（已被浏览器丢弃，需 activate 唤醒并会重载）";
  if (UNINJECTABLE.test(t.url || "")) return "uninjectable（受保护页面，无法注入）";
  if (!/^https?:/i.test(t.url || "")) return "non-http（非网页）";
  if (t.status === "loading") return "loading（可能永远加载不完的 SPA，注入易失败）";
  return "ok";
}

const rpc = new Rpc({ agentId: `preflight-${process.pid}`, agentName: "Preflight" });

function out(obj) {
  if (asJson) console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  // ---- 1. 桥与扩展 ----
  let pf;
  try {
    pf = await rpc.preflight();
  } catch (e) {
    console.error(`✗ 连不上本地桥：${e.message}`);
    console.error("  → 检查 Chrome 是否运行、扩展是否启用；host 由 Chrome 按需拉起。");
    process.exit(2);
  }
  if (!pf.extConnected) {
    console.error(`✗ 桥在运行但扩展未连接（channel=${pf.channel}）`);
    console.error("  → 打开 chrome://extensions 确认扩展已启用；或重载扩展。");
    process.exit(2);
  }

  // ---- 2. tab 体检 ----
  const { tabs } = await rpc.call("tabs.list");
  const scored = tabs.map((t) => ({ ...t, health: classifyTab(t) }));
  const usable = scored.filter((t) => t.health === "ok");

  // ---- 3. 能力探测：只探测「这个版本该有但可能没注册」的方法，不做破坏性操作 ----
  const caps = pf.capabilities || {};
  const missing = [];
  if (caps.tabsResolve === false) missing.push("tabs.resolve（打开网址的首选入口，建议升级扩展）");
  if (caps.pageWaitForReady === false) missing.push("page.waitForReady（增强等待，建议升级扩展）");
  if (caps.cspFallback === false) missing.push("page.evaluate 的 CSP 自动兜底（严格 CSP 站点会失败）");

  if (pickScheme) {
    // 既支持协议前缀（http / https），也支持主机名片段（github / xhs / zhipin），
    // 后者是 agent 最常用的写法。
    const re = new RegExp(`^${pickScheme}`, "i");
    const hostRe = new RegExp(`//([^/]*\\.)?${pickScheme}\\.`, "i");
    const matched = usable.filter((t) => re.test(t.url) || hostRe.test(t.url || "") || new RegExp(`//[^/]*${pickScheme}`, "i").test(t.url || ""));
    if (!matched.length) {
      // 不静默 fallback：给错 tab 比不给更坑（agent 会拿它跑很久才发现不对）
      console.error(`✗ 没有匹配 "${pickScheme}" 的可用 tab。可用 tab：`);
      for (const t of usable.slice(0, 10)) console.error(`    #${t.id}  ${(t.url || "").slice(0, 70)}`);
      process.exit(3);
    }
    console.log(String(matched[0].id)); // 只输出 id，便于 shell 直接消费
    return;
  }

  if (!asJson) {
    console.log("── 桥 ──");
    console.log(`  桥版本 ${pf.version}${pf.versionKnown ? "" : "（未知，可能读不到 manifest）"}  通道 ${pf.channel}  模式 ${pf.mode}`);
    if (missing.length) {
      console.log("  ⚠ 能力缺口：");
      for (const m of missing) console.log(`      - ${m}`);
    } else {
      console.log("  ✓ 该版本应有的能力都在");
    }

    console.log("\n── 标签页 ──");
    const bad = scored.filter((t) => t.health !== "ok");
    console.log(`  共 ${scored.length} 个，可用 ${usable.length} 个`);
    if (usable.length) {
      console.log("  可用（优先选这些）：");
      for (const t of usable.slice(0, 8)) {
        console.log(`    #${t.id}  ${(t.url || "").slice(0, 70)}`);
      }
    }
    if (bad.length) {
      console.log("  ⚠ 不要选这些（选了会白跑很多轮）：");
      for (const t of bad.slice(0, 6)) {
        console.log(`    #${t.id}  [${t.health}]  ${(t.url || "").slice(0, 50)}`);
      }
    }
    console.log("\n── 建议 ──");
    if (!usable.length) {
      console.log("  没有可用 tab。先用 tabs.resolve / tabs.create 打开目标页，再开工。");
    } else {
      console.log(`  用 tab #${usable[0].id} 起步；需要特定站点用 --pick <scheme>。`);
    }
  }

  out({
    ok: true,
    bridge: pf,
    capabilities: caps,
    missingCapabilities: missing,
    tabs: { total: scored.length, usable: usable.map((t) => ({ id: t.id, url: t.url })), unusable: scored.filter((t) => t.health !== "ok").map((t) => ({ id: t.id, url: t.url, reason: t.health })) },
  });

  if (!usable.length) process.exit(3);
}

main().catch((e) => { console.error("✗", e.message); process.exit(1); });
