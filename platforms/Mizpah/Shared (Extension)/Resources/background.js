(() => {
const LISTS = [
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

const ruleKey = (r) => JSON.stringify([r.action, r.condition, r.priority]);

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
const INVALID_SELECTOR = /:(has-text|-abp-|xpath|upward|matches-css|matches-path|matches-attr|matches-media|min-text-length|watch-attr|remove|style|others|if|if-not|nth-ancestor|contains|matches-property|remove-attr|remove-class)\b|\(\s*\)/;

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
  if (/[{}]/.test(selector)) return null;
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

function parseFilterList(text) {
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
        continue;
      }
    }
    if (parsed) cosmetic.push(parsed);
    else skipped++;
  }
  return { network, cosmetic, popups, skipped };
}

function toRules(network, startId = 1) {
  const seen = new Set();
  const rules = [];
  let id = startId;
  for (const r of network) {
    const key = JSON.stringify(r);
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ id: id++, ...r });
  }
  return rules;
}

function selectorToken(selector) {
  const m = /^[a-z]*([.#])([\w-]+)(?:[^\w\\-]|$)/i.exec(selector);
  return m ? m[1] + m[2] : null;
}

function groupCosmetic(entries) {
  const out = { generic: [], genericTokens: {}, specific: {}, exceptions: {}, genericExceptions: [] };
  const push = (map, key, sel) => (map[key] ||= []).push(sel);
  for (const e of entries) {
    if (e.exception) {
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

function hostCandidates(hostname) {
  const parts = hostname.toLowerCase().replace(/^www\./, "").split(".");
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
}

function plainAdDomains(network) {
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

const MULTI_TLD = /\.(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/;

function registrableDomain(host) {
  host = (host || "").toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".");
  const keep = MULTI_TLD.test(host) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const PLAIN_DOMAIN = /^\|\|([a-z0-9.-]+)\^?$/;

function toRegex(pattern) {
  let re = "";
  let i = 0;
  if (pattern.startsWith("||")) {
    re = "^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*\\.)?";
    i = 2;
  } else if (pattern.startsWith("|")) {
    re = "^";
    i = 1;
  }
  let end = "";
  let body = pattern.slice(i);
  if (body.endsWith("|")) {
    body = body.slice(0, -1);
    end = "$";
  }
  for (const ch of body) {
    if (ch === "*") re += ".*";
    else if (ch === "^") re += "(?:[^\\w.%-]|$)";
    else re += ch.replace(/[.+?${}()[\]\\/]/g, "\\$&");
  }
  return new RegExp(re + end, "i");
}

function compilePopupFilters(entries, adDomains = []) {
  const domains = new Map();
  const patterns = [];
  const exceptions = [];
  for (const e of entries) {
    const plain = PLAIN_DOMAIN.exec(e.p || "");
    if (plain && !e.d && !e.x && !e.e) {
      domains.set(plain[1], true);
      continue;
    }
    if (!e.p) continue;
    let re;
    try {
      re = toRegex(e.p);
    } catch {
      continue;
    }
    (e.e ? exceptions : patterns).push({ re, d: e.d, x: e.x });
  }
  for (const d of adDomains) domains.set(d, true);
  return { domains, patterns, exceptions };
}

const suffixes = (host) => {
  const parts = host.split(".");
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
};

const domainOk = (entry, openerHost) => {
  const opener = suffixes(openerHost);
  if (entry.x && entry.x.some((d) => opener.includes(d))) return false;
  if (entry.d && !entry.d.some((d) => opener.includes(d))) return false;
  return true;
};

function matchPopup(compiled, url, openerHost) {
  const host = hostOf(url);
  if (!host) return false;
  if (compiled.exceptions.some((e) => domainOk(e, openerHost) && e.re.test(url))) return false;
  if (suffixes(host).some((s) => compiled.domains.has(s))) return true;
  return compiled.patterns.some((e) => domainOk(e, openerHost) && e.re.test(url));
}


const APP_NAME = chrome.runtime.getManifest().short_name;
const IS_STORE_INSTALL = "update_url" in chrome.runtime.getManifest();

const DEFAULTS = {
  enabled: true,
  enabledLists: LISTS.map((l) => l.id),
  allowlist: [],
  customFilters: "",
  youtube: true,
  autoUpdate: true,
  blockPopups: true,
  strictPopupSites: []
};
const REMOTE_KEYS = ["remoteNetwork", "remoteDisabled"];
const POPUP_WINDOW_MS = 15000;
const POPUP_HOP_LIMIT = 3;
const LEARNED_POPUP_LIMIT = 1000;
const DYNAMIC_LIMIT = 30000;
const DISABLED_STATIC_LIMIT = 5000;
const REMOTE_RULE_START = 100000;
const UPDATE_ALARM = "refresh-lists";
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REBUILD_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REBUILD_NOTIFICATION = "rebuild-needed";
const ALLOWLIST_PRIORITY = 100;
const CUSTOM_RULE_START = 10000;
const MAX_CUSTOM_RULES = 25000;

let bundledCosmetic = null;
let remoteCosmetic = null;
let customCosmetic = groupCosmetic([]);
let customErrors = 0;

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

async function loadBundledCosmetic() {
  if (!bundledCosmetic) {
    const res = await fetch(chrome.runtime.getURL("rules/cosmetic.json"));
    bundledCosmetic = await res.json();
  }
  return bundledCosmetic;
}

async function loadRemoteCosmetic() {
  if (!remoteCosmetic) remoteCosmetic = (await chrome.storage.local.get("remoteCosmetic")).remoteCosmetic || {};
  return remoteCosmetic;
}

const normalizeHost = (h) => h.toLowerCase().replace(/^www\./, "");

function isAllowlisted(hostname, allowlist) {
  const candidates = hostCandidates(hostname);
  return allowlist.some((d) => candidates.includes(d));
}

async function applyDynamicRules(settings) {
  const rules = [];
  settings.allowlist.forEach((domain, i) => {
    rules.push({
      id: i + 1,
      priority: ALLOWLIST_PRIORITY,
      action: { type: "allowAllRequests" },
      condition: { requestDomains: [domain], resourceTypes: ["main_frame", "sub_frame"] }
    });
  });

  const parsed = parseFilterList(settings.customFilters || "");
  customErrors = parsed.skipped;
  customCosmetic = groupCosmetic(parsed.cosmetic);
  const custom = toRules(parsed.network, CUSTOM_RULE_START)
    .slice(0, MAX_CUSTOM_RULES)
    .map((r) => ({ ...r, priority: r.priority + 10 }));
  rules.push(...custom);

  const { remoteNetwork = {} } = await chrome.storage.local.get("remoteNetwork");
  let nextId = REMOTE_RULE_START;
  for (const id of settings.enabledLists) {
    for (const r of remoteNetwork[id] || []) {
      if (rules.length >= DYNAMIC_LIMIT) break;
      rules.push({ id: nextId++, ...r });
    }
  }

  const desired = new Map((settings.enabled ? rules : []).map((r) => [r.id, r]));
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const existingKeys = new Map(existing.map((r) => [r.id, ruleKey(r)]));
  const removeRuleIds = existing.filter((r) => desired.get(r.id) === undefined || ruleKey(desired.get(r.id)) !== existingKeys.get(r.id)).map((r) => r.id);
  const addRules = [...desired.values()].filter((r) => existingKeys.get(r.id) !== ruleKey(r));
  if (removeRuleIds.length || addRules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  }
}

async function applyRulesets(settings) {
  const active = settings.enabled ? settings.enabledLists.flatMap((id) => [id, `${id}-extra`]) : [];
  const current = await chrome.declarativeNetRequest.getEnabledRulesets();
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: active.filter((id) => !current.includes(id)),
    disableRulesetIds: current.filter((id) => !active.includes(id))
  });

  const dnr = chrome.declarativeNetRequest;
  if (typeof dnr.updateStaticRules !== "function" || typeof dnr.getDisabledRuleIds !== "function") return;
  const { remoteDisabled = {} } = await chrome.storage.local.get("remoteDisabled");
  let budget = DISABLED_STATIC_LIMIT;
  for (const list of LISTS) {
    for (const rulesetId of [list.id, `${list.id}-extra`]) {
      const want = (remoteDisabled[list.id]?.[rulesetId] || []).slice(0, budget);
      budget -= want.length;
      const have = await chrome.declarativeNetRequest.getDisabledRuleIds({ rulesetId });
      const wantSet = new Set(want);
      const haveSet = new Set(have);
      const disableRuleIds = want.filter((id) => !haveSet.has(id));
      const enableRuleIds = have.filter((id) => !wantSet.has(id));
      if (disableRuleIds.length || enableRuleIds.length) {
        await chrome.declarativeNetRequest.updateStaticRules({ rulesetId, disableRuleIds, enableRuleIds });
      }
    }
  }
}

function excludeMatchesFor(allowlist) {
  return allowlist
    .filter((d) => !d.includes(":"))
    .map((d) => (/^[\d.]+$/.test(d) ? `*://${d}/*` : `*://*.${d}/*`));
}

async function applyContentScripts(settings) {
  const registered = await chrome.scripting.getRegisteredContentScripts();
  if (registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: registered.map((s) => s.id) });
  }
  if (!settings.enabled) return;
  const excludeMatches = excludeMatchesFor(settings.allowlist);
  const scripts = [
    {
      id: "cosmetic",
      js: ["content/cosmetic.js"],
      matches: ["<all_urls>"],
      excludeMatches,
      runAt: "document_start",
      allFrames: true,
      persistAcrossSessions: true
    }
  ];
  const strict = settings.strictPopupSites.filter((d) => !isAllowlisted(d, settings.allowlist));
  if (strict.length) {
    scripts.push({
      id: "no-popups",
      js: ["content/no-popups.js"],
      matches: excludeMatchesFor(strict),
      runAt: "document_start",
      world: "MAIN",
      allFrames: true,
      persistAcrossSessions: true
    });
  }
  if (settings.youtube && settings.enabledLists.includes("ads")) {
    scripts.push(
      {
        id: "yt-main",
        js: ["content/youtube-main.js"],
        matches: ["*://*.youtube.com/*"],
        excludeMatches,
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
        persistAcrossSessions: true
      },
      {
        id: "yt-skip",
        js: ["content/youtube-skip.js"],
        matches: ["*://*.youtube.com/*"],
        excludeMatches,
        runAt: "document_idle",
        persistAcrossSessions: true
      }
    );
  }
  try {
    await chrome.scripting.registerContentScripts(scripts);
  } catch {
    for (const { persistAcrossSessions, ...script } of scripts) {
      try {
        await chrome.scripting.registerContentScripts([script]);
      } catch (err) {
        console.warn(`content script ${script.id} unsupported here`, err);
      }
    }
  }
}

async function applyAll() {
  const settings = await getSettings();
  await Promise.all([applyDynamicRules(settings), applyRulesets(settings), applyContentScripts(settings)]);
  await chrome.declarativeNetRequest.setExtensionActionOptions?.({
    displayActionCountAsBadgeText: settings.enabled
  });
  await chrome.action.setBadgeBackgroundColor?.({ color: "#c0392b" });
  await chrome.action.setTitle({ title: settings.enabled ? APP_NAME : `${APP_NAME} (paused)` });
}

let applying = Promise.resolve();
function queueApply() {
  applying = applying.then(applyAll).catch((err) => console.error("apply failed", err));
  return applying;
}

async function cosmeticContext(hostname) {
  const settings = await getSettings();
  if (!settings.enabled || isAllowlisted(hostname, settings.allowlist)) return null;
  const bundled = await loadBundledCosmetic();
  const remote = await loadRemoteCosmetic();
  await ready;
  const sources = [...settings.enabledLists.map((id) => remote[id] || bundled[id]).filter(Boolean), customCosmetic];
  const candidates = hostCandidates(hostname);
  const exceptions = new Set();
  for (const src of sources) {
    src.genericExceptions.forEach((s) => exceptions.add(s));
    for (const host of candidates) (src.exceptions[host] || []).forEach((s) => exceptions.add(s));
  }
  return { sources, candidates, exceptions };
}

async function cosmeticSelectorsFor(hostname) {
  const ctx = await cosmeticContext(hostname);
  if (!ctx) return [];
  const selectors = new Set();
  for (const src of ctx.sources) {
    src.generic.forEach((s) => selectors.add(s));
    for (const host of ctx.candidates) (src.specific[host] || []).forEach((s) => selectors.add(s));
  }
  return [...selectors].filter((s) => !ctx.exceptions.has(s));
}

async function tokenSelectorsFor(hostname, tokens) {
  const ctx = await cosmeticContext(hostname);
  if (!ctx) return [];
  const selectors = new Set();
  for (const src of ctx.sources) {
    for (const t of tokens) (src.genericTokens[t] || []).forEach((s) => selectors.add(s));
  }
  return [...selectors].filter((s) => !ctx.exceptions.has(s));
}

async function insertSelectors(tabId, frameId, selectors) {
  if (!selectors.length) return 0;
  const css = selectors.map((s) => `${s}{display:none!important}`).join("\n");
  const target = { tabId, frameIds: [frameId] };
  try {
    await chrome.scripting.insertCSS({ target, css, origin: "USER" });
  } catch {
    await chrome.scripting.insertCSS({ target, css });
  }
  return selectors.length;
}

async function tabBlockedCount(tabId) {
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
    return rulesMatchedInfo.filter((m) => m.rule.rulesetId !== "_dynamic" || m.rule.ruleId >= CUSTOM_RULE_START).length;
  } catch {
    return null;
  }
}

async function readJson(path) {
  return (await fetch(chrome.runtime.getURL(path))).json();
}

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

let refreshing = null;

async function refreshLists() {
  const stored = await chrome.storage.local.get(["remoteNetwork", "remoteDisabled", "remoteCosmetic", "listUpdate"]);
  const remoteNetwork = stored.remoteNetwork || {};
  const remoteDisabled = stored.remoteDisabled || {};
  const remoteCosmeticNext = stored.remoteCosmetic || {};
  const popupByList = {};
  const status = { ...(stored.listUpdate || {}), lastChecked: Date.now(), errors: [], lists: { ...(stored.listUpdate?.lists || {}) } };

  for (const list of LISTS) {
    try {
      const texts = [await (await fetch(chrome.runtime.getURL(`filters/${list.id}.txt`))).text()];
      for (const url of list.sources) texts.push(await fetchText(url));
      const parsed = parseFilterList(texts.join("\n"));
      const fresh = new Map(parsed.network.map((r) => [ruleKey(r), r]));
      const shippedKeys = new Set();
      const disabled = {};
      let removed = 0;
      for (const rulesetId of [list.id, `${list.id}-extra`]) {
        for (const r of await readJson(`rules/${rulesetId}.json`)) {
          const key = ruleKey(r);
          shippedKeys.add(key);
          if (!fresh.has(key)) {
            (disabled[rulesetId] ||= []).push(r.id);
            removed++;
          }
        }
      }
      remoteNetwork[list.id] = [...fresh].filter(([key]) => !shippedKeys.has(key)).map(([, r]) => r);
      remoteDisabled[list.id] = disabled;
      remoteCosmeticNext[list.id] = groupCosmetic(parsed.cosmetic);
      popupByList[list.id] = { entries: parsed.popups, adDomains: list.id === "ads" ? plainAdDomains(parsed.network) : [] };
      status.lists[list.id] = { updated: Date.now(), added: remoteNetwork[list.id].length, removed, total: fresh.size };
    } catch (err) {
      status.errors.push(`${list.name}: ${err.message}`);
    }
  }
  if (status.errors.length < LISTS.length) status.lastSuccess = Date.now();

  const settings = await getSettings();
  const used = settings.allowlist.length + toRules(parseFilterList(settings.customFilters || "").network).length;
  status.rebuild = await rebuildReasons(status, DYNAMIC_LIMIT - used);

  const update = { remoteNetwork, remoteDisabled, remoteCosmetic: remoteCosmeticNext, listUpdate: status };
  if (Object.keys(popupByList).length === LISTS.length) {
    update.remotePopup = {
      entries: Object.values(popupByList).flatMap((p) => p.entries),
      adDomains: [...new Set(Object.values(popupByList).flatMap((p) => p.adDomains))]
    };
  }
  await chrome.storage.local.set(update);
  popupMatcher = null;
  remoteCosmetic = remoteCosmeticNext;
  await queueApply();
  await notifyRebuild(status.rebuild);
  return status;
}

async function rebuildReasons(status, capacity) {
  const reasons = [];
  if (IS_STORE_INSTALL) return reasons;
  const lists = Object.values(status.lists || {});
  const added = lists.reduce((n, l) => n + l.added, 0);
  const removed = lists.reduce((n, l) => n + l.removed, 0);
  if (added > capacity) reasons.push(`${(added - capacity).toLocaleString()} new rules don't fit until you rebuild`);
  if (removed > DISABLED_STATIC_LIMIT) reasons.push(`${(removed - DISABLED_STATIC_LIMIT).toLocaleString()} retired rules are still active`);
  try {
    const info = await readJson("rules/build-info.json");
    if (!info.remote) reasons.push("built without the full EasyList lists");
    else if (Date.now() - info.builtAt > REBUILD_AGE_MS) reasons.push(`built-in rules are ${Math.floor((Date.now() - info.builtAt) / 86400000)} days old`);
  } catch {}
  return reasons;
}

async function notifyRebuild(reasons) {
  const { rebuildNotified } = await chrome.storage.local.get("rebuildNotified");
  const key = reasons.map((r) => r.replace(/[\d,]+/g, "#")).join("|");
  if (!reasons.length) {
    if (rebuildNotified) await chrome.storage.local.remove("rebuildNotified");
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  await chrome.action.setBadgeText({ text: "!" });
  if (rebuildNotified === key) return;
  await chrome.storage.local.set({ rebuildNotified: key });
  chrome.notifications?.create(REBUILD_NOTIFICATION, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `${APP_NAME} needs a rebuild`,
    message: `${reasons.join(". ")}. Open Settings for the command to run.`,
    priority: 1
  });
}

function refreshOnce() {
  refreshing ||= refreshLists().finally(() => (refreshing = null));
  return refreshing;
}

async function maybeAutoRefresh() {
  const { autoUpdate } = await getSettings();
  const { listUpdate } = await chrome.storage.local.get("listUpdate");
  if (autoUpdate && Date.now() - (listUpdate?.lastSuccess || 0) > UPDATE_INTERVAL_MS - 60 * 60 * 1000) {
    await refreshOnce();
  }
}

async function ensureAlarm() {
  if (!(await chrome.alarms.get(UPDATE_ALARM))) {
    await chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 5, periodInMinutes: 60 });
  }
}


