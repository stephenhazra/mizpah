(() => {
  if (window.__mizpahCosmetic) return;
  window.__mizpahCosmetic = true;
  const hostname = location.hostname;
  if (!hostname) return;
  const FLUSH_MS = 100;
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});
  send({ type: "cosmetic", hostname });

  const seen = new Set();
  let pending = [];
  let timer = 0;

  const add = (token) => {
    if (seen.has(token)) return;
    seen.add(token);
    pending.push(token);
  };
  const collect = (el) => {
    if (el.id) add(`#${el.id}`);
    if (el.classList) for (const c of el.classList) add(`.${c}`);
  };
  const scan = (node) => {
    if (node.nodeType !== 1) return;
    collect(node);
    for (const el of node.querySelectorAll("[id],[class]")) collect(el);
  };
  const flush = () => {
    timer = 0;
    if (!pending.length) return;
    const tokens = pending;
    pending = [];
    send({ type: "cosmeticTokens", hostname, tokens });
  };
  const schedule = () => {
    if (pending.length && !timer) timer = setTimeout(flush, FLUSH_MS);
  };

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes") collect(m.target);
      else for (const n of m.addedNodes) scan(n);
    }
    schedule();
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "id"] });

  if (document.documentElement) scan(document.documentElement);
  schedule();
})();
