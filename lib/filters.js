export const LISTS = [
  {
    id: "ads",
    name: "Ads",
    description: "Ad servers, ad networks and ad elements",
    sources: ["https://easylist.to/easylist/easylist.txt"]
  },
  {
    id: "trackers",
    name: "Trackers",
    description: "Analytics, fingerprinting and tracking pixels",
    sources: ["https://easylist.to/easylist/easyprivacy.txt"]
  },
  {
    id: "annoyances",
    name: "Annoyances",
    description: "Cookie banners, newsletter pop-ups and social widgets",
    sources: ["https://secure.fanboy.co.nz/fanboy-annoyance.txt"]
  }
];

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;

export const ruleKey = (r) => JSON.stringify(sortKeys([r.action, r.condition, r.priority]));

export function ruleHash(rule) {
  const key = ruleKey(rule);
  let h1 = 0x811c9dc5;
  let h2 = key.length;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822507) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(36) + "." + (h2 >>> 0).toString(36);
}

const TYPE_MAP = {
  script: "script",
  image: "image",
  stylesheet: "stylesheet",
  css: "stylesheet",
  subdocument: "sub_frame",
  frame: "sub_frame",
  xmlhttprequest: "xmlhttprequest",
  xhr: "xmlhttprequest",
  object: "object",
  "object-subrequest": "object",
  media: "media",
  font: "font",
  ping: "ping",
  beacon: "ping",
  websocket: "websocket",
  webrtc: null,
  other: "other",
  document: "main_frame",
  doc: "main_frame"
};

const IGNORED_OPTIONS = new Set(["genericblock", "collapse", "~collapse"]);
const HIDE_OPTIONS = { generichide: "generic", ghide: "generic", elemhide: "elem", ehide: "elem" };
const INVALID_SELECTOR = /:(has-text|-abp-|xpath|upward|matches-css|matches-path|matches-attr|matches-media|min-text-length|watch-attr|remove|style|others|if|if-not|nth-ancestor|contains|matches-property|remove-attr|remove-class)\b|\(\s*\)/;

const UNSAFE_SELECTOR = /\/\*|\*\/|<!--|-->|[;@"']|\\$/;
const withoutStrings = (s) => s.replace(/\\[\s\S]/g, "_").replace(/"[^"]*"|'[^']*'/g, "");

const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);
const validDomain = (d) => /^[a-z0-9.-]+$/.test(d) && d.includes(".") && !d.startsWith(".") && !d.endsWith(".");

function parseDomains(value, sep) {
  const include = [];
  const exclude = [];
  for (let d of value.split(sep)) {
    d = d.trim().toLowerCase();
    if (!d) continue;
    const neg = d.startsWith("~");
    if (neg) d = d.slice(1);
    if (d.endsWith(".*")) return null;
    if (!validDomain(d)) return null;
    (neg ? exclude : include).push(d);
  }
  return { include, exclude };
}