let popupMatcher = null;

async function getPopupMatcher() {
  if (!popupMatcher) {
    const bundled = await readJson("rules/popup.json");
    const { remotePopup, learnedPopups = [] } = await chrome.storage.local.get(["remotePopup", "learnedPopups"]);
    const src = remotePopup || bundled;
    popupMatcher = compilePopupFilters(src.entries, [...src.adDomains, ...learnedPopups]);
  }
  return popupMatcher;
}

const popupTabs = new Map();
const earlyRequests = new Map();
const lastClicks = new Map();
const popupCounts = new Map();

async function learnPopupDomain(domain) {
  if (!domain) return;
  const { learnedPopups = [] } = await chrome.storage.local.get("learnedPopups");
  if (learnedPopups.includes(domain)) return;
  learnedPopups.push(domain);
  await chrome.storage.local.set({ learnedPopups: learnedPopups.slice(-LEARNED_POPUP_LIMIT) });
  popupMatcher?.domains.set(domain, true);
}

async function closePopup(tabId, info, reason) {
  if (info.closed) return;
  info.closed = true;
  popupTabs.delete(tabId);
  try {
    await chrome.tabs.remove(tabId);
  } catch {}
  popupCounts.set(info.sourceTabId, (popupCounts.get(info.sourceTabId) || 0) + 1);
  const { popupsBlocked = 0 } = await chrome.storage.local.get("popupsBlocked");
  await chrome.storage.local.set({ popupsBlocked: popupsBlocked + 1, lastPopup: { url: info.firstUrl, reason, at: Date.now() } });
  if (reason === "redirect chain") await learnPopupDomain(info.firstDomain);
}

