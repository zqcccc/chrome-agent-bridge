// Agent Browser Bridge - agent 操作视觉指示器
// 参考 Claude 扩展的 phantom-cursor 设计：agent 在页面上操作时，
// 显示一个虚拟鼠标指针 + 点击闪烁 + 可选的停止按钮，让用户全程可见。
(() => {
  if (window.__AGENT_BRIDGE_INDICATOR__) return;
  window.__AGENT_BRIDGE_INDICATOR__ = true;

  const isTop = window.top === window;

  let cursor = null;
  let cursorInner = null;
  let stopBtn = null;
  let stopTimer = null;
  let currentX = -1000;
  let currentY = -1000;
  let controlBadge = null;
  let controlTimer = null;
  let titleBeforeControl = null;
  let currentAgentDisplay = "Agent";

  const CONTROL_IDLE_MS = 12_000;
  const NS = "http://www.w3.org/2000/svg";

  function formatAgentDisplay(name, id) {
    const rawName = typeof name === "string" ? name.trim() : "";
    const rawId = typeof id === "string" ? id.trim() : "";
    if (!rawName && !rawId) return "Agent";

    // 格式化提取唯一短编号（如从 agent-20754 提取 20754，从 agent-f8e2 提取 f8e2）
    let shortId = "";
    if (rawId && rawId !== "anonymous") {
      shortId = rawId.replace(/^agent-/, "").replace(/^[a-zA-Z_-]+-/, "");
      if (!shortId) shortId = rawId;
    }

    if (!rawName || rawName === "agent" || rawName === "anonymous") {
      return shortId ? `Agent #${shortId}` : "Agent";
    }

    // 若 rawName 已经自带唯一标识（例如已经包含 rawId 或包含 # 标识）
    if (shortId && (rawName.includes(shortId) || rawName.includes(rawId))) {
      return rawName;
    }

    // 若有多个相同的 agent（例如都叫 "小红书采集"），必须拼上短唯一编号区分！
    return shortId ? `${rawName} #${shortId}` : rawName;
  }

  function stripControlPrefix(title) {
    if (!title) return "";
    return title.replace(/^●\s*\[[^\]]+\]\s*接管中\s*\|\s*/, "").replace(/^●\s*Agent\s*接管中\s*\|\s*/, "");
  }

  function escapeHtml(str) {
    return String(str || "").replace(/[<>&"']/g, s => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[s]));
  }

  function buildCursor() {
    const wrap = document.createElement("div");
    wrap.id = "agent-bridge-cursor";
    wrap.setAttribute("aria-hidden", "true");
    wrap.style.cssText = [
      "position:fixed;top:0;left:0;pointer-events:none;z-index:2147483646;",
      "transform:translate3d(-100px,-100px,0);",
      "transition:transform 160ms cubic-bezier(0.2,0,0,1);",
      "will-change:transform;",
    ].join("");

    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", "M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z");

    const mkSvg = (stroke, fill, extra) => {
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("width", "20");
      svg.setAttribute("height", "26");
      svg.setAttribute("viewBox", "0 0 20 26");
      svg.style.cssText = "position:absolute;top:0;left:0;overflow:visible;" + (extra || "");
      const p = path.cloneNode(true);
      p.setAttribute("stroke", stroke);
      p.setAttribute("stroke-width", "3");
      p.setAttribute("stroke-linejoin", "round");
      p.setAttribute("fill", fill);
      svg.appendChild(p);
      return svg;
    };

    // 底色（白描边黑底）+ 前景（品牌橙描边，半透明投影）
    wrap.appendChild(mkSvg("#fff", "#1f1f1f", ""));
    wrap.appendChild(mkSvg("#2f54eb", "#eef2ff", "filter:drop-shadow(0 0 4px rgba(47,84,235,.85)) drop-shadow(0 0 10px rgba(47,84,235,.4));"));
    cursorInner = wrap.lastChild;

    document.documentElement.appendChild(wrap);
    return wrap;
  }

  function ensureCursor() {
    if (!cursor) cursor = buildCursor();
    return cursor;
  }

  function move(x, y, instant) {
    const c = ensureCursor();
    if (instant) {
      c.style.transition = "none";
      c.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      void c.offsetWidth; // 强制回流，恢复过渡
      c.style.transition = "transform 160ms cubic-bezier(0.2,0,0,1)";
    } else {
      c.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
    currentX = x;
    currentY = y;
  }

  function clickAt(x, y) {
    move(x, y, false);
    if (cursorInner) {
      cursorInner.style.transition = "transform 120ms ease";
      cursorInner.style.transform = "scale(0.75)";
      setTimeout(() => {
        if (cursorInner) {
          cursorInner.style.transition = "transform 180ms cubic-bezier(0.2,0,0,1)";
          cursorInner.style.transform = "scale(1)";
        }
      }, 120);
    }
    // 点击涟漪
    const ripple = document.createElement("div");
    ripple.style.cssText = [
      "position:fixed;left:" + x + "px;top:" + y + "px;width:16px;height:16px;margin:-8px 0 0 -8px;",
      "border-radius:50%;background:rgba(47,84,235,.35);pointer-events:none;z-index:2147483646;",
      "transform:scale(.4);opacity:1;",
    ].join("");
    document.documentElement.appendChild(ripple);
    ripple.animate(
      [
        { transform: "scale(.4)", opacity: 1 },
        { transform: "scale(2.4)", opacity: 0 },
      ],
      { duration: 420, easing: "ease-out" }
    ).onfinish = () => ripple.remove();
  }

  function hide() {
    if (cursor) cursor.style.opacity = "0";
  }

  function show() {
    if (cursor) cursor.style.opacity = "1";
  }

  // ---------- 标签页接管状态 ----------
  // 视觉状态放在页面右上角；document.title 前缀直接标记 Chrome 标签页，扩展图标也有辅助 badge。
  // 没有新的页面控制请求后自动变为「已放开」，不把短暂读页面误报成持续接管。
  function setControl(state, agentName, agentId) {
    if (!isTop) return;
    const active = state === "active";
    if (agentName || agentId) {
      currentAgentDisplay = formatAgentDisplay(agentName, agentId);
    }
    const displayName = currentAgentDisplay || "Agent";

    if (controlTimer) { clearTimeout(controlTimer); controlTimer = null; }
    
    // Tab 自身必须可辨认：接管时给 document.title 加带有具体 Agent 实例标识的前缀，放开时原样恢复。
    const cleanTitle = stripControlPrefix(document.title);
    if (active) {
      if (titleBeforeControl === null) {
        titleBeforeControl = cleanTitle;
      }
      document.title = `● [${displayName}] 接管中 | ${titleBeforeControl}`;
    } else {
      if (titleBeforeControl !== null) {
        document.title = titleBeforeControl;
        titleBeforeControl = null;
      } else if (document.title.startsWith("●")) {
        document.title = cleanTitle;
      }
    }

    if (!controlBadge) {
      controlBadge = document.createElement("div");
      controlBadge.id = "agent-bridge-control-status";
      controlBadge.setAttribute("role", "status");
      controlBadge.setAttribute("aria-live", "polite");
      controlBadge.style.cssText = [
        "position:fixed;top:16px;right:16px;display:flex;align-items:center;gap:8px;",
        "padding:9px 14px 9px 11px;border-radius:10px;pointer-events:none;",
        "font:600 13px/1 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;",
        "box-shadow:0 10px 26px rgba(15,23,42,.20);z-index:2147483647;",
        "transition:opacity 180ms ease,transform 180ms ease;",
      ].join("");
      document.documentElement.appendChild(controlBadge);
    }
    controlBadge.style.display = "flex";
    controlBadge.style.opacity = "1";
    controlBadge.style.transform = "translateY(0)";
    controlBadge.style.background = active ? "#1d4ed8" : "#334155";
    controlBadge.style.color = "#fff";
    
    const safeDisplay = escapeHtml(displayName);
    controlBadge.innerHTML = active
      ? `<span style="width:8px;height:8px;border-radius:50%;background:#86efac;box-shadow:0 0 0 3px rgba(134,239,172,.22);flex-shrink:0;"></span><span style="display:flex;align-items:center;gap:4px;"><span>接管:</span><strong style="font-weight:700;color:#93c5fd;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safeDisplay}</strong></span>`
      : `<span style="width:8px;height:8px;border-radius:50%;background:#cbd5e1;flex-shrink:0;"></span><span style="display:flex;align-items:center;gap:4px;"><span>已放开:</span><span style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safeDisplay}</span></span>`;
    
    try {
      chrome.runtime.sendMessage({ type: "bridge.tabControl", state: active ? "active" : "released", agentDisplay: displayName });
    } catch (e) { /* noop */ }
    if (active) controlTimer = setTimeout(() => setControl("released"), CONTROL_IDLE_MS);
  }

  // ---------- 停止按钮 ----------
  function showStop(label, agentName, agentId) {
    if (!isTop) return;
    if (agentName || agentId) {
      currentAgentDisplay = formatAgentDisplay(agentName, agentId);
    }
    const displayName = currentAgentDisplay || "Agent";
    const stopLabel = label || `停止 [${displayName}]`;

    if (stopBtn) {
      stopBtn.style.display = "flex";
      const span = stopBtn.querySelector("span");
      if (span) span.textContent = stopLabel;
      return;
    }
    stopBtn = document.createElement("div");
    stopBtn.id = "agent-bridge-stop";
    stopBtn.setAttribute("role", "button");
    stopBtn.setAttribute("aria-label", stopLabel);
    stopBtn.style.cssText = [
      "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);",
      "display:flex;align-items:center;gap:6px;padding:8px 16px;",
      "background:#dc2626;color:#fff;border:1px solid #fff;border-radius:999px;",
      "font:600 13px/1 -apple-system,'PingFang SC',sans-serif;cursor:pointer;",
      "box-shadow:0 4px 18px rgba(0,0,0,.35);z-index:2147483647;",
    ].join("");
    stopBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor"/></svg><span>${escapeHtml(stopLabel)}</span>`;
    stopBtn.addEventListener("click", () => {
      try {
        chrome.runtime.sendMessage({ type: "bridge.indicatorEvent", event: "agent.stop" });
      } catch (e) { /* noop */ }
      hideStop();
      setControl("released");
    });
    document.documentElement.appendChild(stopBtn);
  }

  function hideStop() {
    if (stopBtn) { stopBtn.style.display = "none"; }
  }

  // ---------- 高亮元素 ----------
  function highlight(selector) {
    const el = selector ? document.querySelector(selector) : null;
    if (!el) return { ok: false };
    const rect = el.getBoundingClientRect();
    const box = document.createElement("div");
    box.id = "agent-bridge-highlight";
    box.style.cssText = [
      `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`,
      "border:2px solid #2f54eb;border-radius:3px;pointer-events:none;z-index:2147483646;",
      "box-shadow:0 0 0 9999px rgba(0,0,0,.18);",
    ].join("");
    document.documentElement.appendChild(box);
    setTimeout(() => box.remove(), 900);
    return { ok: true };
  }

  // ---------- 消息入口 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "bridge.indicator") return false;
    const a = msg.action;
    try {
      switch (a) {
        case "move":
          move(msg.x, msg.y, !!msg.instant);
          show();
          sendResponse({ ok: true });
          break;
        case "click":
          clickAt(msg.x, msg.y);
          show();
          sendResponse({ ok: true });
          break;
        case "highlight":
          sendResponse(highlight(msg.selector));
          break;
        case "hide":
          hide();
          sendResponse({ ok: true });
          break;
        case "setControl":
          setControl(msg.state, msg.agentName, msg.agentId);
          sendResponse({ ok: true });
          break;
        case "showStop":
          showStop(msg.label, msg.agentName, msg.agentId);
          sendResponse({ ok: true });
          break;
        case "hideStop":
          hideStop();
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: "unknown indicator action: " + a });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return false;
  });

  // 页面交互时自动隐藏光标（用户接管）
  document.addEventListener("mousemove", (event) => {
    if (cursor && !stopTimer) {
      // 用户动鼠标超过阈值才隐藏，避免与 agent 移动互相干扰
      if (Math.abs(event.clientX - currentX) > 24 || Math.abs(event.clientY - currentY) > 24) {
        hide();
      }
    }
  }, { passive: true });
})();
