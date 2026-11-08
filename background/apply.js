import { LISTS, parseFilterList, toRules, groupCosmetic, ruleKey } from "../lib/filters.js";
import { isAllowlisted, isSiteHost } from "../lib/host.js";
import { readSettings } from "./settings.js";

export const APP_NAME = chrome.runtime.getManifest().short_name;
export const CUSTOM_RULE_START = 10000;
export const REMOTE_RULE_START = 100000;
const dnr = chrome.declarativeNetRequest;
const IS_SAFARI = /Safari\//.test(navigator.userAgent) && !/Chrome\/|Chromium\//.test(navigator.userAgent);
const SAFARI_RULE_CAP = 150000;
const SAFARI_RULE_MARGIN = 2000;
export const DYNAMIC_LIMIT = Math.min(30000, dnr.MAX_NUMBER_OF_DYNAMIC_RULES ?? dnr.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES ?? (IS_SAFARI ? 30000 : 5000));
export const CAN_DISABLE_STATIC = typeof dnr.updateStaticRules === "function" && typeof dnr.getDisabledRuleIds === "function";
export const DISABLED_STATIC_LIMIT = 5000;
const ALLOWLIST_PRIORITY = 100;
const MAX_CUSTOM_RULES = 25000;
const APPLY_DEBOUNCE_MS = 50;

let custom = { text: null };

export function customFilters(text) {
  if (custom.text !== text) {
    const parsed = parseFilterList(text);
    const rules = toRules(parsed.network, CUSTOM_RULE_START)
      .slice(0, MAX_CUSTOM_RULES)
      .map((r) => ({ ...r, priority: r.priority + 10 }));
    custom = { text, rules, cosmetic: groupCosmetic(parsed.cosmetic), skipped: parsed.skipped };
  }
  return custom;
}

let staticCounts = null;

async function dynamicBudget(settings) {
  if (!IS_SAFARI) return DYNAMIC_LIMIT;
  staticCounts ||= fetch(chrome.runtime.getURL("rules/build-info.json")).then((r) => r.json()).then((i) => i.counts || {}, () => ({}));
  const counts = await staticCounts;
  const used = settings.enabledLists.reduce((n, id) => n + (counts[id] || 0), 0);
  return Math.max(0, Math.min(DYNAMIC_LIMIT, SAFARI_RULE_CAP - used - SAFARI_RULE_MARGIN));
}

async function applyDynamicRules(settings) {
  const rules = settings.allowlist.map((domain, i) => ({
    id: i + 1,
    priority: ALLOWLIST_PRIORITY,
    action: { type: "allowAllRequests" },
    condition: { requestDomains: [domain], resourceTypes: ["main_frame"] }
  }));
  rules.push(...customFilters(settings.customFilters).rules);

  const limit = await dynamicBudget(settings);
  const { remoteNetwork = {}, remoteRetired = {} } = await chrome.storage.local.get(["remoteNetwork", "remoteRetired"]);
  let nextId = REMOTE_RULE_START;
  const addRemote = (r) => rules.length < limit && rules.push({ id: nextId++, ...r });
  for (const id of settings.enabledLists) {
    for (const r of remoteRetired[id] || []) addRemote({ action: { type: "allow" }, condition: r.condition, priority: r.priority + 1 });
  }
  for (const id of settings.enabledLists) {
    for (const r of remoteNetwork[id] || []) addRemote(r);
  }
  rules.splice(limit);

  const desired = new Map((settings.enabled ? rules : []).map((r) => [r.id, ruleKey(r)]));
  const existing = new Map((await chrome.declarativeNetRequest.getDynamicRules()).map((r) => [r.id, ruleKey(r)]));
  const removeRuleIds = [...existing].filter(([id, key]) => desired.get(id) !== key).map(([id]) => id);
  const addRules = (settings.enabled ? rules : []).filter((r) => existing.get(r.id) !== desired.get(r.id));
  if (removeRuleIds.length || addRules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  }
}

