(() => {
  if (window.__mizpahClicks) return;
  window.__mizpahClicks = true;

  const intendedHref = (e) => {
    const a = e.composedPath().find((n) => n instanceof Element && n.matches("a[href]"));
    if (!a) return null;
    const r = a.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    if (r.width * r.height > innerWidth * innerHeight * 0.5) return null;
    let opacity = 1;
    for (let el = a; el instanceof Element; el = el.parentElement || el.getRootNode().host) opacity *= Number(getComputedStyle(el).opacity);
    if (opacity < 0.5) return null;
    const hit = e.clientX || e.clientY ? document.elementFromPoint(e.clientX, e.clientY) : a;
    if (hit && !e.composedPath().includes(hit) && !a.contains(hit)) return null;
    return a.href;
  };
  const reportClick = (e) => {
    if (!e.isTrusted || (e.type === "auxclick" && e.button !== 1)) return;
    chrome.runtime.sendMessage({ type: "userClick", href: intendedHref(e) }).catch(() => {});
  };
  document.addEventListener("click", reportClick, true);
  document.addEventListener("auxclick", reportClick, true);
})();
