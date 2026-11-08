import { LISTS } from "../lib/filters.js";
import { SETTING_KEYS, coerceSettings, activeLearned } from "../lib/settings.js";
import { parseDomainList } from "../lib/host.js";

const $ = (id) => document.getElementById(id);
const APP_NAME = chrome.runtime.getManifest().short_name;
document.title = `${APP_NAME} Settings`;
document.querySelectorAll(".app-name").forEach((el) => (el.textContent = APP_NAME));

const flashTimers = {};
const flash = (id, text, { keep = false } = {}) => {
  clearTimeout(flashTimers[id]);
  $(id).textContent = text;
  if (!keep) flashTimers[id] = setTimeout(() => ($(id).textContent = ""), 6000);
};

const ago = (t) => {
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} ${mins === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  return new Date(t).toLocaleDateString();
};

function renderRebuild(stats) {
  const reasons = stats.listUpdate?.rebuild || [];
  $("rebuildBanner").hidden = !reasons.length;
  $("rebuildReasons").replaceChildren(...reasons.map((r) => Object.assign(document.createElement("li"), { textContent: r })));
  $("rebuildCmd").textContent = `cd ${stats.extensionPath || "path/to/mizpah"}\nnode tools/build-rules.mjs --remote`;
}

$("copyCmd").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("rebuildCmd").textContent);
  flash("copyStatus", "Copied");
});

function renderUpdate(stats) {
  const info = $("updateInfo");
  const u = stats.listUpdate;
  info.classList.toggle("error", !!u?.errors?.length);
  $("updateNow").disabled = stats.updating;
  if (stats.updating) {
    info.textContent = "Updating…";
    return;
  }
  if (!u?.lastSuccess) {
    info.textContent = u?.errors?.length ? `Update failed: ${u.errors.join("; ")}` : "Using the rules bundled with this version";
    return;
  }
  const added = Object.values(u.lists || {}).reduce((n, l) => n + l.added, 0);
  const removed = Object.values(u.lists || {}).reduce((n, l) => n + l.removed, 0);
  let text = `Updated ${ago(u.lastSuccess)} · ${added.toLocaleString()} new rules added, ${removed.toLocaleString()} retired`;
  if (u.errors?.length) text += ` · Failed: ${u.errors.join("; ")}`;
  info.textContent = text;
}

async function load() {
  const s = coerceSettings(await chrome.storage.local.get(SETTING_KEYS));
  const stats = await chrome.runtime.sendMessage({ type: "stats" });

  $("lists").replaceChildren(
    ...LISTS.map((list) => {
      const row = document.createElement("label");
      row.className = "row";
      row.innerHTML = `<div><strong id="list-${list.id}-name"></strong><p id="list-${list.id}-info"></p></div><span class="switch"><input type="checkbox" role="switch" aria-labelledby="list-${list.id}-name" aria-describedby="list-${list.id}-info"><span></span></span>`;
      row.querySelector("strong").textContent = list.name;
      row.querySelector("p").textContent = `${list.description} · ${stats.counts[list.id].toLocaleString()} network rules`;
      const input = row.querySelector("input");
      input.checked = s.enabledLists.includes(list.id);
      input.addEventListener("change", async () => {
        const cur = new Set(coerceSettings(await chrome.storage.local.get("enabledLists")).enabledLists);
        input.checked ? cur.add(list.id) : cur.delete(list.id);
        await chrome.storage.local.set({ enabledLists: LISTS.map((l) => l.id).filter((id) => cur.has(id)) });
      });
      return row;
    })
  );

  $("youtube").checked = s.youtube;
  $("autoUpdate").checked = s.autoUpdate;
  $("blockPopups").checked = s.blockPopups;
  $("strictPopupSites").value = s.strictPopupSites.join("\n");
  const { popupsBlocked = 0, learnedPopups } = await chrome.storage.local.get(["popupsBlocked", "learnedPopups"]);
  const learned = activeLearned(learnedPopups).map((l) => l.d);
  const learnedText = learned.length
    ? `${learned.length} site${learned.length === 1 ? "" : "s"} learned from pop-ups, each forgotten after 30 days: ${learned.slice(-5).join(", ")}.`
    : `None yet. ${APP_NAME} learns sites from pop-ups it closes, never sites you visit yourself.`;
  $("learnedInfo").textContent = `${learnedText} Clearing also forgets the recent-sites list and the pop-up count.`;
  $("forgetLearned").disabled = !learned.length && !popupsBlocked;
  $("popupInfo").textContent = `Closes pop-up and pop-under ad tabs · ${popupsBlocked.toLocaleString()} closed so far`;
  renderUpdate(stats);
  renderRebuild(stats);
  $("allowlist").value = s.allowlist.join("\n");
  $("custom").value = s.customFilters;
}

