#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = process.env.MIZPAH_DIR || join(dirname(fileURLToPath(import.meta.url)), "..");
const WITH_REFRESH = process.argv.includes("--refresh");
const EXPECT_REBUILD = process.argv.includes("--expect-rebuild");
const PROFILE = mkdtempSync(join(tmpdir(), "mizpah-"));
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=${PROFILE}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "--no-first-run", "about:blank"], {
  stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"]
});
const [out, inp] = [chrome.stdio[3], chrome.stdio[4]];
let nextId = 0;
let buf = "";
const pending = new Map();
inp.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\0")) !== -1) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((r) => {
    const id = ++nextId;
    pending.set(id, r);
    out.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attach(url) {
  const { result: { targetId } } = await send("Target.createTarget", { url });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await sleep(2500);
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
    return r.result?.result?.value;
  };
  const reload = async () => {
    await send("Page.reload", {}, sessionId);
    await sleep(2500);
  };
  return { ev, reload };
}

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
};

const PROBE = `(async () => {
  const make = (attr, value) => { const el = document.createElement("div"); el.setAttribute(attr, value); el.textContent = "x"; document.body.append(el); return el; };
  const els = [make("class", "adsbygoogle"), make("id", "onetrust-banner-sdk"), make("class", "content")];
  await new Promise((r) => setTimeout(r, 600));
  return els.map((el) => getComputedStyle(el).display);
})()`;

