import { LISTS, parseFilterList, groupCosmetic, ruleKey, plainAdDomains } from "../lib/filters.js";
import { readSettings } from "./settings.js";
import { APP_NAME, DYNAMIC_LIMIT, DISABLED_STATIC_LIMIT, customFilters, queueApply } from "./apply.js";
import { remoteCosmeticKey, forgetRemoteCosmetic } from "./cosmetic.js";
import { forgetPopupMatcher } from "./popup-guard.js";

const IS_STORE_INSTALL = "update_url" in chrome.runtime.getManifest();
const UPDATE_ALARM = "refresh-lists";
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_SLACK_MS = 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const REBUILD_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const REBUILD_NOTIFICATION = "rebuild-needed";
export const REMOTE_STORAGE_KEYS = ["remoteNetwork", "remoteDisabled", "remotePopup", "listUpdate", "remoteCosmetic", ...LISTS.map((l) => remoteCosmeticKey(l.id))];

export async function readJson(path) {
  return (await fetch(chrome.runtime.getURL(path))).json();
}

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function downloadList(list) {
  const bundled = fetch(chrome.runtime.getURL(`filters/${list.id}.txt`)).then((r) => r.text());
  return (await Promise.all([bundled, ...list.sources.map(fetchText)])).join("\n");
}

const shippedRules = (listId) =>
  Promise.all([listId, `${listId}-extra`].map(async (rulesetId) => ({ rulesetId, rules: await readJson(`rules/${rulesetId}.json`) })));

async function refreshLists() {
  const stored = await chrome.storage.local.get(["remoteNetwork", "remoteDisabled", "listUpdate"]);
  const remoteNetwork = stored.remoteNetwork || {};
  const remoteDisabled = stored.remoteDisabled || {};
  const status = { ...stored.listUpdate, lastChecked: Date.now(), errors: [], lists: { ...stored.listUpdate?.lists } };
  const update = {};
  const popupByList = {};
  const downloads = await Promise.allSettled(LISTS.map(downloadList));

  for (const [i, list] of LISTS.entries()) {
    try {
      if (downloads[i].status === "rejected") throw downloads[i].reason;
      const parsed = parseFilterList(downloads[i].value);
      const fresh = new Map(parsed.network.map((r) => [ruleKey(r), r]));
      const shippedKeys = new Set();
      const disabled = {};
      let removed = 0;
      for (const { rulesetId, rules } of await shippedRules(list.id)) {
        for (const r of rules) {
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
      update[remoteCosmeticKey(list.id)] = groupCosmetic(parsed.cosmetic);
      popupByList[list.id] = { entries: parsed.popups, adDomains: list.id === "ads" ? plainAdDomains(parsed.network) : [] };
      status.lists[list.id] = { updated: Date.now(), added: remoteNetwork[list.id].length, removed, total: fresh.size };
    } catch (err) {
      status.errors.push(`${list.name}: ${err.message}`);
    }
  }
  if (status.errors.length < LISTS.length) status.lastSuccess = Date.now();

  const settings = await readSettings();
  const used = settings.allowlist.length + customFilters(settings.customFilters).rules.length;
  status.rebuild = await rebuildReasons(status, DYNAMIC_LIMIT - used);

  Object.assign(update, { remoteNetwork, remoteDisabled, listUpdate: status });
  if (Object.keys(popupByList).length === LISTS.length) {
    const lists = Object.values(popupByList);
    update.remotePopup = { entries: lists.flatMap((p) => p.entries), adDomains: [...new Set(lists.flatMap((p) => p.adDomains))] };
  }
  await chrome.storage.local.set(update);
  forgetPopupMatcher();
  forgetRemoteCosmetic();
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
  const info = await readJson("rules/build-info.json").catch(() => null);
  if (info && !info.remote) reasons.push("built without the full EasyList lists");
  else if (info && Date.now() - info.builtAt > REBUILD_AGE_MS) reasons.push(`built-in rules are ${Math.floor((Date.now() - info.builtAt) / 86400000)} days old`);
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

let refreshInFlight = null;

export function refreshOnce() {
  refreshInFlight ||= refreshLists().finally(() => (refreshInFlight = null));
  return refreshInFlight;
}

export const isRefreshing = () => !!refreshInFlight;

export async function maybeAutoRefresh() {
  const { autoUpdate } = await readSettings();
  const { listUpdate } = await chrome.storage.local.get("listUpdate");
  if (autoUpdate && Date.now() - (listUpdate?.lastSuccess || 0) > UPDATE_INTERVAL_MS - UPDATE_SLACK_MS) await refreshOnce();
}

export async function ensureAlarm() {
  if (!(await chrome.alarms.get(UPDATE_ALARM))) {
    await chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 5, periodInMinutes: 60 });
  }
}

export const isUpdateAlarm = (alarm) => alarm.name === UPDATE_ALARM;
