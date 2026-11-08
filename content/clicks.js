(() => {
  if (window.__mizpahClicks) return;
  window.__mizpahClicks = true;

  const intendedHref = (e) => {
    const a = e.composedPath().find((n) => n instanceof Element && n.matches("a[href]"));
    if (!a) return null;
    const r = a.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || getComputedStyle(a).opacity === "0") return null;
    return a.href;
  };
  const reportClick = (e) => {
    if (!e.isTrusted || (e.type === "auxclick" && e.button !== 1)) return;
    chrome.runtime.sendMessage({ type: "userClick", href: intendedHref(e) }).catch(() => {});
  };
  document.addEventListener("click", reportClick, true);
  document.addEventListener("auxclick", reportClick, true);
})();