try {
  const load = await send("Extensions.loadUnpacked", { path: EXT_DIR });
  if (load.error) throw new Error(JSON.stringify(load.error));
  const ext = load.result.id;
  await sleep(2000);

  const opt = await attach(`chrome-extension://${ext}/options/options.html`);
  const ev = opt.ev;
  const set = async (v) => {
    await ev(`chrome.storage.local.set(${JSON.stringify(v)})`);
    await sleep(2000);
  };
  const match = (url, type = "script", initiator = "https://example.com") =>
    ev(`chrome.declarativeNetRequest.testMatchOutcome({url:${JSON.stringify(url)},type:"${type}",initiator:"${initiator}",tabId:-1}).then(r=>r.matchedRules.length>0)`);

  check("all rulesets enabled", await ev("chrome.declarativeNetRequest.getEnabledRulesets().then(r=>r.sort())"), ["ads", "ads-extra", "annoyances", "annoyances-extra", "trackers", "trackers-extra"]);
  check("content scripts registered", await ev("chrome.scripting.getRegisteredContentScripts().then(s=>s.map(x=>x.id))"), ["cosmetic", "yt-main", "yt-skip"]);
  check("options page lists", await ev("document.querySelectorAll('#lists .row').length"), 3);
  check("blocks adsbygoogle.js", await match("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"), true);
  check("blocks google-analytics", await match("https://www.google-analytics.com/analytics.js"), true);
  check("blocks doubleclick image", await match("https://ad.doubleclick.net/x.gif", "image"), true);
  check("allows clean CDN script", await match("https://cdn.jsdelivr.net/npm/react@18.3.1/index.js"), false);
  check("blocks cland.day banner script", await match("https://cland.day/a8d52d3a/1.js", "script", "https://mangadot.net"), true);

  const page = await attach("https://example.com/");
  check("hides ad + cookie banner, keeps content", await page.ev(PROBE), ["none", "none", "block"]);

  check("hides injected data-rsch banner", await page.ev(`(async()=>{const d=document.createElement('div');d.setAttribute('data-rsch','');d.style.cssText='position:fixed;bottom:0;width:400px;height:100px';document.body.append(d);await new Promise(r=>setTimeout(r,600));return getComputedStyle(d).display})()`), "none");

  await set({ strictPopupSites: ["example.com"] });
  check("strict pop-up script registered", await ev("chrome.scripting.getRegisteredContentScripts().then(s=>s.find(x=>x.id==='no-popups')?.matches)"), ["*://*.example.com/*"]);
  await page.reload();
  check("strict mode stops window.open", await page.ev("(()=>{const w=window.open('https://ads.example.net/');return !!w && w.closed===false && typeof w.close==='function'})()"), true);
  await set({ strictPopupSites: [] });

  await set({ allowlist: ["example.com"], customFilters: "||blocked-by-me.test^\n@@||ok.test^\nexample.com##.target-x\n##.weird:has-text(x)\n/regex/" });
  check("custom filter status", await ev("chrome.runtime.sendMessage({type:'customStatus'})"), { networkRules: 2, skipped: 2 });
  check("custom network rule blocks", await match("https://blocked-by-me.test/a.js"), true);
  check("trusted site excluded from scripts", await ev("chrome.scripting.getRegisteredContentScripts().then(s=>s[0].excludeMatches)"), ["*://*.example.com/*"]);
  await page.reload();
  check("no hiding on trusted site", await page.ev(PROBE), ["block", "block", "block"]);
  check("popup sees trusted site", await ev("chrome.runtime.sendMessage({type:'popupState',tabId:-1,url:'https://www.example.com/x'}).then(s=>[s.hostname,s.allowlisted])"), ["example.com", true]);

  await set({ allowlist: [] });
  await page.reload();
  check("custom site hiding rule applies", await page.ev(`(async()=>{const a=document.createElement('div');a.className='target-x';document.body.append(a);await new Promise(r=>setTimeout(r,600));return getComputedStyle(a).display})()`), "none");

  await set({ enabled: false });
  check("pause clears everything", await ev("Promise.all([chrome.declarativeNetRequest.getEnabledRulesets(),chrome.scripting.getRegisteredContentScripts(),chrome.declarativeNetRequest.getDynamicRules()]).then(([a,b,c])=>[a.length,b.length,c.length])"), [0, 0, 0]);

  await set({ enabled: true, customFilters: "", enabledLists: ["ads"] });
  check("single list enabled", await ev("chrome.declarativeNetRequest.getEnabledRulesets().then(r=>r.sort())"), ["ads", "ads-extra"]);
  await page.reload();
  check("annoyance hiding off with list off", await page.ev(PROBE), ["none", "block", "block"]);

  check("picker injects", await ev(`chrome.tabs.query({}).then(async t=>{const tab=t.find(x=>(x.url||'').startsWith('https://example.com'));await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content/picker.js']});return true})`), true);
  check("picker overlay present", await page.ev("!!document.querySelector('mizpah-picker')"), true);

  if (WITH_REFRESH) {
    await set({ enabledLists: ["ads", "trackers", "annoyances"] });
    const status = await ev("chrome.runtime.sendMessage({type:'refreshLists'})");
    await sleep(2000);
    check("list update succeeded", [!!status.lastSuccess, status.errors], [true, []]);
    console.log("      " + Object.entries(status.lists).map(([id, l]) => `${id} +${l.added}/-${l.removed} of ${l.total}`).join(", "));
    const added = Object.values(status.lists).reduce((n, l) => n + l.added, 0);
    const removed = Object.values(status.lists).reduce((n, l) => n + l.removed, 0);
    const dynamic = await ev("chrome.declarativeNetRequest.getDynamicRules().then(r=>r.filter(x=>x.id>=100000).length)");
    check("new rules loaded as dynamic rules", dynamic, Math.min(added, 30000));
    const disabled = await ev(`Promise.all(["ads","ads-extra","trackers","trackers-extra","annoyances","annoyances-extra"].map(id=>chrome.declarativeNetRequest.getDisabledRuleIds({rulesetId:id}))).then(a=>a.flat().length)`);
    check("retired rules switched off", disabled, Math.min(removed, 5000));
    const domain = await ev(`chrome.storage.local.get('remoteNetwork').then(({remoteNetwork})=>{const r=Object.values(remoteNetwork).flat().find(r=>r.action.type==='block'&&/^\\|\\|[a-z0-9.-]+\\^$/.test(r.condition.urlFilter||'')&&Object.keys(r.condition).length===1);return r?r.condition.urlFilter.slice(2,-1):null})`);
    if (domain) check(`downloaded rule blocks ${domain}`, await match(`https://${domain}/x.js`), true);
    check("still blocks adsbygoogle.js", await match("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"), true);
    check("rebuild flagged", status.rebuild.length > 0, EXPECT_REBUILD);
    if (status.rebuild.length) console.log(`      reasons: ${status.rebuild.join("; ")}`);
    check("rebuild notification shown", await ev("chrome.notifications.getAll().then(n=>Object.keys(n))"), EXPECT_REBUILD ? ["rebuild-needed"] : []);
    check("toolbar badge", await ev("chrome.action.getBadgeText({})"), EXPECT_REBUILD ? "!" : "");
    const opt2 = await attach(`chrome-extension://${ext}/options/options.html`);
    console.log(`      settings: ${await opt2.ev("document.getElementById('updateInfo').textContent")}`);
    check("settings rebuild banner", await opt2.ev("!document.getElementById('rebuildBanner').hidden"), EXPECT_REBUILD);
    if (EXPECT_REBUILD) console.log(`      banner command: ${JSON.stringify(await opt2.ev("document.getElementById('rebuildCmd').textContent"))}`);
  }

  const yt = await attach("https://www.youtube.com/");
  check("youtube ad data stripped", await yt.ev(`JSON.stringify(JSON.parse('{"adPlacements":[1],"playerAds":[2],"videoDetails":{}}'))`), '{"videoDetails":{}}');
} catch (e) {
  failures++;
  console.error("ERROR", e.message);
}

chrome.kill();
rmSync(join(EXT_DIR, "_metadata"), { recursive: true, force: true });
setTimeout(() => rmSync(PROFILE, { recursive: true, force: true }), 500);
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
setTimeout(() => process.exit(failures ? 1 : 0), 600);
