import { SETTING_KEYS, coerceSettings } from "../lib/settings.js";

let settingsCache = null;

export async function readSettings() {
  return coerceSettings(await chrome.storage.local.get(SETTING_KEYS));
}

export function getSettings() {
  settingsCache ||= readSettings().catch((err) => {
    settingsCache = null;
    throw err;
  });
  return settingsCache;
}

export function forgetSettings() {
  settingsCache = null;
}

export async function saveSettings(patch) {
  forgetSettings();
  await chrome.storage.local.set(patch);
  forgetSettings();
}