async function applyRulesets(settings) {
  const active = settings.enabled ? settings.enabledLists.flatMap((id) => [id, `${id}-extra`]) : [];
  const current = await dnr.getEnabledRulesets();
  await dnr.updateEnabledRulesets({
    enableRulesetIds: active.filter((id) => !current.includes(id)),
    disableRulesetIds: current.filter((id) => !active.includes(id))
  });

  if (!CAN_DISABLE_STATIC) return;
  const { remoteDisabled = {} } = await chrome.storage.local.get("remoteDisabled");
  const plan = [];
  let budget = DISABLED_STATIC_LIMIT;
  for (const list of LISTS) {
    for (const rulesetId of [list.id, `${list.id}-extra`]) {
      const want = (remoteDisabled[list.id]?.[rulesetId] || []).slice(0, budget);
      budget -= want.length;
      plan.push({ rulesetId, want });
    }
  }
  await Promise.all(
    plan.map(async ({ rulesetId, want }) => {
      const have = await dnr.getDisabledRuleIds({ rulesetId });
      const wantSet = new Set(want);
      const haveSet = new Set(have);
      const disableRuleIds = want.filter((id) => !haveSet.has(id));
      const enableRuleIds = have.filter((id) => !wantSet.has(id));
      if (disableRuleIds.length || enableRuleIds.length) {
        await dnr.updateStaticRules({ rulesetId, disableRuleIds, enableRuleIds });
      }
    })
  );
}

function excludeMatchesFor(domains) {
  return domains.filter((d) => isSiteHost(d) && !d.includes(":")).map((d) => (/^[\d.]+$/.test(d) ? `*://${d}/*` : `*://*.${d}/*`));
}

function desiredScripts(settings) {
  if (!settings.enabled) return [];
  const excludeMatches = excludeMatchesFor(settings.allowlist);
  const everywhere = { matches: ["<all_urls>"], excludeMatches, runAt: "document_start", allFrames: true };
  const scripts = [{ id: "cosmetic", js: ["content/cosmetic.js"], ...everywhere }];
  if (settings.blockPopups) scripts.push({ id: "clicks", js: ["content/clicks.js"], ...everywhere });
  const strict = settings.strictPopupSites.filter((d) => !isAllowlisted(d, settings.allowlist));
  if (strict.length) {
    scripts.push({
      id: "no-popups",
      js: ["content/no-popups.js"],
      matches: excludeMatchesFor(strict),
      runAt: "document_start",
      world: "MAIN",
      allFrames: true,
      matchOriginAsFallback: true
    });
  }
  if (settings.youtube && settings.enabledLists.includes("ads")) {
    const youtube = { matches: ["*://*.youtube.com/*"], excludeMatches };
    scripts.push(
      { id: "yt-main", js: ["content/youtube-main.js"], ...youtube, runAt: "document_start", world: "MAIN", allFrames: true },
      { id: "yt-skip", js: ["content/youtube-skip.js"], ...youtube, runAt: "document_idle" }
    );
  }
  return scripts;
}

const SCRIPT_DEFAULTS = { excludeMatches: [], runAt: "document_idle", world: "ISOLATED", allFrames: false };
const scriptKey = (s) =>
  JSON.stringify([s.js, s.matches, ...Object.entries(SCRIPT_DEFAULTS).map(([field, fallback]) => s[field] ?? fallback)]);

async function registerScripts(scripts) {
  try {
    await chrome.scripting.registerContentScripts(scripts.map((s) => ({ ...s, persistAcrossSessions: true })));
  } catch {
    for (const { matchOriginAsFallback, ...script } of scripts) {
      try {
        await chrome.scripting.registerContentScripts([script]);
      } catch (err) {
        console.warn(`content script ${script.id} unsupported here`, err);
      }
    }
  }
}

async function applyContentScripts(settings) {
  const desired = new Map(desiredScripts(settings).map((s) => [s.id, s]));
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const current = new Map(registered.map((s) => [s.id, scriptKey(s)]));
  const stale = registered.filter((s) => !desired.has(s.id) || scriptKey(desired.get(s.id)) !== current.get(s.id)).map((s) => s.id);
  const missing = [...desired.values()].filter((s) => current.get(s.id) !== scriptKey(s));
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  if (missing.length) await registerScripts(missing);
}

async function applyAll() {
  const settings = await readSettings();
  await Promise.all([applyDynamicRules(settings), applyRulesets(settings), applyContentScripts(settings)]);
  await chrome.declarativeNetRequest.setExtensionActionOptions?.({ displayActionCountAsBadgeText: settings.enabled });
  await chrome.action.setBadgeBackgroundColor?.({ color: "#c0392b" });
  await chrome.action.setTitle({ title: settings.enabled ? APP_NAME : `${APP_NAME} (paused)` });
}

let applyChain = Promise.resolve();
let scheduledApply = null;

export function queueApply() {
  scheduledApply ||= new Promise((resolve) => setTimeout(resolve, APPLY_DEBOUNCE_MS)).then(() => {
    scheduledApply = null;
    applyChain = applyChain.then(applyAll).catch((err) => console.error("apply failed", err));
    return applyChain;
  });
  return scheduledApply;
}

export const applied = () => scheduledApply || applyChain;
