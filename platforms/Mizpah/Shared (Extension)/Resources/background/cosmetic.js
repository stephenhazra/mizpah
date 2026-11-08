import { hostCandidates, isAllowlisted } from "../lib/host.js";
import { getSettings } from "./settings.js";
import { customFilters } from "./apply.js";

export const remoteCosmeticKey = (listId) => `remoteCosmetic_${listId}`;

const bundledCosmetic = new Map();
const remoteCosmetic = new Map();
const insertedByTab = new Map();

function cached(cache, id, load) {
  if (!cache.has(id)) {
    cache.set(
      id,
      load().catch((err) => {
        cache.delete(id);
        console.warn(`cosmetic filters for ${id} unavailable`, err);
        return null;
      })
    );
  }
  return cache.get(id);
}

const loadBundled = (id) => cached(bundledCosmetic, id, async () => (await fetch(chrome.runtime.getURL(`rules/cosmetic-${id}.json`))).json());

const loadRemote = (id) =>
  cached(remoteCosmetic, id, async () => {
    const key = remoteCosmeticKey(id);
    return (await chrome.storage.local.get(key))[key] || null;
  });

export function forgetRemoteCosmetic() {
  remoteCosmetic.clear();
}

async function cosmeticContext(hostname) {
  const settings = await getSettings();
  if (!settings.enabled || isAllowlisted(hostname, settings.allowlist)) return null;
  const lists = await Promise.all(settings.enabledLists.map(async (id) => (await loadRemote(id)) || loadBundled(id)));
  const sources = [...lists.filter(Boolean), customFilters(settings.customFilters).cosmetic];
  const candidates = hostCandidates(hostname);
  const exceptions = new Set();
  let genericOff = false;
  for (const src of sources) {
    if (candidates.some((h) => src.elemHide?.[h])) return null;
    genericOff ||= candidates.some((h) => src.genericHide?.[h]);
    src.genericExceptions.forEach((s) => exceptions.add(s));
    for (const host of candidates) (src.exceptions[host] || []).forEach((s) => exceptions.add(s));
  }
  return { sources, candidates, exceptions, genericOff };
}

async function selectorsFor(hostname, pick) {
  const ctx = await cosmeticContext(hostname);
  if (!ctx) return [];
  const selectors = new Set();
  for (const src of ctx.sources) for (const s of pick(src, ctx)) selectors.add(s);
  return [...selectors].filter((s) => !ctx.exceptions.has(s));
}

export const pageSelectors = (hostname) =>
  selectorsFor(hostname, (src, ctx) => [...(ctx.genericOff ? [] : src.generic), ...ctx.candidates.flatMap((h) => src.specific[h] || [])]);

export const tokenSelectors = (hostname, tokens) =>
  selectorsFor(hostname, (src, ctx) => (ctx.genericOff ? [] : tokens.flatMap((t) => src.genericTokens[t] || [])));

export async function insertSelectors(sender, selectors) {
  const tabId = sender.tab.id;
  const { documentId } = sender;
  let inserted = null;
  if (documentId) {
    const docs = insertedByTab.get(tabId) || new Map();
    insertedByTab.set(tabId, docs);
    inserted = docs.get(documentId) || new Set();
    docs.set(documentId, inserted);
    selectors = selectors.filter((s) => !inserted.has(s));
  }
  if (!selectors.length) return 0;
  const css = selectors.map((s) => `${s}{display:none!important}`).join("\n");
  const target = documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [sender.frameId ?? 0] };
  try {
    await chrome.scripting.insertCSS({ target, css, origin: "USER" });
  } catch {
    await chrome.scripting.insertCSS({ target, css });
  }
  selectors.forEach((s) => inserted?.add(s));
  return selectors.length;
}

export function forgetDocuments(tabId) {
  insertedByTab.delete(tabId);
}
