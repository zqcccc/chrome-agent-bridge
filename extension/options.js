(() => {
  const $ = (id) => document.getElementById(id);
  const show = (id, text) => { const el = $(id); el.textContent = text; el.style.display = "block"; };
  const hide = (id) => { $(id).style.display = "none"; };

  async function init() {
    const resp = await chrome.runtime.sendMessage({ type: "bridge.config:get" });
    if (resp && resp.config) {
      $("channel").value = resp.config.channel || "auto";
      $("host").value = resp.config.host || "";
      $("port").value = resp.config.port || "";
      $("token").value = resp.config.token || "";
    }
    const status = await chrome.runtime.sendMessage({ type: "bridge.status" });
    if (status) {
      $("extVersion").textContent = status.version || "—";
      $("connState").textContent = status.connected ? "已连接（" + (status.channel || "?") + "）" : "未连接";
      $("connState").style.color = status.connected ? "#16a34a" : "#dc2626";
    }
  }

  $("save").addEventListener("click", async () => {
    const config = {
      channel: $("channel").value,
      host: $("host").value.trim() || "127.0.0.1",
      port: parseInt($("port").value.trim() || "8778", 10),
      token: $("token").value.trim(),
    };
    const resp = await chrome.runtime.sendMessage({ type: "bridge.config:set", config });
    if (resp && resp.ok) {
      hide("err");
      show("msg", "已保存，正在重连…");
      setTimeout(() => { hide("msg"); window.close(); }, 800);
    } else {
      hide("msg");
      show("err", "保存失败");
    }
  });

  $("test").addEventListener("click", async () => {
    hide("msg"); hide("err");
    const resp = await chrome.runtime.sendMessage({
      type: "bridge.action",
      action: "bridge.ping",
      args: { t: Date.now() },
    });
    if (resp && resp.ok) show("msg", "扩展后台正常，ping 成功");
    else show("err", "扩展后台异常：" + (resp && resp.error && resp.error.message || "未知"));
  });

  init();
})();
