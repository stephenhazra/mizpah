import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, SETTING_KEYS, LEARNED_POPUP_TTL_MS, coerceSettings, activeLearned } from "../lib/settings.js";
import { LISTS } from "../lib/filters.js";

describe("DEFAULTS", () => {
  test("enable every list by default", () => {
    assert.deepEqual(DEFAULTS.enabledLists, LISTS.map((l) => l.id));
  });
  test("SETTING_KEYS matches DEFAULTS", () => {
    assert.deepEqual(SETTING_KEYS, Object.keys(DEFAULTS));
  });
});

describe("coerceSettings", () => {
  test("empty storage gives defaults", () => {
    assert.deepEqual(coerceSettings({}), DEFAULTS);
  });
  test("keeps valid values", () => {
    const stored = { enabled: false, allowlist: ["a.com"], enabledLists: ["ads"], customFilters: "x", youtube: false, autoUpdate: false, blockPopups: false, strictPopupSites: ["b.com"] };
    assert.deepEqual(coerceSettings(stored), stored);
  });
  test("bad types fall back to defaults and are reported", () => {
    const rejected = [];
    const out = coerceSettings({ allowlist: "x", enabledLists: null, strictPopupSites: [1, 2], enabled: "yes", customFilters: 5 }, rejected);
    assert.deepEqual(out, DEFAULTS);
    assert.deepEqual(rejected.sort(), ["allowlist", "customFilters", "enabled", "enabledLists", "strictPopupSites"]);
  });
  test("missing keys are not reported as rejected", () => {
    const rejected = [];
    coerceSettings({}, rejected);
    assert.deepEqual(rejected, []);
  });
  test("unknown keys are dropped", () => {
    assert.equal("junk" in coerceSettings({ junk: 1 }), false);
  });
  test("arrays mixing strings and other types keep no invalid entries", () => {
    assert.deepEqual(coerceSettings({ allowlist: ["a.com", 1] }).allowlist.filter((v) => typeof v !== "string"), []);
  });
  test("returned defaults are copies, not shared references", () => {
    const out = coerceSettings({});
    out.allowlist.push("x");
    out.enabledLists.push("x");
    assert.deepEqual(DEFAULTS.allowlist, []);
    assert.equal(DEFAULTS.enabledLists.includes("x"), false);
  });
  test("null stored value for a boolean is rejected", () => {
    assert.equal(coerceSettings({ enabled: null }).enabled, true);
  });
});

describe("coerceSettings host and list validation", () => {
  test("invalid hosts in allowlist are dropped and the key is reported", () => {
    const rejected = [];
    const out = coerceSettings({ allowlist: ["a.com", "not a host", "com"] }, rejected);
    assert.deepEqual(out.allowlist, ["a.com"]);
    assert.ok(rejected.includes("allowlist"));
  });
  test("invalid hosts in strictPopupSites are dropped and the key is reported", () => {
    const rejected = [];
    const out = coerceSettings({ strictPopupSites: ["a.com", "x y"] }, rejected);
    assert.deepEqual(out.strictPopupSites, ["a.com"]);
    assert.ok(rejected.includes("strictPopupSites"));
  });
  test("unknown list ids are dropped and the key is reported", () => {
    const rejected = [];
    const out = coerceSettings({ enabledLists: ["ads", "bogus"] }, rejected);
    assert.deepEqual(out.enabledLists, ["ads"]);
    assert.ok(rejected.includes("enabledLists"));
  });
  test("valid hosts and known ids are not reported", () => {
    const rejected = [];
    const out = coerceSettings({ allowlist: ["a.com", "localhost"], enabledLists: ["ads"] }, rejected);
    assert.deepEqual(out.allowlist, ["a.com", "localhost"]);
    assert.deepEqual(out.enabledLists, ["ads"]);
    assert.deepEqual(rejected, []);
  });
});

describe("activeLearned", () => {
  const now = 1_700_000_000_000;
  test("keeps entries inside the TTL", () => {
    const list = [{ d: "a.com", t: now - 1000 }];
    assert.deepEqual(activeLearned(list, now), list);
  });
  test("drops entries older than the TTL", () => {
    assert.deepEqual(activeLearned([{ d: "a.com", t: now - LEARNED_POPUP_TTL_MS - 1 }], now), []);
    assert.deepEqual(activeLearned([{ d: "a.com", t: now - 31 * 86400000 }], now), []);
  });
  test("drops strings, null and malformed entries", () => {
    assert.deepEqual(activeLearned(["example.org", null, undefined, 5, {}, { d: 5, t: now }, { t: now }], now), []);
  });
  test("drops entries without a timestamp", () => {
    assert.deepEqual(activeLearned([{ d: "a.com" }], now), []);
  });
  test("non-array input gives an empty list", () => {
    assert.deepEqual(activeLearned(undefined, now), []);
    assert.deepEqual(activeLearned("a.com", now), []);
    assert.deepEqual(activeLearned({ d: "a.com", t: now }, now), []);
  });
  test("defaults now to the current time", () => {
    assert.equal(activeLearned([{ d: "a.com", t: Date.now() }]).length, 1);
  });
});
