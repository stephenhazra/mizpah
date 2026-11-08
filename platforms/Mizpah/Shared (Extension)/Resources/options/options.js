import { LISTS } from "../lib/filters.js";

const $ = (id) => document.getElementById(id);
const APP_NAME = chrome.runtime.getManifest().short_name;
document.title = `${APP_NAME} Settings`;
document.querySelectorAll(".app-name").forEach((el) => (el.textContent = APP_NAME));
const KEYS = ["enabledLists", "allowlist", "customFilters", "youtube", "enabled", "autoUpdate", "blockPopups", "strictPopupSites"];

const flash = (id, text) => {
  $(id).textContent = text;
  setTimeout(() => ($(id).textContent = ""), 4000);
};

const ago = (t) => {
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
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
  const s = await chrome.storage.local.get(KEYS);
  const stats = await chrome.runtime.sendMessage({ type: "stats" });
  const enabledLists = s.enabledLists ?? LISTS.map((l) => l.id);

  $("lists").replaceChildren(
    ...LISTS.map((list) => {
      const row = document.createElement("label");
      row.className = "row";
      row.innerHTML = `<div><strong></strong><p></p></div><span class="switch"><input type="checkbox"><span></span></span>`;
      row.querySelector("strong").textContent = list.name;
      row.querySelector("p").textContent = `${list.description} · ${stats.counts[list.id].toLocaleString()} network rules`;
      const input = row.querySelector("input");
      input.checked = enabledLists.includes(list.id);
      input.addEventListener("change", async () => {
        const cur = new Set((await chrome.storage.local.get("enabledLists")).enabledLists ?? []);
        input.checked ? cur.add(list.id) : cur.delete(list.id);
        await chrome.storage.local.set({ enabledLists: LISTS.map((l) => l.id).filter((id) => cur.has(id)) });
      });
      return row;
    })
  );

  $("youtube").checked = s.youtube ?? true;
  $("autoUpdate").checked = s.autoUpdate ?? true;
  $("blockPopups").checked = s.blockPopups ?? true;
  $("strictPopupSites").value = (s.strictPopupSites ?? []).join("\n");
  const { popupsBlocked = 0, learnedPopups = [] } = await chrome.storage.local.get(["popupsBlocked", "learnedPopups"]);
  const learned = learnedPopups.filter((l) => l && typeof l === "object" && Date.now() - l.t < 30 * 86400000).map((l) => l.d);
  $("learnedInfo").textContent = learned.length
    ? `${learned.length} site${learned.length === 1 ? "" : "s"} learned from pop-ups, each forgotten after 30 days: ${learned.slice(-5).join(", ")}`
    : "None yet. Mizpah learns sites from pop-ups it closes, never sites you visit yourself.";
  $("forgetLearned").disabled = !learnedPopups.length;
  $("popupInfo").textContent = `Closes pop-up and pop-under ad tabs · ${popupsBlocked.toLocaleString()} closed so far`;
  renderUpdate(stats);
  renderRebuild(stats);
  $("allowlist").value = (s.allowlist ?? []).join("\n");
  $("custom").value = s.customFilters ?? "";
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

const parseDomainList = (text) =>
  [
    ...new Set(
      text
        .split(/\s+/)
        .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, ""))
        .filter((d) => /^[a-z0-9.-]+$/.test(d))
    )
  ].sort();

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
  const data = await chrome.storage.local.get(KEYS);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "mizpah-settings.json" });
  a.click();
  URL.revokeObjectURL(url);
});

$("import").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  try {
    const data = JSON.parse(await e.target.files[0].text());
    const clean = Object.fromEntries(Object.entries(data).filter(([k]) => KEYS.includes(k)));
    await chrome.storage.local.set(clean);
    await load();
    flash("backupStatus", "Imported");
  } catch {
    flash("backupStatus", `That file isn't a valid ${APP_NAME} backup`);
  }
});

load();