async function inspectPopup(tabId, url) {
  const info = popupTabs.get(tabId);
  if (!info || info.closed) return;
  if (Date.now() - info.start > POPUP_WINDOW_MS) {
    popupTabs.delete(tabId);
    return;
  }
  const host = hostOf(url);
  if (!host || !/^https?:/.test(url)) return;
  const domain = registrableDomain(host);
  if (domain === info.openerDomain) return;
  if (!info.firstUrl) {
    info.firstUrl = url;
    info.firstDomain = domain;
    info.intended = !!info.click && (info.click.href === url || hostOf(info.click.href) === host);
  }
  info.domains.add(domain);
  const matcher = await getPopupMatcher();
  if (matchPopup(matcher, url, info.openerHost)) return closePopup(tabId, info, "filter");
  if (!info.intended && info.domains.size >= POPUP_HOP_LIMIT) return closePopup(tabId, info, "redirect chain");
}

const trackedTabs = new Set();

async function trackPopup(tabId, sourceTabId, url) {
  if (trackedTabs.has(tabId)) return;
  trackedTabs.add(tabId);
  setTimeout(() => trackedTabs.delete(tabId), POPUP_WINDOW_MS);
  const settings = await getSettings();
  if (!settings.enabled || !settings.blockPopups) return;
  let openerUrl = "";
  try {
    openerUrl = (await chrome.tabs.get(sourceTabId)).url || "";
  } catch {}
  const openerHost = hostOf(openerUrl);
  if (!openerHost || isAllowlisted(openerHost, settings.allowlist)) return;
  const recent = lastClicks.get(sourceTabId);
  const click = recent && Date.now() - recent.time < 3000 ? recent : null;
  const info = { sourceTabId, openerHost, openerDomain: registrableDomain(openerHost), start: Date.now(), domains: new Set(), click, intended: false };
  popupTabs.set(tabId, info);
  const early = earlyRequests.get(tabId) || [];
  earlyRequests.delete(tabId);
  for (const u of [url, ...early].filter(Boolean)) await inspectPopup(tabId, u);
}

