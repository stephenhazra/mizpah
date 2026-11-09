(() => {
  if (window.__mizpahPicker) return;
  window.__mizpahPicker = true;

  const host = document.createElement("mizpah-picker");
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      .hl { position: fixed; pointer-events: none; background: rgba(192,57,43,.25); outline: 2px solid #c0392b; box-shadow: 0 0 0 2px #fff; z-index: 2147483646; transition: all .05s; }
      .bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 2147483647; background: #1e1f24; color: #f2f2f2;
             font: 13px/1.4 system-ui, sans-serif; padding: 10px 12px; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
             display: flex; flex-wrap: wrap; gap: 8px; align-items: center; width: min(640px, calc(100vw - 32px)); box-sizing: border-box; }
      input { flex: 1 1 200px; min-width: 0; font: 12px ui-monospace, monospace; padding: 6px 8px; border-radius: 6px; border: 1px solid #8a8d98; background: #111; color: #f2f2f2; }
      button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 0; cursor: pointer; }
      .ok { background: #c0392b; color: #fff; }
      button:disabled { opacity: .5; cursor: not-allowed; }
      input:focus-visible, button:focus-visible, .bar:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
      @media (pointer: coarse) { button { min-height: 44px; } input { min-height: 44px; font-size: 16px; } }
      @media (prefers-reduced-motion: reduce) { .hl { transition: none; } }
      .cancel { background: #3a3b42; color: #f2f2f2; }
      .hint { opacity: .75; }
      .count { font-variant-numeric: tabular-nums; opacity: .75; white-space: nowrap; }
    </style>
    <div class="hl" hidden></div>
    <div class="bar" role="dialog" aria-label="Hide an element" aria-describedby="hint" tabindex="-1">
      <span class="hint" id="hint">Click an element to hide. Or use the arrow keys to move and Enter to select.</span>
      <input type="text" spellcheck="false" placeholder="CSS selector" aria-label="CSS selector" hidden>
      <span class="count" role="status"></span>
      <button class="ok" hidden>Hide element</button>
      <button class="cancel">Cancel</button>
    </div>`;
  document.documentElement.appendChild(host);

  const hl = shadow.querySelector(".hl");
  const bar = shadow.querySelector(".bar");
  const input = shadow.querySelector("input");
  const hint = shadow.querySelector(".hint");
  const count = shadow.querySelector(".count");
  const ok = shadow.querySelector(".ok");
  const cancel = shadow.querySelector(".cancel");
  let picking = true;
  let current = null;
  const previousFocus = document.activeElement;

  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&"));
  const stableClass = (c) => c && !/\d{3,}|^(is|has)-|active|hover|focus|selected|open|visible/.test(c) && c.length < 40;

  const segment = (el) => {
    if (el.id && !/\d{3,}/.test(el.id)) return `#${cssEscape(el.id)}`;
    let seg = el.localName;
    const classes = [...el.classList].filter(stableClass).slice(0, 3);
    if (classes.length) seg += classes.map((c) => `.${cssEscape(c)}`).join("");
    const parent = el.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.localName === el.localName);
      if (same.length > 1 && !classes.length) seg += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return seg;
  };

  const selectorFor = (el) => {
    const parts = [];
    let node = el;
    while (node && node !== document.documentElement && node !== document.body) {
      parts.unshift(segment(node));
      const sel = parts.join(" > ");
      try {
        if (document.querySelectorAll(sel).length === 1 || parts[0].startsWith("#")) return sel;
      } catch {}
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  const highlight = (el) => {
    if (!el) return (hl.hidden = true);
    const r = el.getBoundingClientRect();
    Object.assign(hl.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    hl.hidden = false;
  };

  const updateCount = () => {
    try {
      const n = document.querySelectorAll(input.value).length;
      count.textContent = `${n} match${n === 1 ? "" : "es"}`;
      highlight(document.querySelector(input.value));
      ok.disabled = n === 0;
    } catch {
      count.textContent = "invalid";
      ok.disabled = true;
    }
  };

  const onMove = (e) => {
    if (!e.isTrusted || !picking || host.contains(e.target)) return;
    current = e.target;
    highlight(e.target);
  };

  const choose = (el) => {
    picking = false;
    input.value = selectorFor(el);
    input.hidden = ok.hidden = false;
    hint.hidden = true;
    updateCount();
    input.focus();
  };

  const onClick = (e) => {
    if (!e.isTrusted || !picking || e.composedPath().includes(host)) return;
    e.preventDefault();
    e.stopPropagation();
    choose(e.target);
  };

  const stop = () => {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    host.remove();
    window.__mizpahPicker = false;
    try {
      previousFocus?.focus?.();
    } catch {}
  };

  const move = (e) => {
    const base = current || document.body;
    const next = { ArrowUp: base.parentElement, ArrowDown: base.firstElementChild, ArrowLeft: base.previousElementSibling, ArrowRight: base.nextElementSibling }[e.key];
    if (!next || host.contains(next)) return;
    current = next;
    current.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    highlight(current);
  };

  const onKey = (e) => {
    if (!e.isTrusted) return;
    if (e.key === "Escape") return stop();
    const active = shadow.activeElement;
    if (picking) {
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        e.stopPropagation();
        move(e);
      } else if (e.key === "Enter" && current && (!active || active === bar)) {
        e.preventDefault();
        e.stopPropagation();
        choose(current);
      }
    } else if (e.key === "Enter" && active === input && !ok.disabled) {
      ok.click();
    }
  };

  input.addEventListener("input", updateCount);
  cancel.addEventListener("click", stop);
  ok.addEventListener("click", () => {
    const selector = input.value.trim();
    const hostname = location.hostname.replace(/^www\./, "");
    document.querySelectorAll(selector).forEach((el) => el.style.setProperty("display", "none", "important"));
    try {
      chrome.runtime.sendMessage({ type: "addFilter", line: `${hostname}##${selector}` }).catch((err) => console.warn("could not save filter", err));
    } catch (err) {
      console.warn("could not save filter", err);
    }
    stop();
  });
  bar.addEventListener("click", (e) => e.stopPropagation());

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  bar.focus();
})();
