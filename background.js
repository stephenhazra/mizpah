import { LISTS, parseFilterList, toRules, groupCosmetic, hostCandidates, ruleKey, plainAdDomains } from "./lib/filters.js";
import { compilePopupFilters, matchPopup, registrableDomain, hostOf } from "./lib/popup.js";

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
  await chrome.scripting.registerContentScripts(scripts);
}

async function applyAll() {
  const settings = await getSettings();
  await Promise.all([applyDynamicRules(settings), applyRulesets(settings), applyContentScripts(settings)]);
  await chrome.declarativeNetRequest.setExtensionActionOptions({
    displayActionCountAsBadgeText: settings.enabled
  });
  await chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
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
  await chrome.scripting.insertCSS({ target: { tabId, frameIds: [frameId] }, css, origin: "USER" });
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
  chrome.notifications.create(REBUILD_NOTIFICATION, {
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
  }
  info.domains.add(domain);
  const matcher = await getPopupMatcher();
  if (matchPopup(matcher, url, info.openerHost)) return closePopup(tabId, info, "filter");
  if (!info.intended && info.domains.size >= POPUP_HOP_LIMIT) return closePopup(tabId, info, "redirect chain");
}

chrome.webNavigation.onCreatedNavigationTarget.addListener(async (d) => {
  const settings = await getSettings();
  if (!settings.enabled || !settings.blockPopups) return;
  let openerUrl = "";
  try {
    openerUrl = (await chrome.tabs.get(d.sourceTabId)).url || "";
  } catch {}
  const openerHost = hostOf(openerUrl);
  if (!openerHost || isAllowlisted(openerHost, settings.allowlist)) return;
  const click = lastClicks.get(d.sourceTabId);
  const intended = !!click && Date.now() - click.time < 3000 && (click.href === d.url || hostOf(click.href) === hostOf(d.url));
  const info = { sourceTabId: d.sourceTabId, openerHost, openerDomain: registrableDomain(openerHost), start: Date.now(), domains: new Set(), intended };
  popupTabs.set(d.tabId, info);
  const early = earlyRequests.get(d.tabId) || [];
  earlyRequests.delete(d.tabId);
  for (const url of [d.url, ...early]) await inspectPopup(d.tabId, url);
});

chrome.webRequest.onBeforeRequest.addListener(
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

chrome.webNavigation.onCommitted.addListener((d) => {
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
    if (sender.tab && typeof msg.href === "string") lastClicks.set(sender.tab.id, { href: msg.href, time: Date.now() });
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

chrome.notifications.onClicked.addListener((id) => {
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
