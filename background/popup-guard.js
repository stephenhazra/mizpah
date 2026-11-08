import { compilePopupFilters, matchPopup } from "../lib/popup.js";
import { hostOf, registrableDomain, isAllowlisted } from "../lib/host.js";
import { activeLearned } from "../lib/settings.js";
import { getSettings } from "./settings.js";

const POPUP_WINDOW_MS = 15000;
const INFERRED_POPUP_MS = 2000;
const CLICK_MS = 3000;
const INFERRED_CLICK_MS = 2500;
const POPUP_HOP_LIMIT = 3;
const EARLY_URL_LIMIT = 5;
const LEARNED_POPUP_LIMIT = 1000;
const VISITED_DOMAIN_LIMIT = 3000;
const VISITED_SAVE_MS = 1000;
const HAS_OPENER_EVENTS = !!chrome.webNavigation?.onCreatedNavigationTarget;
const USER_TRANSITIONS = new Set(["typed", "auto_bookmark", "generated", "keyword", "link", "form_submit", "reload", "start_page"]);
const session = chrome.storage.session;

const newTabs = new Map();
let popupMatcher = null;
let tabState = null;
let visitedDomains = null;
let visitedSaveTimer = 0;
let storageWrites = Promise.resolve();

export function forgetPopupMatcher() {
  popupMatcher = null;
}

async function getPopupMatcher() {
  if (!popupMatcher) {
    const bundled = await (await fetch(chrome.runtime.getURL("rules/popup.json"))).json();
    const { remotePopup, learnedPopups } = await chrome.storage.local.get(["remotePopup", "learnedPopups"]);
    const src = remotePopup || bundled;
    popupMatcher = compilePopupFilters(src.entries, [...src.adDomains, ...activeLearned(learnedPopups).map((l) => l.d)]);
  }
  return popupMatcher;
}

function serially(write) {
  const run = storageWrites.then(write);
  storageWrites = run.catch((err) => console.error("storage update failed", err));
  return run;
}

function getTabState() {
  tabState ||= (async () => {
    const saved = (await session?.get(["lastClicks", "popupCounts"])) || {};
    const toMap = (obj) => new Map(Object.entries(obj || {}).map(([id, v]) => [Number(id), v]));
    return { lastClicks: toMap(saved.lastClicks), popupCounts: toMap(saved.popupCounts) };
  })();
  return tabState;
}

async function saveTabState() {
  const { lastClicks, popupCounts } = await getTabState();
  await session?.set({ lastClicks: Object.fromEntries(lastClicks), popupCounts: Object.fromEntries(popupCounts) });
}

const isWebUrl = (url) => /^https?:/.test(url) && !!hostOf(url);

async function getVisitedDomains() {
  visitedDomains ||= new Map(Object.entries((await session?.get("visitedDomains"))?.visitedDomains || {}));
  return visitedDomains;
}

async function rememberVisit(url) {
  if (!isWebUrl(url)) return;
  const domain = registrableDomain(hostOf(url));
  const visited = await getVisitedDomains();
  visited.delete(domain);
  visited.set(domain, Date.now());
  while (visited.size > VISITED_DOMAIN_LIMIT) visited.delete(visited.keys().next().value);
  clearTimeout(visitedSaveTimer);
  visitedSaveTimer = setTimeout(() => session?.set({ visitedDomains: Object.fromEntries(visited) }), VISITED_SAVE_MS);
}

async function learnPopupDomain(domain) {
  if (!domain || (await getVisitedDomains()).has(domain)) return;
  await serially(async () => {
    const { learnedPopups } = await chrome.storage.local.get("learnedPopups");
    const list = activeLearned(learnedPopups).filter((l) => l.d !== domain);
    list.push({ d: domain, t: Date.now() });
    await chrome.storage.local.set({ learnedPopups: list.slice(-LEARNED_POPUP_LIMIT) });
  });
}

export async function clearLearnedData() {
  clearTimeout(visitedSaveTimer);
  visitedDomains = new Map();
  popupMatcher = null;
  (await getTabState()).popupCounts.clear();
  await Promise.all([
    chrome.storage.local.remove(["learnedPopups", "popupsBlocked", "visitedDomains", "lastPopup"]),
    session?.remove("visitedDomains"),
    saveTabState()
  ]);
}

function noteNewTab(tabId) {
  const now = Date.now();
  for (const [id, t] of newTabs) if (now - t.created > POPUP_WINDOW_MS) newTabs.delete(id);
  if (!newTabs.has(tabId)) newTabs.set(tabId, { created: now, state: "new", urls: [], popup: null });
  return newTabs.get(tabId);
}

function noteUrl(tabId, url) {
  const tab = newTabs.get(tabId);
  if (tab?.state === "watching") return inspectPopup(tabId, tab, url);
  if (tab?.state === "new" || tab?.state === "pending") {
    tab.urls.push(url);
    if (tab.urls.length > EARLY_URL_LIMIT) tab.urls.shift();
  }
}

