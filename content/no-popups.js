(() => {
  const fakeWindow = () => {
    const noop = () => {};
    const loc = { href: "about:blank", assign: noop, replace: noop, reload: noop };
    return new Proxy(
      { closed: false, close: noop, focus: noop, blur: noop, postMessage: noop, document: null, opener: window, location: loc },
      { get: (t, k) => (k in t ? t[k] : undefined), set: () => true }
    );
  };
  const open = function () {
    return fakeWindow();
  };
  try {
    Object.defineProperty(window, "open", { value: open, writable: false, configurable: false });
  } catch {
    window.open = open;
  }
  const blankTarget = (a) => a && /^_?blank$/i.test(a.target || "") && new URL(a.href, location.href).origin !== location.origin;
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (blankTarget(this) && !this.isConnected) return;
    return origClick.call(this);
  };
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target?.closest?.("a[href]");
      if (!e.isTrusted && blankTarget(a)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );
})();