$("youtube").addEventListener("change", (e) => chrome.storage.local.set({ youtube: e.target.checked }));
$("forgetLearned").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearLearnedPopups" });
  await load();
});
$("blockPopups").addEventListener("change", (e) => chrome.storage.local.set({ blockPopups: e.target.checked }));
$("autoUpdate").addEventListener("change", (e) => chrome.storage.local.set({ autoUpdate: e.target.checked }));

$("updateNow").addEventListener("click", async () => {
  renderUpdate({ updating: true });
  await chrome.runtime.sendMessage({ type: "refreshLists" });
  await load();
});

$("saveAllowlist").addEventListener("click", async () => {
  const domains = parseDomainList($("allowlist").value);
  await chrome.storage.local.set({ allowlist: domains });
  $("allowlist").value = domains.join("\n");
  flash("allowStatus", `Saved ${domains.length} site${domains.length === 1 ? "" : "s"}`);
});

$("saveStrict").addEventListener("click", async () => {
  const domains = parseDomainList($("strictPopupSites").value);
  await chrome.storage.local.set({ strictPopupSites: domains });
  $("strictPopupSites").value = domains.join("\n");
  flash("strictStatus", `Saved ${domains.length} site${domains.length === 1 ? "" : "s"}`);
});

$("saveCustom").addEventListener("click", async () => {
  await chrome.storage.local.set({ customFilters: $("custom").value });
  const res = await chrome.runtime.sendMessage({ type: "customStatus" });
  flash("customStatus", `Saved · ${res.networkRules} network rules active${res.skipped ? ` · ${res.skipped} unsupported lines ignored` : ""}`);
});

$("export").addEventListener("click", async () => {
  const data = await chrome.storage.local.get(SETTING_KEYS);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "mizpah-settings.json" });
  a.click();
  URL.revokeObjectURL(url);
});

$("import").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  let data;
  try {
    data = JSON.parse(await e.target.files[0].text());
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not an object");
  } catch {
    flash("backupStatus", `That file isn't a valid ${APP_NAME} backup`, { keep: true });
    return;
  }
  const rejected = [];
  const settings = coerceSettings(data, rejected);
  const clean = Object.fromEntries(SETTING_KEYS.filter((k) => k in data && !rejected.includes(k)).map((k) => [k, settings[k]]));
  if (!Object.keys(clean).length) {
    flash("backupStatus", "That backup has no settings to import", { keep: true });
    return;
  }
  const describe = (k) => (Array.isArray(clean[k]) ? `${k}: ${clean[k].length} entries` : k === "customFilters" ? `customFilters: ${clean[k].split("\n").filter(Boolean).length} lines` : `${k}: ${clean[k]}`);
  const skipped = rejected.length ? `\n\nSkipped as invalid: ${rejected.join(", ")}` : "";
  if (!confirm(`Replace these settings?\n\n${Object.keys(clean).map(describe).join("\n")}${skipped}`)) {
    e.target.value = "";
    return;
  }
  try {
    await chrome.storage.local.set(clean);
  } catch (err) {
    flash("backupStatus", `Couldn't save the imported settings: ${err.message}`, { keep: true });
    return;
  }
  await load();
  flash("backupStatus", rejected.length ? `Imported, but skipped invalid ${rejected.join(", ")}` : "Imported", { keep: rejected.length > 0 });
});

load();
