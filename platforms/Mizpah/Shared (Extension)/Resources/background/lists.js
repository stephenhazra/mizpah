import { LISTS, parseFilterList, groupCosmetic, ruleHash, plainAdDomains } from "../lib/filters.js";
import { readSettings } from "./settings.js";
import { APP_NAME, DYNAMIC_LIMIT, DISABLED_STATIC_LIMIT, CAN_DISABLE_STATIC, customFilters, queueApply } from "./apply.js";
import { remoteCosmeticKey, forgetRemoteCosmetic } from "./cosmetic.js";
import { forgetPopupMatcher } from "./popup-guard.js";

const HAS_UPDATE_URL = "update_url" in chrome.runtime.getManifest();
const UPDATE_ALARM = "refresh-lists";
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_SLACK_MS = 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const REBUILD_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LIST_BYTES = 15 * 1024 * 1024;
const MAX_REMOVED_FRACTION = 0.25;
const MIN_KEPT_FRACTION = 0.8;
const BROAD_SELECTOR = /^(\*|(html|body|:root)\s*(,|$))/i;
export const REBUILD_NOTIFICATION = "rebuild-needed";
export const REMOTE_STORAGE_KEYS = ["remoteNetwork", "remoteDisabled", "remoteRetired", "remotePopup", "listUpdate", "remoteCosmetic", ...LISTS.map((l) => remoteCosmeticKey(l.id))];

export async function readJson(path) {
  return (await fetch(chrome.runtime.getURL(path))).json();
}

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get("content-length")) > MAX_LIST_BYTES) throw new Error("list too large");
  const text = await res.text();
  if (text.length > MAX_LIST_BYTES) throw new Error("list too large");
  if (!/^\s*\[Adblock Plus/.test(text) || !/^! Title:/m.test(text.slice(0, 4096))) throw new Error("not a filter list");
  return text;
}

async function downloadList(list) {
  const bundled = fetch(chrome.runtime.getURL(`filters/${list.id}.txt`)).then((r) => r.text());
  return (await Promise.all([bundled, ...list.sources.map(fetchText)])).join("\n");
}

async function shippedKeys(rulesetId) {
  try {
    const flat = await readJson(`rules/keys-${rulesetId}.json`);
    const out = [];
    for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
    return out;
  } catch {
    return (await readJson(`rules/${rulesetId}.json`)).map((r) => [r.id, ruleHash(r)]);
  }
}

const shippedRules = (listId) =>
  Promise.all([listId, `${listId}-extra`].map(async (rulesetId) => ({ rulesetId, keys: await shippedKeys(rulesetId) })));

const isNarrowHost = (filter) => /^\|\|[a-z0-9.-]+\^?$/i.test(filter || "");

function safeRemoteRule(rule) {
  if (rule.action.type === "allowAllRequests") return false;
  const c = rule.condition;
  if (rule.action.type === "block" && c.resourceTypes?.includes("main_frame")) return isNarrowHost(c.urlFilter) || !!c.initiatorDomains?.length;
  return true;
}

const safeCosmetic = (entry) => entry.exception || entry.include?.length || !BROAD_SELECTOR.test(entry.selector);

async function retiredRules(listId, disabled) {
  const out = [];
  for (const [rulesetId, ids] of Object.entries(disabled)) {
    const wanted = new Set(ids);
    for (const r of await readJson(`rules/${rulesetId}.json`)) {
      if (wanted.has(r.id) && r.action.type === "block") out.push({ condition: r.condition, priority: r.priority || 1 });
    }
  }
  return out;
}

async function refreshLists() {
  const stored = await chrome.storage.local.get(["remoteNetwork", "remoteDisabled", "remoteRetired", "listUpdate"]);
  const remoteNetwork = stored.remoteNetwork || {};
  const remoteDisabled = stored.remoteDisabled || {};
  const remoteRetired = stored.remoteRetired || {};
  const status = { ...stored.listUpdate, lastChecked: Date.now(), errors: [], lists: { ...stored.listUpdate?.lists } };
  const update = {};
  const popupByList = {};
  const downloads = await Promise.allSettled(LISTS.map(downloadList));

  for (const [i, list] of LISTS.entries()) {
    try {
      if (downloads[i].status === "rejected") throw downloads[i].reason;
      const parsed = parseFilterList(downloads[i].value);
      const fresh = new Map(parsed.network.map((r) => [ruleHash(r), r]));
      const shipped = new Set();
      const disabled = {};
      let removed = 0;
      for (const { rulesetId, keys } of await shippedRules(list.id)) {
        for (const [id, hash] of keys) {
          shipped.add(hash);
          if (!fresh.has(hash)) {
            (disabled[rulesetId] ||= []).push(id);
            removed++;
          }
        }
      }
      if (shipped.size && (removed > shipped.size * MAX_REMOVED_FRACTION || fresh.size < shipped.size * MIN_KEPT_FRACTION)) {
        throw new Error(`update would drop ${removed.toLocaleString()} of ${shipped.size.toLocaleString()} rules, kept the current rules`);
      }
      remoteNetwork[list.id] = [...fresh].filter(([hash, r]) => !shipped.has(hash) && safeRemoteRule(r)).map(([, r]) => r);
      if (CAN_DISABLE_STATIC) {
        remoteDisabled[list.id] = disabled;
      } else {
        const retired = await retiredRules(list.id, disabled);
        remoteRetired[list.id] = retired;
      }
      update[remoteCosmeticKey(list.id)] = groupCosmetic(parsed.cosmetic.filter(safeCosmetic));
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

  Object.assign(update, { remoteNetwork, remoteDisabled, remoteRetired, listUpdate: status });
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
  const info = await readJson("rules/build-info.json").catch(() => null);
  if (HAS_UPDATE_URL || info?.store) return reasons;
  const lists = Object.values(status.lists || {});
  const added = lists.reduce((n, l) => n + l.added, 0);
  const removed = lists.reduce((n, l) => n + l.removed, 0);
  if (added > capacity) reasons.push(`${(added - capacity).toLocaleString()} new rules don't fit until you rebuild`);
  if (removed > DISABLED_STATIC_LIMIT) reasons.push(`${(removed - DISABLED_STATIC_LIMIT).toLocaleString()} retired rules are still active`);
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
