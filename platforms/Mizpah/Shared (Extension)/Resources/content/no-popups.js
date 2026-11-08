(() => {
  const noop = () => {};
  const fakeWindow = () => ({
    closed: false,
    close: noop,
    focus: noop,
    blur: noop,
    postMessage: noop,
    document: null,
    opener: window,
    location: { href: "about:blank", assign: noop, replace: noop, reload: noop }
  });
  const open = function () {
    return fakeWindow();
  };
  try {
    Object.defineProperty(window, "open", { value: open, writable: false, configurable: false });
  } catch {
    window.open = open;
  }
  const opensElsewhere = (target, url) => {
    if (!/^_?blank$/i.test(target || "")) return false;
    try {
      return new URL(url || location.href, location.href).origin !== location.origin;
    } catch {
      return false;
    }
  };
  const blankTarget = (a) => !!a && opensElsewhere(a.target, a.href);
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (blankTarget(this) && !this.isConnected) return;
    return origClick.call(this);
  };
  const origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    if (opensElsewhere(this.target, this.action)) return;
    return origSubmit.call(this);
  };
  document.addEventListener(
    "submit",
    (e) => {
      if (!e.isTrusted && opensElsewhere(e.target.target, e.target.action)) e.preventDefault();
    },
    true
  );
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