chrome.webNavigation?.onCreatedNavigationTarget?.addListener((d) => trackPopup(d.tabId, d.sourceTabId, d.url));

function recentClickTab(excludeId) {
  let best = null;
  for (const [tabId, click] of lastClicks) {
    if (tabId === excludeId || Date.now() - click.time > 2500) continue;
    if (!best || click.time > best.time) best = { tabId, time: click.time };
  }
  return best?.tabId ?? null;
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id == null) return;
  const opener = tab.openerTabId ?? recentClickTab(tab.id);
  if (opener != null) trackPopup(tab.id, opener, tab.pendingUrl || (tab.url && tab.url !== "about:blank" ? tab.url : ""));
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return;
  if (popupTabs.has(tabId)) inspectPopup(tabId, change.url);
  else if (trackedTabs.has(tabId)) earlyRequests.set(tabId, [...(earlyRequests.get(tabId) || []), change.url].slice(-5));
});

chrome.webRequest?.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    if (popupTabs.has(d.tabId)) {
      inspectPopup(d.tabId, d.url);
    } else if (Date.now() - d.timeStamp < 2000) {
      const list = earlyRequests.get(d.tabId) || [];
      list.push(d.url);
      earlyRequests.set(d.tabId, list.slice(-5));
      setTimeout(() => earlyRequests.delete(d.tabId), 3000);
    }
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

