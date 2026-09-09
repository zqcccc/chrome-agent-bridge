(() => {
  const $ = (id) => document.getElementById(id);

  function showErr(msg) {
    const el = $("err");
    el.textContent = msg;
    el.style.display = msg ? "block" : "none";
  }

  async function refresh() {
    try {
      const status = await chrome.runtime.sendMessage({ type: "bridge.status" });
      $("dot").className = "dot " + (status.connected ? "on" : "off");
      $("conn").textContent = status.connected
        ? "已连接 · " + status.relayUrl.replace(/token=.*/, "token=***")
        : "未连接 · " + status.relayUrl.replace(/token=.*/, "token=***");
      $("version").textContent = "v" + status.version;
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