function parseCosmetic(line, sepIndex, sep) {
  if (/#[?$%]#|#@[?$%]#/.test(line)) return null;
  const domainPart = line.slice(0, sepIndex);
  const selector = line.slice(sepIndex + sep.length).trim();
  if (!selector || INVALID_SELECTOR.test(selector) || selector.startsWith("+js(") || !isAscii(selector)) return null;
  if (/[{}]/.test(selector) || UNSAFE_SELECTOR.test(withoutStrings(selector))) return null;
  let domains = { include: [], exclude: [] };
  if (domainPart) {
    domains = parseDomains(domainPart, ",");
    if (!domains) return null;
  }
  return { selector, exception: sep === "#@#", ...domains };
}

function parseNetwork(line) {
  let exception = false;
  if (line.startsWith("@@")) {
    exception = true;
    line = line.slice(2);
  }
  let pattern = line;
  let options = [];
  const dollar = line.lastIndexOf("$");
  if (dollar !== -1 && !line.slice(dollar + 1).includes("/") && !/^\/.*\/$/.test(line)) {
    pattern = line.slice(0, dollar);
    options = line.slice(dollar + 1).split(",").map((o) => o.trim()).filter(Boolean);
  }
  if (/^\/.+\/$/.test(pattern)) return null;
  if (!isAscii(pattern)) return null;

  const condition = {};
  const types = [];
  const excludedTypes = [];
  let important = false;
  let documentLevel = false;
  let popup = false;
  let hide = null;

  for (const opt of options) {
    const [rawName, ...rest] = opt.split("=");
    const value = rest.join("=");
    const neg = rawName.startsWith("~");
    const name = (neg ? rawName.slice(1) : rawName).toLowerCase();
    if (IGNORED_OPTIONS.has(opt)) continue;
    if (name === "third-party" || name === "3p") {
      condition.domainType = neg ? "firstParty" : "thirdParty";
    } else if (name === "first-party" || name === "1p") {
      condition.domainType = neg ? "thirdParty" : "firstParty";
    } else if (name === "domain" || name === "from") {
      const d = parseDomains(value, "|");
      if (!d) return null;
      if (d.include.length) condition.initiatorDomains = d.include;
      if (d.exclude.length) condition.excludedInitiatorDomains = d.exclude;
    } else if (name === "match-case") {
      condition.isUrlFilterCaseSensitive = true;
    } else if (name === "important") {
      important = true;
    } else if (name in HIDE_OPTIONS) {
      if (!exception) return null;
      hide = HIDE_OPTIONS[name];
    } else if (name === "popup") {
      if (!neg) popup = true;
    } else if (name === "all") {
      types.push("main_frame", "sub_frame", "script", "image", "stylesheet", "xmlhttprequest", "media", "font", "object", "ping", "websocket", "other");
    } else if (name === "document" || name === "doc") {
      if (exception) documentLevel = true;
      else types.push("main_frame");
    } else if (name in TYPE_MAP) {
      const t = TYPE_MAP[name];
      if (!t) return null;
      (neg ? excludedTypes : types).push(t);
    } else {
      return null;
    }
  }

  if (hide) {
    const host = /^\|\|([a-z0-9.-]+)\^?$/.exec(pattern)?.[1];
    const hosts = host ? [host] : condition.initiatorDomains;
    return hosts && !pattern.replace(/^\|\|[a-z0-9.-]+\^?$/, "") ? { hide: { kind: hide, hosts } } : null;
  }

  if (pattern.startsWith("||*")) pattern = pattern.slice(2);
  if (pattern === "*" || pattern === "") pattern = "";
  const core = pattern.replace(/[|^*]/g, "");
  if (!pattern && !condition.initiatorDomains) return null;
  if (pattern && core.length < 3 && !condition.initiatorDomains) return null;

  let popupEntry;
  if (popup) {
    popupEntry = { p: pattern };
    if (condition.initiatorDomains) popupEntry.d = condition.initiatorDomains;
    if (condition.excludedInitiatorDomains) popupEntry.x = condition.excludedInitiatorDomains;
    if (exception) popupEntry.e = 1;
    if (!types.length) return { popup: popupEntry };
  }

  if (pattern) condition.urlFilter = pattern;
  if (types.length) condition.resourceTypes = [...new Set(types)];
  else if (excludedTypes.length) condition.excludedResourceTypes = [...new Set(excludedTypes)];

  let action;
  let priority = 1;
  if (exception && documentLevel) {
    action = { type: "allowAllRequests" };
    condition.resourceTypes = ["main_frame", "sub_frame"];
    delete condition.excludedResourceTypes;
    priority = 2;
  } else if (exception) {
    action = { type: "allow" };
    priority = 2;
  } else {
    action = { type: "block" };
    priority = important ? 3 : 1;
  }
  return { rule: { action, condition, priority }, popup: popupEntry };
}

export function parseFilterList(text) {
  const network = [];
  const popups = [];
  const cosmetic = [];
  let skipped = 0;
  for (let raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("!") || line.startsWith("[")) continue;
    if (line.startsWith("#") && !line.startsWith("##") && !line.startsWith("#@#")) continue;
    const ex = line.indexOf("#@#");
    const hide = line.indexOf("##");
    let parsed = null;
    if (ex !== -1) parsed = parseCosmetic(line, ex, "#@#");
    else if (hide !== -1) parsed = parseCosmetic(line, hide, "##");
    else if (/#[?$%@]#|#@[?$%]#/.test(line)) parsed = null;
    else {
      const res = parseNetwork(line);
      if (res) {
        if (res.rule) network.push(res.rule);
        if (res.popup) popups.push(res.popup);
        if (res.hide) cosmetic.push({ hide: res.hide.kind, include: res.hide.hosts, exclude: [] });
        continue;
      }
    }
    if (parsed) cosmetic.push(parsed);
    else skipped++;
  }
  return { network, cosmetic, popups, skipped };
}

export function toRules(network, startId = 1) {
  const seen = new Set();
  const rules = [];
  let id = startId;
  for (const r of network) {
    const key = ruleKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ id: id++, ...r });
  }
  return rules;
}

export function selectorToken(selector) {
  const m = /^[a-z]*([.#])([\w-]+)(?:[^\w\\-]|$)/i.exec(selector);
  return m ? m[1] + m[2] : null;
}

export function groupCosmetic(entries) {
  const out = { generic: [], genericTokens: {}, specific: {}, exceptions: {}, genericExceptions: [], genericHide: {}, elemHide: {} };
  const push = (map, key, sel) => (map[key] ||= []).push(sel);
  for (const e of entries) {
    if (e.hide) {
      for (const d of e.include) out[e.hide === "elem" ? "elemHide" : "genericHide"][d] = 1;
    } else if (e.exception) {
      if (e.include.length) e.include.forEach((d) => push(out.exceptions, d, e.selector));
      else out.genericExceptions.push(e.selector);
    } else if (e.include.length) {
      e.include.forEach((d) => push(out.specific, d, e.selector));
    } else if (e.exclude.length) {
      out.generic.push(e.selector);
      e.exclude.forEach((d) => push(out.exceptions, d, e.selector));
    } else {
      out.generic.push(e.selector);
    }
  }
  const complex = [];
  for (const sel of new Set(out.generic)) {
    const token = selectorToken(sel);
    if (token) push(out.genericTokens, token, sel);
    else complex.push(sel);
  }
  out.generic = complex;
  return out;
}

export function plainAdDomains(network) {
  const out = [];
  for (const r of network) {
    if (r.action.type !== "block") continue;
    const keys = Object.keys(r.condition);
    if (keys.some((k) => k !== "urlFilter" && k !== "domainType")) continue;
    const m = /^\|\|([a-z0-9.-]+\.[a-z]{2,})\^$/.exec(r.condition.urlFilter || "");
    if (m) out.push(m[1]);
  }
  return out;
}
