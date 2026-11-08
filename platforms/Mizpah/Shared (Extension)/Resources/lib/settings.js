import { LISTS } from "./filters.js";
import { isSiteHost } from "./host.js";

export const LEARNED_POPUP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const DEFAULTS = {
  enabled: true,
  enabledLists: LISTS.map((l) => l.id),
  allowlist: [],
  customFilters: "",
  youtube: true,
  autoUpdate: true,
  blockPopups: true,
  strictPopupSites: []
};

export const SETTING_KEYS = Object.keys(DEFAULTS);

const LIST_IDS = new Set(LISTS.map((l) => l.id));
const VALID_ENTRY = { enabledLists: (v) => LIST_IDS.has(v), allowlist: isSiteHost, strictPopupSites: isSiteHost };

const validValue = (key, value, fallback) =>
  Array.isArray(fallback) ? Array.isArray(value) && value.every(VALID_ENTRY[key]) : typeof value === typeof fallback;

export function coerceSettings(stored, rejected = []) {
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = stored[key];
    if (validValue(key, value, fallback)) {
      out[key] = value;
    } else if (Array.isArray(fallback) && Array.isArray(value)) {
      rejected.push(key);
      out[key] = value.filter(VALID_ENTRY[key]);
    } else {
      if (key in stored) rejected.push(key);
      out[key] = structuredClone(fallback);
    }
  }
  return out;
}

export const activeLearned = (list, now = Date.now()) =>
  (Array.isArray(list) ? list : []).filter((l) => typeof l?.d === "string" && now - l.t < LEARNED_POPUP_TTL_MS);
