// Agent Browser Bridge - content script
// 注入到用户页面（isolated world），负责所有 DOM 级操作。
// 只监听本扩展的消息，不修改页面行为。

(() => {
  if (window.__AGENT_BRIDGE_LOADED__) return;
  window.__AGENT_BRIDGE_LOADED__ = true;

  // ---------- 工具 ----------
  function serializeValue(v) {
    if (v === undefined) return { __type: "undefined" };
    if (v === null) return null;
    if (typeof v === "function") return { __type: "function" };
    if (typeof v === "bigint") return { __type: "bigint", value: v.toString() };
    if (v instanceof Element) {
      return {
        __type: "element",
        tag: v.tagName,
        id: v.id || null,
        text: (v.textContent || "").slice(0, 500),
      };
    }
    if (v instanceof Node) return { __type: "node", nodeName: v.nodeName };
    if (typeof v === "object") {
      try {
        return JSON.parse(JSON.stringify(v));
      } catch (e) {
        return { __type: "unserializable", str: String(v).slice(0, 500) };
      }
    }
    return v;
  }

  function getXPath(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return `//*[@id=${JSON.stringify(el.id)}]`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part = `//*[@id=${JSON.stringify(node.id)}]`;
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) {
          part += `[${siblings.indexOf(node) + 1}]`;
        }
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.length ? "/" + parts.join("/") : null;
  }

  function getCssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part = "#" + CSS.escape(node.id);
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children);
        const sameTag = siblings.filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) {
          part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function visible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function isInteractive(el) {
    if (!(el instanceof Element)) return false;
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (["a", "button", "input", "select", "textarea", "summary", "option", "label"].includes(tag)) return true;
    if (el.isContentEditable) return true;
    if (["button", "link", "checkbox", "radio", "switch", "menuitem", "tab", "option", "combobox", "textbox", "searchbox", "slider", "spinbutton", "listbox"].includes(role)) return true;
    return false;
  }

  // 敏感字段：密码 / 隐藏 / 卡号 / 验证码等（参考 Claude 扩展的遮蔽策略）
  const SENSITIVE_AUTOCOMPLETE = [
    "current-password", "new-password", "one-time-code",
    "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year",
  ];

  function isSensitive(el) {
    if (!(el instanceof Element)) return false;
    const t = (el.getAttribute("type") || "").toLowerCase();
    if (t === "password" || t === "hidden") return true;
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    return SENSITIVE_AUTOCOMPLETE.some((s) => ac.includes(s));
  }

  // 元素可读名称：aria-label > placeholder > title > alt > label[for] > value / 文本（参考 Claude）
  function readableName(el) {
    const direct = (v) => (v && v.trim ? v.trim() : null);
    const aria = direct(el.getAttribute("aria-label"));
    if (aria) return aria;
    const placeholder = direct(el.getAttribute("placeholder"));
    if (placeholder) return placeholder;
    const title = direct(el.getAttribute("title"));
    if (title) return title;
    const alt = direct(el.getAttribute("alt"));
    if (alt) return alt;
    if (el.id) {
      const lbl = document.querySelector(`label[for=${CSS.escape(el.id)}]`);
      if (lbl) {
        const t = direct(lbl.textContent);
        if (t) return t;
      }
    }
    return null;
  }

  function shortText(el, max = 120) {
    let t = "";
    if (isSensitive(el)) return "[value redacted]";
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      t = el.value || readableName(el) || "";
    } else if (el.tagName === "SELECT") {
      t = Array.from(el.selectedOptions).map((o) => o.text).join(",");
    } else if (el.tagName === "IMG") {
      t = el.alt || el.title || "";
    } else {
      t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    }
    return t.slice(0, max);
  }

  // ---------- 元素查找 ----------
  function findElement(sel, scope = document) {
    const by = sel.by || "css";
    const value = sel.selector !== undefined ? sel.selector : sel.value;
    if (value === undefined || value === null || value === "") {
      throw { code: "BAD_SELECTOR", message: "缺少 selector" };
    }

    let el = null;
    if (by === "css") {
      el = scope.querySelector(value);
    } else if (by === "xpath") {
      const res = document.evaluate(value, scope, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      el = res.singleNodeValue;
    } else if (by === "text") {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (!(n instanceof Element)) continue;
        if (n.children.length && !isInteractive(n)) continue;
        const text = (n.innerText || n.textContent || "").trim();
        if (text === value) { el = n; break; }
        if (text.includes(value)) { el = n; break; }
      }
    } else if (by === "aria") {
      const norm = value.toLowerCase();
      const all = Array.from(scope.querySelectorAll("*"));
      el = all.find((n) => {
        const a = (n.getAttribute && n.getAttribute("aria-label")) || "";
        const name = n.getAttribute && n.getAttribute("name");
        const id = n.id || "";
        return [a, name, id].some((v) => v && v.toLowerCase() === norm);
      }) || null;
    } else if (by === "index") {
      const idx = Number(value);
      const list = collectElements(scope);
      el = list[idx] || null;
    } else if (by === "name") {
      el = scope.querySelector(`[name=${JSON.stringify(value)}]`);
    } else if (by === "placeholder") {
      el = scope.querySelector(`[placeholder=${JSON.stringify(value)}]`);
    } else {
      throw { code: "BAD_SELECTOR", message: `未知定位方式: ${by}` };
    }

    if (!el) throw { code: "NOT_FOUND", message: `未找到元素 (by=${by}, selector=${value})` };
    return el;
  }

  // ---------- 事件派发（兼容 React/Vue 等现代框架） ----------
  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function dispatchInput(el, value) {
    setNativeValue(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function mouseEvent(el, type) {
    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    };
    el.dispatchEvent(new MouseEvent(type, opts));
  }

  function clickElement(el) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    mouseEvent(el, "mousedown");
    mouseEvent(el, "mouseup");
    mouseEvent(el, "click");
    if (typeof el.click === "function") {
      try { el.click(); } catch (e) { /* noop */ }
    }
  }

  // ---------- 快照 ----------
  const INTERACTIVE_TAGS = ["a", "button", "input", "select", "textarea", "summary"];

  function collectElements(scope) {
    const out = [];
    const all = Array.from(scope.querySelectorAll("*"));
    for (const el of all) {
      if (!(el instanceof Element)) continue;
      if (!visible(el)) continue;
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT" || el.tagName === "TEMPLATE") continue;
      const tag = el.tagName.toLowerCase();
      const role = (el.getAttribute("role") || "").toLowerCase();

      if (INTERACTIVE_TAGS.includes(tag) || isInteractive(el)) {
        const name = readableName(el);
        out.push({
          index: out.length,
          tag,
          role: role || inferRole(el),
          id: el.id || null,
          name: el.getAttribute("name") || null,
          label: name,
          ariaLabel: el.getAttribute("aria-label") || null,
          text: shortText(el),
          href: el.href || null,
          value: (el.value !== undefined && typeof el.value === "string")
            ? (isSensitive(el) ? "[value redacted]" : el.value.slice(0, 200))
            : null,
          placeholder: el.getAttribute("placeholder") || null,
          type: el.type || null,
          checked: el.checked !== undefined ? el.checked : null,
          disabled: el.disabled === true,
          sensitive: isSensitive(el),
          xpath: getXPath(el),
          css: getCssPath(el),
          rect: rectOf(el),
        });
      }
    }
    return out;
  }

  function inferRole(el) {
    const tag = el.tagName.toLowerCase();
    const t = (el.getAttribute("type") || "").toLowerCase();
    const roleMap = {
      a: "link", button: "button", select: "combobox", textarea: "textbox", summary: "button",
      h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
      img: "image", nav: "navigation", main: "main", header: "banner", footer: "contentinfo",
      section: "region", article: "article", aside: "complementary", form: "form",
      table: "table", ul: "list", ol: "list", li: "listitem", label: "label",
    };
    if (tag === "input") {
      if (t === "submit" || t === "button") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "search") return "searchbox";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "password") return "textbox";
      return "textbox";
    }
    return roleMap[tag] || null;
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
      centerX: Math.round(r.x + r.width / 2), centerY: Math.round(r.y + r.height / 2),
    };
  }

  // 简化的可访问性树（限制深度与节点数）
  function buildA11yTree(root, depth, maxDepth, maxNodes, out = { nodes: 0, root: null }) {
    if (depth > maxDepth || out.nodes > maxNodes || !(root instanceof Element)) return null;
    if (!visible(root) && root !== document.body) return null;

    const tag = root.tagName.toLowerCase();
    const role = (root.getAttribute("role") || "").toLowerCase();
    const meaningful =
      isInteractive(root) ||
      (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") ||
      (tag === "header" || tag === "footer" || tag === "nav" || tag === "main" || tag === "section" || tag === "article" || tag === "aside");

    const node = {
      tag,
      role: role || inferRole(root),
      text: meaningful ? shortText(root, 200) : null,
      ariaLabel: root.getAttribute("aria-label") || null,
      xpath: meaningful ? getXPath(root) : null,
      children: [],
    };
    out.nodes++;
    if (!out.root) out.root = node;

    for (const child of root.children) {
      const c = buildA11yTree(child, depth + 1, maxDepth, maxNodes, out);
      if (c && c !== node) node.children.push(c);
    }
    // 叶子太多就裁剪
    if (node.children.length > 30) node.children = node.children.slice(0, 30);
    return node;
  }

  function snapshot(opts = {}) {
    const mode = opts.mode || "a11y";
    const includeText = opts.includeText !== false;
    const maxDepth = opts.maxDepth || 12;
    const maxNodes = opts.maxNodes || 2000;
    const textMax = opts.textMax || 60000;

    const result = {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      mode,
      time: Date.now(),
    };

    if (mode === "elements" || mode === "full") {
      result.elements = collectElements(document);
    }

    if (mode === "a11y" || mode === "full") {
      const out = { nodes: 0, root: null };
      buildA11yTree(document.body || document.documentElement, 0, maxDepth, maxNodes, out);
      result.a11y = out.root;
      result.nodeCount = out.nodes;
      result.truncated = out.nodes > maxNodes;
    }

    if (includeText && (mode === "text" || mode === "full")) {
      result.text = (document.body && document.body.innerText || "").slice(0, textMax);
    }

    if (mode === "a11y" && includeText) {
      result.text = (document.body && document.body.innerText || "").slice(0, textMax);
    }

    return result;
  }

  // ---------- 操作 ----------
  function doClick(args) {
    const el = findElement(args);
    if (el instanceof HTMLAnchorElement && el.target && el.target !== "_self") {
      // 保留原有新标签页行为
      clickElement(el);
      return { ok: true, tag: el.tagName, text: shortText(el, 80) };
    }
    clickElement(el);
    return { ok: true, tag: el.tagName, text: shortText(el, 80), xpath: getXPath(el) };
  }

  function doType(args) {
    const el = findElement(args);
    const text = args.text !== undefined ? args.text : args.value;
    if (text === undefined) throw { code: "BAD_PARAMS", message: "缺少 text" };
    el.focus();
    if (el.isContentEditable) {
      el.textContent = "";
      const sel = window.getSelection();
      sel.selectAllChildren(el);
      document.execCommand("insertText", false, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      if (args.clear !== false) dispatchInput(el, "");
      dispatchInput(el, text);
    }
    return { ok: true, value: el.value !== undefined ? el.value.slice(0, 200) : null };
  }

  const KEYMAP = {
    enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
    backspace: "Backspace", delete: "Delete", "delete": "Delete",
    arrowup: "ArrowUp", up: "ArrowUp", arrowdown: "ArrowDown", down: "ArrowDown",
    arrowleft: "ArrowLeft", left: "ArrowLeft", arrowright: "ArrowRight", right: "ArrowRight",
    home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", space: " ",
  };

  function doPress(args) {
    const keyRaw = args.key || args.value;
    if (!keyRaw) throw { code: "BAD_PARAMS", message: "缺少 key" };
    const key = KEYMAP[String(keyRaw).toLowerCase()] || String(keyRaw);
    const target = args.selector ? findElement(args) : document.activeElement || document.body;
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      key,
      code: args.code || null,
      ctrlKey: !!args.ctrl || !!args.control,
      metaKey: !!args.meta || !!args.command,
      altKey: !!args.alt,
      shiftKey: !!args.shift,
      repeat: false,
    };
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keypress", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    return { ok: true, key, target: target.tagName };
  }

  function doScroll(args) {
    if (args.selector) {
      const el = findElement(args);
      el.scrollIntoView({ block: args.block || "center", inline: "center", behavior: args.behavior || "instant" });
      return { ok: true, target: "element", xpath: getXPath(el) };
    }
    if (args.direction) {
      const amount = args.amount || Math.round(window.innerHeight * 0.8);
      const dir = String(args.direction).toLowerCase();
      const delta = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] };
      const [dx, dy] = delta[dir] || [0, amount];
      window.scrollBy({ left: dx, top: dy, behavior: args.behavior || "instant" });
      return { ok: true, direction: dir, x: window.scrollX, y: window.scrollY };
    }
    const x = args.x || window.scrollX;
    const y = args.y !== undefined ? args.y : window.scrollY;
    window.scrollTo({ left: x, top: y, behavior: args.behavior || "instant" });
    return { ok: true, x: window.scrollX, y: window.scrollY };
  }

  function doHover(args) {
    const el = findElement(args);
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, composed: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, composed: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, composed: true, view: window }));
    return { ok: true, tag: el.tagName };
  }

  function doFocusEl(args) {
    const el = findElement(args);
    el.focus({ preventScroll: false });
    el.scrollIntoView({ block: "center", behavior: "instant" });
    return { ok: true, tag: el.tagName, active: document.activeElement === el };
  }

  function doSelect(args) {
    const el = findElement(args);
    if (!(el instanceof HTMLSelectElement)) {
      throw { code: "NOT_SELECT", message: `元素不是 <select>（${el.tagName}）` };
    }
    const values = Array.isArray(args.values) ? args.values : [args.value || args.values];
    const labels = Array.isArray(args.labels) ? args.labels : [];
    for (let i = 0; i < el.options.length; i++) {
      const opt = el.options[i];
      if (values.includes(opt.value) || labels.includes(opt.text) || opt.text === args.label) {
        opt.selected = true;
        if (args.multiple) el.multiple = true;
      }
    }
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return { ok: true, selected: Array.from(el.selectedOptions).map((o) => o.value) };
  }

  function doWaitFor(args) {
    const timeout = args.timeoutMs || 10000;
    const interval = args.intervalMs || 200;
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        try {
          let found = false;
          if (args.selector) {
            found = !!findElement(args);
          } else if (args.expression) {
            found = !!eval(args.expression);
          } else if (args.condition) {
            found = !!args.condition();
          } else {
            found = true;
          }
          if (found) return resolve({ ok: true, waitedMs: Date.now() - start });
          if (Date.now() - start > timeout) {
            return reject({ code: "WAIT_TIMEOUT", message: `等待超时(${timeout}ms): ${args.selector || args.expression}` });
          }
          setTimeout(tick, interval);
        } catch (e) {
          if (Date.now() - start > timeout) {
            return reject({ code: "WAIT_TIMEOUT", message: `等待超时(${timeout}ms): ${e && e.message || e}` });
          }
          setTimeout(tick, interval);
        }
      };
      tick();
    });
  }

  // ---------- 会话记录器（Clarity 式轻量版）----------
  // 记录页面状态"变化过程"的时间线：导航/标题/弹窗出现消失/异常文本/DOM 变化摘要/console 错误。
  // 默认关闭，由 background 经 page.record.start 通过 bridge.recorder.control 消息开启；
  // 事件经 chrome.runtime.sendMessage({type:"bridge.recordEvent"}) 上报到 background 每 tab 环形缓冲。
  // 只读监听，不修改页面行为；MutationObserver 合并节流，避免事件风暴。
  const recorder = {
    running: false,
    observer: null,
    lastUrl: location.href,
    lastTitle: document.title,
    lastModal: false,
    domAccum: null, // 合并窗口内累积的 DOM 变化摘要
    domTimer: null,
    lastEmit: 0,
    errKeywords: ["验证码", "安全验证", "security verification", "404", "页面不存在", "不存在或已删除", "参数错误", "系统繁忙", "风控", "access denied", "not found", "出错了"],

    emit(type, data) {
      try {
        chrome.runtime.sendMessage({ type: "bridge.recordEvent", event: { t: Date.now(), type, data } });
      } catch (e) { /* 页面销毁瞬间可能发送失败，忽略 */ }
    },

    scanErrors() {
      // 页面可见区域出现异常关键词时记录（取 body 前 2000 字符，避免全量扫描开销）
      const txt = (document.body && document.body.innerText || "").slice(0, 2000);
      for (const kw of this.errKeywords) {
        if (txt.includes(kw)) {
          this.emit("err", { keyword: kw, snippet: txt.slice(0, 120) });
          return;
        }
      }
    },

    flushDom() {
      if (!this.domAccum) return;
      const acc = this.domAccum;
      this.domAccum = null;
      if (acc.added > 0 || acc.removed > 0 || acc.textChanged > 0) {
        this.emit("dom", {
          added: acc.added, removed: acc.removed, textChanged: acc.textChanged,
          addedTags: Object.entries(acc.tags).sort((a, b) => b[1] - a[1]).slice(0, 6),
          sampleText: acc.sampleText
        });
      }
    },

    start() {
      if (this.running) return;
      this.running = true;
      this.lastUrl = location.href;
      this.lastTitle = document.title;
      this.lastModal = !!document.querySelector(".note-detail-mask");
      this.emit("recordStart", { url: location.href, title: document.title });
      this.scanErrors();

      // 导航（SPA pushState/hash + popstate）
      const patch = (type) => () => {
        const u = location.href;
        if (u !== this.lastUrl) {
          this.lastUrl = u;
          this.emit("nav", { url: u, type, title: document.title });
        }
      };
      const origPush = history.pushState;
      const origReplace = history.replaceState;
      history.pushState = function (...a) { const r = origPush.apply(this, a); patch("pushState")(); return r; };
      history.replaceState = function (...a) { const r = origReplace.apply(this, a); patch("replaceState")(); return r; };
      window.addEventListener("popstate", patch("popstate"));
      window.addEventListener("hashchange", patch("hashchange"));
      window.addEventListener("pagehide", () => this.emit("nav", { url: "PAGE_HIDDEN", type: "pagehide" }));

      // console 错误（页面 JS 报错是 debug 关键线索）
      const origError = console.error;
      console.error = (...args) => {
        try {
          const txt = args.map((a) => (a && a.message) || String(a)).join(" ").slice(0, 200);
          if (Date.now() - this.lastEmit > 2000) { this.lastEmit = Date.now(); this.emit("console", { level: "error", text: txt }); }
        } catch (e) {}
        return origError.apply(console, args);
      };

      // DOM 变化（合并节流 500ms）
      this.observer = new MutationObserver((muts) => {
        if (!this.domAccum) this.domAccum = { added: 0, removed: 0, textChanged: 0, tags: {}, sampleText: "" };
        const acc = this.domAccum;
        for (const m of muts) {
          if (m.type === "childList") {
            for (const n of m.addedNodes) {
              if (n.nodeType === 1) {
                acc.added++;
                acc.tags[n.tagName] = (acc.tags[n.tagName] || 0) + 1;
                // 弹窗出现（.note-detail-mask）
                if (n.classList && n.classList.contains("note-detail-mask")) {
                  this.lastModal = true;
                  this.emit("modal", { state: "open", noteUrl: location.href });
                }
                // 异常文本关键词（截断正文）
                if (n.innerText) {
                  const t = n.innerText.slice(0, 300);
                  for (const kw of this.errKeywords) {
                    if (t.includes(kw)) { this.emit("err", { keyword: kw, snippet: t.slice(0, 120) }); break; }
                  }
                }
              } else if (n.nodeType === 3 && n.textContent) { acc.textChanged++; }
            }
            acc.removed += m.removedNodes.length;
            // 弹窗消失
            if (this.lastModal && !document.querySelector(".note-detail-mask")) {
              this.lastModal = false;
              this.emit("modal", { state: "closed" });
            }
          } else if (m.type === "characterData" && m.target) {
            acc.textChanged++;
            if (!acc.sampleText && m.target.textContent) acc.sampleText = String(m.target.textContent).slice(0, 80);
          }
        }
        if (!this.domTimer) {
          this.domTimer = setTimeout(() => { this.domTimer = null; this.flushDom(); }, 500);
        }
      });
      this.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      this.emit("recordReady", {});
    },

    stop() {
      if (!this.running) return;
      this.running = false;
      if (this.observer) { this.observer.disconnect(); this.observer = null; }
      if (this.domTimer) { clearTimeout(this.domTimer); this.domTimer = null; }
      this.flushDom();
      this.emit("recordStop", { url: location.href });
    },
  };

  // ---------- 消息入口 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "bridge.action") return false;
    const action = msg.action;
    const args = msg.args || {};
    Promise.resolve()
      .then(() => {
        switch (action) {
          case "snapshot": return snapshot(args);
          case "click": return doClick(args);
          case "type": return doType(args);
          case "press": return doPress(args);
          case "scroll": return doScroll(args);
          case "hover": return doHover(args);
          case "focusEl": return doFocusEl(args);
          case "select": return doSelect(args);
          case "waitFor": return doWaitFor(args);
          default: throw { code: "UNKNOWN_ACTION", message: `未知动作: ${action}` };
        }
      })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({
        ok: false,
        error: { code: e && e.code || "CONTENT_ERROR", message: e && e.message ? String(e.message) : String(e) },
      }));
    return true; // 异步响应
  });

  // ping 直接响应 + 会话记录器控制
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "bridge.ping") {
      sendResponse({ ok: true, alive: true });
      return false;
    }
    if (msg && msg.type === "bridge.recorder.control") {
      if (msg.running) recorder.start(); else recorder.stop();
      sendResponse({ ok: true, running: recorder.running });
      return false;
    }
    return false;
  });

  // 注入后向 background 询问是否处于录制中（导航重载后自动恢复录制）
  try {
    chrome.runtime.sendMessage({ type: "bridge.recorder.wantState" }, (resp) => {
      if (resp && resp.ok && resp.running) recorder.start();
    });
  } catch (e) { /* 忽略 */ }
})();
