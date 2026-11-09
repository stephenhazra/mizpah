const $ = (id) => document.getElementById(id);
const APP_NAME = chrome.runtime.getManifest().short_name;
document.title = APP_NAME;
document.querySelectorAll(".app-name").forEach((el) => (el.textContent = APP_NAME));
const send = (msg) => chrome.runtime.sendMessage(msg);

const forcedTab = Number(new URLSearchParams(location.search).get("tab"));
const [tab] = forcedTab ? [await chrome.tabs.get(forcedTab)] : await chrome.tabs.query({ active: true, currentWindow: true });
let state;

function render() {
  document.body.classList.toggle("paused", !state.enabled);
  $("power").checked = state.enabled;
  $("host").textContent = state.hostname || "This page can't be filtered";
  $("host").title = state.hostname || "";
  $("blocked").closest(".count").hidden = state.blocked == null;
  $("blocked").textContent = state.blocked ?? "";
  const btn = $("toggleSite");
  btn.hidden = !state.hostname;
  btn.disabled = !state.enabled;
  btn.textContent = state.allowlisted ? "Stop trusting this site" : "Trust this site";
  btn.classList.toggle("off", state.allowlisted);
  $("picker").disabled = !state.hostname || !state.enabled || state.allowlisted;
  $("popups").hidden = !state.popupsClosed;
  $("popups").textContent = `${state.popupsClosed} pop-up${state.popupsClosed === 1 ? "" : "s"} closed`;
  const strict = $("strictPopups");
  strict.hidden = !state.hostname;
  strict.disabled = !state.enabled || state.allowlisted;
  strict.setAttribute("aria-pressed", String(!!state.strictPopups));
  strict.classList.toggle("on", state.strictPopups);
  $("rebuild").hidden = !state.rebuild?.length;
  $("status").textContent = !state.enabled ? "Blocking is paused everywhere" : state.hostname && state.allowlisted ? "Hide an element and pop-up blocking are unavailable on trusted sites" : "";
}

const sitePattern = () => {
  const u = new URL(tab.url);
  return `${u.protocol}//${u.hostname}/*`;
};

async function checkHostAccess() {
  if (!state?.hostname || !state.enabled || state.allowlisted) return;
  const granted = await chrome.permissions.contains({ origins: [sitePattern()] }).catch(() => true);
  $("hostAccess").hidden = granted;
}

async function refresh() {
  const reply = await send({ type: "popupState", tabId: tab.id, url: tab.url || "" }).catch((err) => ({ error: String(err) }));
  if (reply?.error) {
    $("status").textContent = `${APP_NAME} couldn't read this tab: ${reply.error}`;
    return;
  }
  state = reply;
  render();
  await checkHostAccess();
}

$("grantAccess").addEventListener("click", async () => {
  const granted = await chrome.permissions.request({ origins: [sitePattern()] }).catch(() => false);
  if (granted) {
    $("hostAccess").hidden = true;
    $("note").hidden = false;
  }
});

$("power").addEventListener("change", async (e) => {
  await send({ type: "setEnabled", enabled: e.target.checked });
  $("note").hidden = false;
  await refresh();
});

$("toggleSite").addEventListener("click", async () => {
  await send({ type: "toggleSite", hostname: state.hostname, allow: !state.allowlisted });
  $("note").hidden = false;
  await refresh();
});

$("strictPopups").addEventListener("click", async () => {
  await send({ type: "toggleStrictPopups", hostname: state.hostname, strict: !state.strictPopups });
  $("note").hidden = false;
  await refresh();
});

$("picker").addEventListener("click", async () => {
  await send({ type: "armPicker", tabId: tab.id });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/picker.js"] });
  window.close();
});

$("reload").addEventListener("click", () => {
  chrome.tabs.reload(tab.id);
  window.close();
});

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("rebuild").addEventListener("click", () => chrome.runtime.openOptionsPage());

await refresh();
