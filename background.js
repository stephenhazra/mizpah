import { LISTS } from "./lib/filters.js";
import { DEFAULTS, SETTING_KEYS } from "./lib/settings.js";
import { hostCandidates, normalizeHost, isAllowlisted, isHostname } from "./lib/host.js";
import { getSettings, readSettings, saveSettings, forgetSettings } from "./background/settings.js";
import { CUSTOM_RULE_START, REMOTE_RULE_START, customFilters, queueApply, applied } from "./background/apply.js";
import { pageSelectors, tokenSelectors, insertSelectors, forgetRemoteCosmetic, forgetDocuments } from "./background/cosmetic.js";
import { REBUILD_NOTIFICATION, REMOTE_STORAGE_KEYS, readJson, refreshOnce, isRefreshing, maybeAutoRefresh, ensureAlarm, isUpdateAlarm } from "./background/lists.js";
import { recordClick, popupCount, forgetPopupMatcher } from "./background/popup-guard.js";

const APPLY_KEYS = [...SETTING_KEYS, "remoteNetwork", "remoteDisabled"];

async function tabBlockedCount(tabId) {
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
    return rulesMatchedInfo.filter((m) => m.rule.rulesetId !== "_dynamic" || m.rule.ruleId >= CUSTOM_RULE_START).length;
  } catch {
    return null;
  }
}

async function toggleHost(key, hostname, on) {
  if (typeof hostname !== "string" || !isHostname(normalizeHost(hostname))) return false;
  const settings = await readSettings();
  const hosts = new Set(settings[key]);
  if (on) hosts.add(normalizeHost(hostname));
  else for (const h of hostCandidates(hostname)) hosts.delete(h);
  await saveSettings({ [key]: [...hosts].sort() });
  await queueApply();
  return true;
}

function pageHostname(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? normalizeHost(u.hostname) : "";
  } catch {
    return "";
  }
}

async function ruleCounts() {
  const info = await readJson("rules/build-info.json").catch(() => ({}));
  const counts = {};
  for (const list of LISTS) {
    counts[list.id] = info.counts?.[list.id];
    if (counts[list.id] == null) {
      const files = await Promise.all([list.id, `${list.id}-extra`].map((file) => readJson(`rules/${file}.json`)));
      counts[list.id] = files.reduce((n, rules) => n + rules.length, 0);
    }
  }
  return { counts, builtAt: info.builtAt };
}

const handlers = {
  async cosmetic(msg, sender) {
    if (!sender.tab || typeof msg.hostname !== "string") return 0;
    return insertSelectors(sender, await pageSelectors(msg.hostname));
  },
  async cosmeticTokens(msg, sender) {
    if (!sender.tab || typeof msg.hostname !== "string" || !Array.isArray(msg.tokens)) return 0;
    return insertSelectors(sender, await tokenSelectors(msg.hostname, msg.tokens.filter((t) => typeof t === "string")));
  },
  async userClick(msg, sender) {
    if (sender.tab) recordClick(sender.tab.id, msg.href);
    return true;
  },
  toggleStrictPopups: ({ hostname, strict }) => toggleHost("strictPopupSites", hostname, !!strict),
  toggleSite: ({ hostname, allow }) => toggleHost("allowlist", hostname, !!allow),
  async popupState({ tabId, url }) {
    const settings = await getSettings();
    const { listUpdate } = await chrome.storage.local.get("listUpdate");
    const hostname = pageHostname(url);
    return {
      enabled: settings.enabled,
      hostname,
      allowlisted: hostname ? isAllowlisted(hostname, settings.allowlist) : false,
      blocked: await tabBlockedCount(tabId),
      rebuild: listUpdate?.rebuild || [],
      popupsClosed: popupCount(tabId),
      strictPopups: hostname ? isAllowlisted(hostname, settings.strictPopupSites) : false
    };
  },
  async setEnabled({ enabled }) {
    await saveSettings({ enabled: !!enabled });
    await queueApply();
    return true;
  },
  async addFilter({ line }) {
    if (typeof line !== "string" || line.includes("\n")) return false;
    const { customFilters: text } = await readSettings();
    const lines = text.split("\n").map((l) => l.trim());
    if (!lines.includes(line.trim())) lines.push(line.trim());
    await saveSettings({ customFilters: lines.filter(Boolean).join("\n") });
    await queueApply();
    return true;
  },
  async customStatus() {
    await applied();
    const settings = await readSettings();
    const dynamic = await chrome.declarativeNetRequest.getDynamicRules();
    const networkRules = dynamic.filter((r) => r.id >= CUSTOM_RULE_START && r.id < REMOTE_RULE_START).length;
    return { networkRules, skipped: customFilters(settings.customFilters).skipped };
  },
  async stats() {
    const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
    const { listUpdate } = await chrome.storage.local.get("listUpdate");
    const { counts, builtAt } = await ruleCounts();
    for (const list of LISTS) if (listUpdate?.lists?.[list.id]) counts[list.id] = listUpdate.lists[list.id].total;
    const local = await readJson("rules/local-root.json").catch(() => ({}));
    return { enabled, counts, listUpdate: listUpdate || null, updating: isRefreshing(), extensionPath: local.root, builtAt };
  },
  async clearLearnedPopups() {
    await chrome.storage.local.remove("learnedPopups");
    return true;
  },
  refreshLists: () => refreshOnce()
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg, sender))
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err) }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const keys = Object.keys(changes);
  if (keys.some((k) => k.startsWith("remoteCosmetic"))) forgetRemoteCosmetic();
  if (keys.includes("remotePopup") || keys.includes("learnedPopups")) forgetPopupMatcher();
  if (keys.some((k) => SETTING_KEYS.includes(k))) forgetSettings();
  if (keys.some((k) => APPLY_KEYS.includes(k))) queueApply();
});

chrome.webNavigation?.onCommitted.addListener((d) => {
  if (d.frameId === 0) forgetDocuments(d.tabId);
});
chrome.tabs.onRemoved.addListener(forgetDocuments);

chrome.notifications?.onClicked.addListener((id) => {
  if (id === REBUILD_NOTIFICATION) {
    chrome.runtime.openOptionsPage();
    chrome.notifications.clear(id);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (isUpdateAlarm(alarm)) maybeAutoRefresh().catch((err) => console.error("list update failed", err));
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") await chrome.storage.local.set(DEFAULTS);
  if (reason === "update") await chrome.storage.local.remove(REMOTE_STORAGE_KEYS);
  queueApply();
  ensureAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  queueApply();
  ensureAlarm();
});
