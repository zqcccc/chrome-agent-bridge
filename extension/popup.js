(() => {
  const $ = (id) => document.getElementById(id);

  function showErr(msg) {
    const el = $("err");
    el.textContent = msg;
    el.style.display = msg ? "block" : "none";
  }

  function escapeHtml(str) {
    return String(str || "").replace(/[<>&"']/g, s => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[s]));
  }

  function renderOperatingAgents(agents) {
    const listEl = $("agentsList");
    const countEl = $("agentCount");
    if (!listEl) return;

    if (!agents || agents.length === 0) {
      listEl.innerHTML = '<div class="no-agents">当前无 Agent 在操作标签页</div>';
      if (countEl) countEl.style.display = "none";
      return;
    }

    if (countEl) {
      countEl.textContent = String(agents.length);
      countEl.style.display = "inline-block";
    }

    listEl.innerHTML = agents.map(item => {
      const display = escapeHtml(item.agentDisplay || item.agentName || item.agentId || "Agent");
      const tabTitle = escapeHtml(item.tab?.title || "(无标题)");
      const tabUrl = escapeHtml(item.tab?.url || "");
      const tabId = item.tabId;
      return `
        <div class="agent-item">
          <div class="agent-title-row">
            <span class="agent-tag" title="${display}">${display}</span>
            <span class="agent-tab-badge">Tab #${tabId}</span>
          </div>
          <div class="agent-tab-title" title="${tabTitle}">${tabTitle}</div>
          <div class="agent-tab-url" title="${tabUrl}">${tabUrl}</div>
        </div>
      `;
    }).join("");
  }

  async function refresh() {
    try {
      const status = await chrome.runtime.sendMessage({ type: "bridge.status" });
      $("dot").className = "dot " + (status.connected ? "on" : "off");
      $("conn").textContent = status.connected
        ? "已连接 · " + status.relayUrl.replace(/token=.*/, "token=***")
        : "未连接 · " + status.relayUrl.replace(/token=.*/, "token=***");
      $("version").textContent = "v" + status.version;
      
      // 渲染当前接管操作中的 Agent 列表
      renderOperatingAgents(status.operatingAgents);

      if (status.activeTab) {
        $("tab").textContent = `${status.activeTab.title || "(无标题)"}\n${status.activeTab.url}`;
        $("tab").className = "value";
      } else {
        $("tab").textContent = "—";
        $("tab").className = "value muted";
      }
      showErr("");
    } catch (e) {
      $("dot").className = "dot off";
      showErr("读取状态失败：" + (e && e.message || e));
    }
  }

  $("btnRefresh").addEventListener("click", refresh);
  $("btnOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

  $("btnShot").addEventListener("click", async () => {
    try {
      const active = await chrome.runtime.sendMessage({ type: "bridge.status" });
      const tabId = active && active.activeTab && active.activeTab.id;
      if (!tabId) return showErr("没有活动标签页");
      const res = await chrome.runtime.sendMessage({
        type: "bridge.action",
        action: "screenshot",
        args: { tabId, format: "png", captureBeyondViewport: false },
      });
      if (!res.ok) return showErr(res.error.message);
      const a = document.createElement("a");
      a.href = res.result.image;
      a.download = `bridge-shot-${Date.now()}.png`;
      a.click();
    } catch (e) {
      showErr("截图失败：" + (e && e.message || e));
    }
  });

  refresh();
})();
