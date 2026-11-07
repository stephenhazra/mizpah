(() => {
  const AD_KEYS = ["adPlacements", "adSlots", "playerAds", "adBreakHeartbeatParams"];

  const prune = (obj) => {
    if (!obj || typeof obj !== "object") return obj;
    for (const k of AD_KEYS) if (k in obj) delete obj[k];
    if (obj.playerResponse) prune(obj.playerResponse);
    if (Array.isArray(obj)) obj.forEach(prune);
    return obj;
  };

  const hasAds = (o) => o && typeof o === "object" && AD_KEYS.some((k) => k in o || (o.playerResponse && k in o.playerResponse));

  const trap = (name) => {
    let value;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get: () => value,
        set: (v) => {
          value = prune(v);
        }
      });
    } catch {}
  };
  trap("ytInitialPlayerResponse");

  const origParse = JSON.parse;
  JSON.parse = function (...args) {
    const result = origParse.apply(this, args);
    try {
      if (hasAds(result)) prune(result);
    } catch {}
    return result;
  };

  const origJson = Response.prototype.json;
  Response.prototype.json = async function (...args) {
    const result = await origJson.apply(this, args);
    try {
      if (hasAds(result)) prune(result);
    } catch {}
    return result;
  };

  const origText = Response.prototype.text;
  Response.prototype.text = async function (...args) {
    const text = await origText.apply(this, args);
    if (!/"(adPlacements|playerAds|adSlots)"/.test(text)) return text;
    try {
      return JSON.stringify(prune(origParse(text)));
    } catch {
      return text;
    }
  };
})();
