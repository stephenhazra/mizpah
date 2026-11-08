import { LISTS } from "./filters.js";

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

const validValue = (value, fallback) =>
  Array.isArray(fallback) ? Array.isArray(value) && value.every((v) => typeof v === "string") : typeof value === typeof fallback;

export function coerceSettings(stored, rejected = []) {
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (validValue(stored[key], fallback)) out[key] = stored[key];
    else {
      if (key in stored) rejected.push(key);
      out[key] = structuredClone(fallback);
    }
  }
  return out;
}

export const activeLearned = (list, now = Date.now()) =>
  (Array.isArray(list) ? list : []).filter((l) => typeof l?.d === "string" && now - l.t < LEARNED_POPUP_TTL_MS);