chrome.webNavigation?.onCommitted.addListener((d) => {
  if (d.frameId === 0 && popupTabs.has(d.tabId)) inspectPopup(d.tabId, d.url);
  if (d.frameId === 0 && d.transitionType !== "auto_subframe") popupCounts.delete(d.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  popupTabs.delete(tabId);
  lastClicks.delete(tabId);
  popupCounts.delete(tabId);
});

async function addCustomFilter(line) {
  const { customFilters = "" } = await chrome.storage.local.get("customFilters");
  const lines = customFilters.split("\n").map((l) => l.trim());
  if (!lines.includes(line)) lines.push(line);
  await chrome.storage.local.set({ customFilters: lines.filter(Boolean).join("\n") });
}

const handlers = {
  async cosmetic(msg, sender) {
    if (!sender.tab) return 0;
    return insertSelectors(sender.tab.id, sender.frameId ?? 0, await cosmeticSelectorsFor(msg.hostname));
  },
  async cosmeticTokens(msg, sender) {
    if (!sender.tab || !Array.isArray(msg.tokens)) return 0;
    return insertSelectors(sender.tab.id, sender.frameId ?? 0, await tokenSelectorsFor(msg.hostname, msg.tokens));
  },
  async userClick(msg, sender) {
    if (sender.tab) lastClicks.set(sender.tab.id, { href: typeof msg.href === "string" ? msg.href : null, time: Date.now(), windowId: sender.tab.windowId });
    return true;
  },
  async toggleStrictPopups({ hostname, strict }) {
    const settings = await getSettings();
    const set = new Set(settings.strictPopupSites);
    if (strict) set.add(hostname);
    else for (const h of hostCandidates(hostname)) set.delete(h);
    await chrome.storage.local.set({ strictPopupSites: [...set].sort() });
    await queueApply();
    return true;
  },
  async popupState({ tabId, url }) {
    const settings = await getSettings();
    const { listUpdate } = await chrome.storage.local.get("listUpdate");
    let hostname = "";
    try {
      const u = new URL(url);
      if (/^https?:$/.test(u.protocol)) hostname = normalizeHost(u.hostname);
    } catch {}
    return {
      enabled: settings.enabled,
      hostname,
      allowlisted: hostname ? isAllowlisted(hostname, settings.allowlist) : false,
      blocked: await tabBlockedCount(tabId),
      rebuild: listUpdate?.rebuild || [],
      popupsClosed: popupCounts.get(tabId) || 0,
      strictPopups: hostname ? isAllowlisted(hostname, settings.strictPopupSites) : false
    };
  },
  async toggleSite({ hostname, allow }) {
    const settings = await getSettings();
    const set = new Set(settings.allowlist);
    if (allow) set.add(hostname);
    else for (const h of hostCandidates(hostname)) set.delete(h);
    await chrome.storage.local.set({ allowlist: [...set].sort() });
    await queueApply();
    return true;
  },
  async setEnabled({ enabled }) {
    await chrome.storage.local.set({ enabled });
    await queueApply();
    return true;
  },
  async addFilter({ line }) {
    await addCustomFilter(line);
    await queueApply();
    return true;
  },
  async customStatus() {
    await applying;
    const dynamic = await chrome.declarativeNetRequest.getDynamicRules();
    return { networkRules: dynamic.filter((r) => r.id >= CUSTOM_RULE_START).length, skipped: customErrors };
  },
  async stats() {
    const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
    const { listUpdate } = await chrome.storage.local.get("listUpdate");
    const counts = {};
    for (const list of LISTS) {
      const fresh = listUpdate?.lists?.[list.id];
      if (fresh) {
        counts[list.id] = fresh.total;
        continue;
      }
      counts[list.id] = 0;
      for (const file of [list.id, `${list.id}-extra`]) counts[list.id] += (await readJson(`rules/${file}.json`)).length;
    }
    const info = await readJson("rules/build-info.json").catch(() => ({}));
    const local = await readJson("rules/local-root.json").catch(() => ({}));
    return { enabled, counts, listUpdate: listUpdate || null, updating: !!refreshing, extensionPath: local.root, builtAt: info.builtAt };
  },
  async refreshLists() {
    return refreshOnce();
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg?.type];
  if (!fn) return false;
  Promise.resolve(fn(msg, sender))
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err) }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("remoteCosmetic" in changes) remoteCosmetic = null;
  if ("remotePopup" in changes) popupMatcher = null;
  if (Object.keys(changes).some((k) => k in DEFAULTS || REMOTE_KEYS.includes(k))) queueApply();
});

chrome.notifications?.onClicked.addListener((id) => {
  if (id === REBUILD_NOTIFICATION) {
    chrome.runtime.openOptionsPage();
    chrome.notifications.clear(id);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) maybeAutoRefresh().catch((err) => console.error("list update failed", err));
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") await chrome.storage.local.set(DEFAULTS);
  if (reason === "update") {
    await chrome.storage.local.remove(["remoteNetwork", "remoteDisabled", "remoteCosmetic", "remotePopup", "listUpdate"]);
    remoteCosmetic = null;
  }
  queueApply();
  ensureAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  queueApply();
  ensureAlarm();
});

const ready = getSettings().then((s) => {
  const parsed = parseFilterList(s.customFilters || "");
  customErrors = parsed.skipped;
  customCosmetic = groupCosmetic(parsed.cosmetic);
});

})();