async function closePopup(tabId, tab, reason) {
  const popup = tab.popup;
  if (popup.closed) return;
  popup.closed = true;
  tab.state = "done";
  await chrome.tabs.remove(tabId).catch(() => {});
  const { popupCounts } = await getTabState();
  popupCounts.set(popup.sourceTabId, (popupCounts.get(popup.sourceTabId) || 0) + 1);
  await saveTabState();
  await serially(async () => {
    const { popupsBlocked = 0 } = await chrome.storage.local.get("popupsBlocked");
    await chrome.storage.local.set({ popupsBlocked: popupsBlocked + 1 });
  });
  if (reason === "redirect chain" && !popup.inferred) await learnPopupDomain(popup.firstDomain);
}

async function inspectPopup(tabId, tab, url) {
  const popup = tab.popup;
  if (popup.closed || tab.state !== "watching") return;
  const age = Date.now() - tab.created;
  if (age > POPUP_WINDOW_MS || (popup.inferred && !popup.firstUrl && age > INFERRED_POPUP_MS)) {
    tab.state = "done";
    return;
  }
  if (!isWebUrl(url)) return;
  const domain = registrableDomain(hostOf(url));
  if (domain === popup.openerDomain) return;
  if (!popup.firstUrl) {
    popup.firstUrl = url;
    popup.firstDomain = domain;
    const href = popup.click?.href;
    if (href && (href === url || registrableDomain(hostOf(href)) === domain)) {
      tab.state = "done";
      return;
    }
    if (popup.strict) return closePopup(tabId, tab, "strict");
  }
  popup.domains.add(domain);
  const matched = matchPopup(await getPopupMatcher(), url, popup.openerHost);
  if (tab.state !== "watching") return;
  if (matched) return closePopup(tabId, tab, "filter");
  if (!popup.inferred && popup.domains.size >= POPUP_HOP_LIMIT) return closePopup(tabId, tab, "redirect chain");
}

async function trackPopup(tabId, sourceTabId, url, inferred = false) {
  const tab = noteNewTab(tabId);
  if (tab.state !== "new") return;
  tab.state = "pending";
  const settings = await getSettings();
  const opener = settings.enabled && settings.blockPopups ? await chrome.tabs.get(sourceTabId).catch(() => null) : null;
  const openerHost = hostOf(opener?.url || "");
  if (!openerHost || isAllowlisted(openerHost, settings.allowlist)) {
    tab.state = "done";
    return;
  }
  const recent = (await getTabState()).lastClicks.get(sourceTabId);
  const click = recent && Date.now() - recent.time < CLICK_MS ? recent : null;
  tab.popup = {
    sourceTabId,
    openerHost,
    openerDomain: registrableDomain(openerHost),
    domains: new Set(),
    click,
    inferred,
    strict: isAllowlisted(openerHost, settings.strictPopupSites),
    firstUrl: "",
    firstDomain: "",
    closed: false
  };
  tab.state = "watching";
  const early = tab.urls;
  tab.urls = [];
  for (const u of [url, ...early].filter(Boolean)) await inspectPopup(tabId, tab, u);
}

async function recentClickTab(tab) {
  let best = null;
  for (const [tabId, click] of (await getTabState()).lastClicks) {
    if (tabId === tab.id || click.windowId !== tab.windowId || Date.now() - click.time > INFERRED_CLICK_MS) continue;
    if (!best || click.time > best.time) best = { tabId, time: click.time };
  }
  return best?.tabId ?? null;
}

export async function recordClick(sender, href) {
  (await getTabState()).lastClicks.set(sender.tab.id, { href: typeof href === "string" ? href : null, time: Date.now(), windowId: sender.tab.windowId });
  await saveTabState();
}

export const popupCount = async (tabId) => (await getTabState()).popupCounts.get(tabId) || 0;

chrome.webNavigation?.onCreatedNavigationTarget?.addListener((d) => trackPopup(d.tabId, d.sourceTabId, d.url));

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.id == null) return;
  noteNewTab(tab.id);
  if (HAS_OPENER_EVENTS) return;
  const inferred = tab.openerTabId == null;
  const opener = inferred ? await recentClickTab(tab) : tab.openerTabId;
  if (opener != null) trackPopup(tab.id, opener, tab.pendingUrl || (tab.url && tab.url !== "about:blank" ? tab.url : ""), inferred);
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) noteUrl(tabId, change.url);
});

if (chrome.webRequest) {
  chrome.webRequest.onBeforeRequest.addListener((d) => (d.tabId >= 0 ? noteUrl(d.tabId, d.url) : undefined), { urls: ["<all_urls>"], types: ["main_frame"] });
} else {
  chrome.webNavigation?.onBeforeNavigate?.addListener((d) => {
    if (d.frameId === 0) noteUrl(d.tabId, d.url);
  });
}

chrome.webNavigation?.onCommitted?.addListener(async (d) => {
  if (d.frameId !== 0) return;
  noteUrl(d.tabId, d.url);
  const tab = newTabs.get(d.tabId);
  const opened = tab && tab.state !== "new";
  const maybePopup = d.transitionType == null && tab?.state === "new" && Date.now() - tab.created < INFERRED_POPUP_MS;
  if (!opened && !maybePopup && (d.transitionType == null || USER_TRANSITIONS.has(d.transitionType))) rememberVisit(d.url);
  const { popupCounts } = await getTabState();
  if (popupCounts.delete(d.tabId)) await saveTabState();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  newTabs.delete(tabId);
  const { lastClicks, popupCounts } = await getTabState();
  if (lastClicks.delete(tabId) | popupCounts.delete(tabId)) await saveTabState();
});
