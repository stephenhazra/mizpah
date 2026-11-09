#!/usr/bin/env node
import { rmSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, sleep, waitFor, stageExtension } from "./cdp.mjs";

const EXT_DIR = process.env.MIZPAH_DIR || join(dirname(fileURLToPath(import.meta.url)), "..");
const WITH_REFRESH = process.argv.includes("--refresh");
const EXPECT_REBUILD = process.argv.includes("--expect-rebuild");

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const FIXTURE = `<!doctype html><meta charset="utf-8"><title>fixture</title><body style="margin:0"><h1>fixture</h1>
<div class="cx-gen">gen</div><div class="cx-only">only</div><div class="cx-notsite">notsite</div><div data-cx>attr</div><div class="content">content</div>`;

const handler = (req, res) => {
  const url = new URL(req.url, "http://x");
  const headers = { "cache-control": "no-store" };
  if (url.pathname === "/probe.png") {
    res.writeHead(200, { ...headers, "content-type": "image/gif" }).end(GIF);
  } else if (url.pathname === "/chain" && url.searchParams.get("h")) {
    const [next, ...rest] = url.searchParams.get("h").split(",");
    res.writeHead(302, { ...headers, location: `http://${next}/chain?h=${rest.join(",")}` }).end();
  } else if (url.pathname.startsWith("/youtubei/")) {
    res.writeHead(200, { ...headers, "content-type": "application/json" }).end(JSON.stringify({ adPlacements: [1], videoDetails: { id: "x" }, playerResponse: { playerAds: [2] } }));
  } else {
    res.writeHead(200, { ...headers, "content-type": "text/html" }).end(FIXTURE);
  }
};
const server = createServer(handler);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

// youtube.com is HSTS-preloaded, so its fixture needs https with a throwaway certificate.
let tlsServer = null;
const certDir = mkdtempSync(join(tmpdir(), "mizpah-cert-"));
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=www.youtube.com", "-keyout", join(certDir, "k.pem"), "-out", join(certDir, "c.pem"), "-days", "1"], { stdio: "ignore" });
  tlsServer = createTlsServer({ key: readFileSync(join(certDir, "k.pem")), cert: readFileSync(join(certDir, "c.pem")) }, handler);
  await new Promise((r) => tlsServer.listen(0, "127.0.0.1", r));
} catch {
  tlsServer = null;
}
const TLS_PORT = tlsServer?.address().port;

const chrome = launchChrome({ extDir: EXT_DIR, args: [`--host-resolver-rules=MAP *.test 127.0.0.1:${PORT},MAP *.youtube.com 127.0.0.1:${TLS_PORT || PORT}`, "--ignore-certificate-errors"] });
const { proc, profile: PROFILE, send } = chrome;

const OPENER = "http://opener.test/";
const results = [];
let failures = 0;

async function check(name, fn, expected) {
  let actual;
  try {
    actual = await fn();
  } catch (e) {
    actual = `threw: ${e.message}`;
  }
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

async function attach(url) {
  const { result: { targetId } } = await send("Target.createTarget", { url });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const safe = async (expression) => {
    try {
      return await ev(expression);
    } catch {
      return undefined;
    }
  };
  const ready = (extra = "true") => waitFor(async () => (await safe(`document.readyState==='complete' && ${extra}`)) === true, { timeout: 15000, interval: 100 });
  await ready(`location.href.startsWith(${JSON.stringify(url)})`);
  const reload = async () => {
    await safe("window.__reloadMark=1");
    await send("Page.reload", {}, sessionId);
    await ready("window.__reloadMark===undefined");
  };
  const navigate = async (to) => {
    await send("Page.navigate", { url: to }, sessionId);
    await ready(`location.href.startsWith(${JSON.stringify(to)})`);
  };
  const clickAt = async (x, y) => {
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sessionId);
  };
  const gestureEval = (expression) => send("Runtime.evaluate", { expression, userGesture: true }, sessionId);
  const close = () => send("Target.closeTarget", { targetId });
  return { ev, reload, navigate, clickAt, gestureEval, close, sessionId, targetId };
}

const PROBE = `(async () => {
  const make = (attr, value) => { const el = document.createElement("div"); el.setAttribute(attr, value); el.textContent = "x"; document.body.append(el); return el; };
  const els = [make("class", "adsbygoogle"), make("id", "onetrust-banner-sdk"), make("class", "content")];
  const shown = () => els.map((el) => getComputedStyle(el).display);
  const end = Date.now() + (window.__expectHidden === false ? 800 : 4000);
  while (Date.now() < end && !(window.__expectHidden === false ? false : shown().slice(0, 2).every((d) => d === "none"))) await new Promise((r) => setTimeout(r, 50));
  return shown();
})()`;

try {
  const load = await send("Extensions.loadUnpacked", { path: EXT_DIR });
  if (load.error) throw new Error(JSON.stringify(load.error));
  const ext = load.result.id;

  const opt = await attach(`chrome-extension://${ext}/options/options.html`);
  const ev = opt.ev;
  await waitFor(async () => {
    try {
      return (await ev("Promise.all([chrome.declarativeNetRequest.getEnabledRulesets(),chrome.scripting.getRegisteredContentScripts()]).then(([a,b])=>a.length===6&&b.length>=3)")) === true;
    } catch {
      return false;
    }
  }, { timeout: 20000, interval: 200 });
  await ev("window.__created=[]; chrome.tabs.onCreated.addListener((t)=>__created.push(t.id)); true");
  const optionsTabId = await ev("chrome.tabs.getCurrent().then(t=>t.id)");

  const settle = async () => {
    await sleep(100);
    await ev("chrome.runtime.sendMessage({type:'customStatus'})");
  };
  const set = async (v, until) => {
    await ev(`chrome.storage.local.set(${JSON.stringify(v)})`);
    await settle();
    if (until) await waitFor(until, { timeout: 8000, interval: 100 });
  };
  const outcome = (url, type = "script", initiator = "http://opener.test") =>
    ev(`(async()=>{const r=await chrome.declarativeNetRequest.testMatchOutcome({url:${JSON.stringify(url)},type:"${type}",initiator:${JSON.stringify(initiator)},tabId:-1});
      const m=r.matchedRules[0]; if(!m) return "none"; if(m.rulesetId!=="_dynamic") return "static";
      return (await chrome.declarativeNetRequest.getDynamicRules()).find(x=>x.id===m.ruleId)?.action.type})()`);
  const match = async (url, type, initiator) => (await outcome(url, type, initiator)) !== "none";
  const dynamicCount = () => ev("chrome.declarativeNetRequest.getDynamicRules().then(r=>r.length)");
  const stored = (key) => ev(`Promise.all([chrome.storage.local.get(${JSON.stringify(key)}),chrome.storage.session?.get(${JSON.stringify(key)})]).then(([l,s])=>({...l[${JSON.stringify(key)}],...(s&&s[${JSON.stringify(key)}])}))`);
  const tabAlive = (id) => ev(`chrome.tabs.get(${id}).then(()=>true,()=>false)`);
  const enabledRulesets = () => ev("chrome.declarativeNetRequest.getEnabledRulesets().then(r=>r.sort())");
  const scriptIds = () => ev("chrome.scripting.getRegisteredContentScripts().then(s=>s.map(x=>x.id).sort())");
  const scriptField = (id, field) => ev(`chrome.scripting.getRegisteredContentScripts().then(s=>s.find(x=>x.id===${JSON.stringify(id)})?.${field})`);

  // Static configuration

  await check("all rulesets enabled", enabledRulesets, ["ads", "ads-extra", "annoyances", "annoyances-extra", "trackers", "trackers-extra"]);
  await check("content scripts registered", scriptIds, ["clicks", "cosmetic", "yt-main", "yt-skip"]);
  await check("options page lists", () => ev("document.querySelectorAll('#lists .row').length"), 3);
  await check("blocks adsbygoogle.js", () => match("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"), true);
  await check("blocks google-analytics", () => match("https://www.google-analytics.com/analytics.js"), true);
  await check("blocks doubleclick image", () => match("https://ad.doubleclick.net/x.gif", "image"), true);
  await check("allows clean CDN script", () => match("https://cdn.jsdelivr.net/npm/react@18.3.1/index.js"), false);
  await check("blocks cland.day banner script", () => match("https://cland.day/a8d52d3a/1.js", "script", "https://mangadot.net"), true);

  const page = await attach(OPENER);
  await check("hides bundled ad + cookie banner, keeps content", () => page.ev(PROBE), ["none", "none", "block"]);
  await check("hides injected data-rsch banner", () =>
    page.ev(`(async()=>{const d=document.createElement('div');d.setAttribute('data-rsch','');d.style.cssText='position:fixed;bottom:0;width:400px;height:100px';document.body.append(d);
      for(let i=0;i<80&&getComputedStyle(d).display!=='none';i++) await new Promise(r=>setTimeout(r,50));return getComputedStyle(d).display})()`), "none");

  // Trusted sites

  await set({ allowlist: ["opener.test"], customFilters: "||blocked-by-me.test^\n@@||ok.test^\nopener.test##.target-x\n##.weird:has-text(x)\n/regex/" }, async () => (await dynamicCount()) >= 3);
  await check("custom filter status", () => ev("chrome.runtime.sendMessage({type:'customStatus'})"), { networkRules: 2, skipped: 2 });
  await check("custom network rule blocks", () => match("https://blocked-by-me.test/a.js"), true);
  await check("trusted site excluded from cosmetic script", () => scriptField("cosmetic", "excludeMatches"), ["*://*.opener.test/*"]);
  await check("trusted site main frame gets allowAllRequests", () => outcome("http://opener.test/", "main_frame", "http://opener.test"), "allowAllRequests");
  await page.reload();
  await check("no hiding on trusted site", async () => {
    await page.ev("window.__expectHidden=false");
    return page.ev(PROBE);
  }, ["block", "block", "block"]);
  await check("popup sees trusted site", () => ev("chrome.runtime.sendMessage({type:'popupState',tabId:-1,url:'http://www.opener.test/x'}).then(s=>[s.hostname,s.allowlisted])"), ["opener.test", true]);

  await set({ allowlist: [] });
  await page.reload();
  await check("custom site hiding rule applies", () =>
    page.ev(`(async()=>{const a=document.createElement('div');a.className='target-x';document.body.append(a);
      for(let i=0;i<80&&getComputedStyle(a).display!=='none';i++) await new Promise(r=>setTimeout(r,50));return getComputedStyle(a).display})()`), "none");

  // Cosmetic details on local fixtures (custom filters only)

  const CX = `const d=(s)=>{const e=document.querySelector(s);return e?getComputedStyle(e).display:null};
    const read=()=>({gen:d('.cx-gen'),only:d('.cx-only'),notsite:d('.cx-notsite'),attr:d('[data-cx]')});`;
  const cxRead = (p, hiddenKey) =>
    p.ev(`(async()=>{${CX} for(let i=0;i<100&&read()[${JSON.stringify(hiddenKey)}]!=='none';i++) await new Promise(r=>setTimeout(r,50)); return read()})()`);
  await set({ customFilters: "##.cx-gen\ncx-site.test##.cx-only\n~cx-site.test##.cx-notsite\ncx-site.test#@#.cx-gen\n##div[data-cx]" }, async () => (await dynamicCount()) === 0);
  const cxSite = await attach("http://cx-site.test/");
  await check("site.test: site rule, exception and non-token rule", () => cxRead(cxSite, "only"), { gen: "block", only: "none", notsite: "block", attr: "none" });
  const cxOther = await attach("http://cx-other.test/");
  await check("other host: generic, ~domain and non-token rules, no site rule", () => cxRead(cxOther, "gen"), { gen: "none", only: "block", notsite: "none", attr: "none" });
  await check("elements added after load are hidden (insert and class change)", () =>
    cxOther.ev(`(async()=>{
      const a=document.createElement('span');a.className='cx-gen late';a.textContent='x';document.body.append(a);
      const b=document.createElement('div');b.textContent='y';document.body.append(b);b.className='cx-gen';
      const f=()=>[getComputedStyle(a).display,getComputedStyle(b).display];
      for(let i=0;i<100&&f().some(x=>x!=='none');i++) await new Promise(r=>setTimeout(r,50));return f()})()`), ["none", "none"]);
  await cxSite.close();
  await cxOther.close();

  await set({ customFilters: "@@||opener.test^$generichide" });
  await page.reload();
  await check("generichide exception keeps generic hiding off", async () => {
    await page.ev("window.__expectHidden=false");
    return page.ev(PROBE);
  }, ["block", "block", "block"]);

  // Network semantics through custom filters

  const NET = [
    "||cn-a.test^",
    "@@||cn-a.test/ok.js",
    "||cn-b.test^$important",
    "@@||cn-b.test^",
    "||cn-c.test^$third-party",
    "||cn-d.test^$script,image",
    "||cn-e.test^$domain=site-e.test|~sub.site-e.test",
    "@@||pagead2.googlesyndication.com^$script"
  ].join("\n");
  await set({ customFilters: NET }, async () => (await dynamicCount()) >= 8);
  await check("custom @@ beats custom block", () => outcome("http://cn-a.test/ok.js"), "allow");
  await check("custom block applies elsewhere on the host", () => outcome("http://cn-a.test/x.js"), "block");
  await check("$important beats @@", () => outcome("http://cn-b.test/x.js"), "block");
  await check("$third-party blocks third-party requests", () => outcome("http://cn-c.test/x.js", "script", "http://other.test"), "block");
  await check("$third-party spares first-party requests", () => outcome("http://cn-c.test/x.js", "script", "http://cn-c.test"), "none");
  await check("type filter blocks listed types", async () => [await outcome("http://cn-d.test/x", "script"), await outcome("http://cn-d.test/x", "image")], ["block", "block"]);
  await check("type filter spares other types", () => outcome("http://cn-d.test/x", "stylesheet"), "none");
  await check("$domain include and exclude", async () => [
    await outcome("http://cn-e.test/x", "script", "http://site-e.test"),
    await outcome("http://cn-e.test/x", "script", "http://other.test"),
    await outcome("http://cn-e.test/x", "script", "http://sub.site-e.test")
  ], ["block", "none", "none"]);
  await check("custom @@ beats a bundled block (priority bump)", () => outcome("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"), "allow");

  await set({ customFilters: "||cn-a.test^", allowlist: ["trust.test"] }, async () => (await dynamicCount()) === 2);
  const imageLoads = (p) =>
    p.ev(`new Promise((r)=>{const i=new Image();i.onload=()=>r('load');i.onerror=()=>r('error');i.src='http://cn-a.test/probe.png?'+Math.random()})`);
  const untrusted = await attach("http://untrusted.test/");
  const trusted = await attach("http://trust.test/");
  await check("blocked request fails on an untrusted page", () => imageLoads(untrusted), "error");
  await check("same request loads on a trusted page", () => imageLoads(trusted), "load");
  await untrusted.close();
  await trusted.close();
  await set({ customFilters: "", allowlist: [] });

  // Strict pop-up sites

  await set({ strictPopupSites: ["opener.test"] }, async () => (await scriptIds()).includes("no-popups"));
  await check("strict pop-up script registered", () => scriptField("no-popups", "matches"), ["*://*.opener.test/*"]);
  await page.reload();
  const created = () => ev("__created.length");
  await check("strict mode replaces window.open with an inert stub", () =>
    page.ev("(()=>{const d=Object.getOwnPropertyDescriptor(window,'open');const w=window.open('http://ads2.test/');return [d.writable,w.document,w.location.href,w.closed]})()"), [false, null, "about:blank", false]);
  await check("untrusted click on a cross-origin _blank link is stopped", async () => {
    const mark = await created();
    await page.ev("(()=>{const a=document.createElement('a');a.href='http://ads2.test/';a.target='_blank';a.textContent='x';document.body.append(a);a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))})()");
    await sleep(1200);
    return (await created()) - mark;
  }, 0);
  await check("a real click on the same kind of link still opens a tab", async () => {
    const mark = await created();
    const box = await page.ev(`(()=>{const a=document.createElement('a');a.href='http://ads3.test/';a.target='_blank';a.rel='noopener';a.style.cssText='position:fixed;left:10px;top:10px;width:300px;height:60px;display:block;font-size:30px;z-index:2147483647;background:#fff';a.textContent='real';document.body.append(a);return {x:30,y:30}})()`);
    await page.clickAt(box.x, box.y);
    return !!(await waitFor(async () => (await created()) > mark, { timeout: 5000, interval: 50 }));
  }, true);
  await ev("chrome.tabs.query({}).then(t=>Promise.all(t.filter(x=>/ads\\d\\.test/.test(x.url||x.pendingUrl||'')).map(x=>chrome.tabs.remove(x.id))))");
  await set({ strictPopupSites: [] }, async () => !(await scriptIds()).includes("no-popups"));
  await page.reload();
  await check("without strict mode window.open is the real one", () => page.ev("(()=>{const d=Object.getOwnPropertyDescriptor(window,'open');return [d.writable,/native code/.test(String(window.open))]})()"), [true, true]);

  // Apply behaviour

  const worker = await waitFor(async () => {
    const { result: { targetInfos } } = await send("Target.getTargets");
    return targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${ext}/`));
  }, { timeout: 8000, interval: 200 });
  const { result: { sessionId: workerSession } } = await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  const sw = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, workerSession)).result?.result?.value;
  await sw(`(() => {
    globalThis.__calls = { dynamic: 0, scripts: 0, unregister: 0, applies: 0 };
    const dnr = chrome.declarativeNetRequest;
    const update = dnr.updateDynamicRules.bind(dnr);
    dnr.updateDynamicRules = (o) => (__calls.dynamic++, update(o));
    const register = chrome.scripting.registerContentScripts.bind(chrome.scripting);
    chrome.scripting.registerContentScripts = (s) => (__calls.scripts++, register(s));
    const unregister = chrome.scripting.unregisterContentScripts.bind(chrome.scripting);
    chrome.scripting.unregisterContentScripts = (f) => (__calls.unregister++, unregister(f));
    const title = chrome.action.setTitle.bind(chrome.action);
    chrome.action.setTitle = (o) => (__calls.applies++, title(o));
    return true;
  })()`);
  const calls = () => sw("[__calls.dynamic, __calls.scripts, __calls.unregister, __calls.applies]");
  const resetCalls = () => sw("Object.assign(__calls, { dynamic: 0, scripts: 0, unregister: 0, applies: 0 })");

  await set({ customFilters: "||typed-rule.test^$script,third-party,domain=example.com" }, async () => (await dynamicCount()) === 1);
  await resetCalls();
  await set({ autoUpdate: false }, async () => ((await calls())?.[3] ?? 0) >= 1);
  await check("no-op apply leaves rules and scripts alone", async () => {
    const [dynamic, scripts, unregister, applies] = await calls();
    return [dynamic, scripts, unregister, applies >= 1];
  }, [0, 0, 0, true]);
  await check("no-op apply keeps the typed custom rule and all scripts", async () => [await dynamicCount(), (await scriptIds()).length], [1, 4]);
  await set({ autoUpdate: true, customFilters: "" });
  await resetCalls();
  await ev("chrome.runtime.sendMessage({type:'toggleStrictPopups',hostname:'strict-a.test',strict:true})");
  await settle();
  await check("one apply per settings change (strict toggle)", async () => {
    const [, scripts, , applies] = await calls();
    return [scripts, applies];
  }, [1, 1]);
  await check("toggleStrictPopups stores the host sorted", async () => {
    await ev("chrome.runtime.sendMessage({type:'toggleStrictPopups',hostname:'a-first.test',strict:true})");
    return (await ev("chrome.storage.local.get('strictPopupSites')")).strictPopupSites;
  }, ["a-first.test", "strict-a.test"]);
  await ev("chrome.runtime.sendMessage({type:'toggleStrictPopups',hostname:'strict-a.test',strict:false})");
  await set({ strictPopupSites: [] });

  await check("toggleSite adds and removes via subdomain", async () => {
    await ev("chrome.runtime.sendMessage({type:'toggleSite',hostname:'a.b.toggle.test',allow:true})");
    const added = (await ev("chrome.storage.local.get('allowlist')")).allowlist;
    await ev("chrome.runtime.sendMessage({type:'toggleSite',hostname:'a.b.toggle.test',allow:false})");
    const removed = (await ev("chrome.storage.local.get('allowlist')")).allowlist;
    await ev("chrome.runtime.sendMessage({type:'toggleSite',hostname:'toggle.test',allow:true})");
    await ev("chrome.runtime.sendMessage({type:'toggleSite',hostname:'www.a.toggle.test',allow:false})");
    return [added, removed, (await ev("chrome.storage.local.get('allowlist')")).allowlist];
  }, [["a.b.toggle.test"], [], []]);

  // Settings validation

  await check("bad stored types do not break apply and fall back to defaults", async () => {
    await ev("chrome.storage.local.set({allowlist:'x',enabledLists:null,strictPopupSites:[1,2],youtube:'no'})");
    await settle();
    const status = await ev("chrome.runtime.sendMessage({type:'customStatus'})");
    return [typeof status.networkRules, await enabledRulesets()];
  }, ["number", ["ads", "ads-extra", "annoyances", "annoyances-extra", "trackers", "trackers-extra"]]);
  await set({ allowlist: [], enabledLists: ["ads", "trackers", "annoyances"], strictPopupSites: [], youtube: true });

  // Pop-up guard (local hosts, each check has a positive control)

  const learned = (d, t = Date.now()) => ({ d, t });
  const tabIds = () => ev("chrome.tabs.query({}).then(t=>t.map(x=>x.id))");
  const closeStray = async (keep) => {
    const now = await tabIds();
    for (const id of now) if (!keep.includes(id)) await ev(`chrome.tabs.remove(${id}).catch(()=>{})`);
  };
  const pageTabId = await ev(`chrome.tabs.query({}).then(t=>t.find(x=>(x.url||'').startsWith(${JSON.stringify(OPENER)})).id)`);
  const keep = await tabIds();
  const blockedCount = async () => (await ev("chrome.storage.local.get('popupsBlocked')")).popupsBlocked || 0;
  const closedFor = (id) => ev(`chrome.runtime.sendMessage({type:'popupState',tabId:${id},url:${JSON.stringify(OPENER)}}).then(s=>s.popupsClosed)`);

  // Opens a tab from the page and reports whether it was created, and whether it was closed within the wait.
  async function openFromPage(url, { wait, how = "script", box, from = page } = {}) {
    const mark = await created();
    if (how === "script") await from.gestureEval(`void window.open(${JSON.stringify(url)})`);
    else await from.clickAt(box.x, box.y);
    if (!(await waitFor(async () => (await created()) > mark, { timeout: 5000, interval: 25 }))) return "never opened";
    const id = (await ev(`__created.slice(${mark})`))[0];
    const closed = await waitFor(async () => !(await tabAlive(id)), { timeout: wait, interval: 50 });
    return closed ? "closed" : "open";
  }
  const addLink = (href, style = "", p = page) =>
    p.ev(`(()=>{document.querySelectorAll('a.mz').forEach(a=>a.remove());
      const a=document.createElement('a');a.className='mz';a.href=${JSON.stringify(href)};a.target='_blank';a.rel='noopener';
      a.style.cssText='position:fixed;left:10px;top:10px;width:300px;height:60px;display:block;font-size:30px;z-index:2147483647;background:#fff;${style}';a.textContent='link';
      document.body.append(a);const r=a.getBoundingClientRect();return {x:r.left+20,y:r.top+20}})()`);

  await set({ enabled: true, blockPopups: true, allowlist: [], strictPopupSites: [], customFilters: "", learnedPopups: [learned("learned.test")] });
  await page.reload();
  const before = await blockedCount();
  await check("unclicked pop-up to a learned site is closed", () => openFromPage("http://learned.test/?p=1", { wait: 8000 }), "closed");
  await check("closed pop-up is counted (popupsBlocked, per-tab count)", async () => {
    await waitFor(async () => (await closedFor(pageTabId)) >= 1, { timeout: 5000, interval: 100 });
    return [(await blockedCount()) - before, await closedFor(pageTabId)];
  }, [1, 1]);

  const popupUi = await attach(`chrome-extension://${ext}/popup/popup.html?tab=${pageTabId}`);
  keep.push(...(await tabIds()).filter((id) => !keep.includes(id)));
  const popupState = async () => (await popupUi.ev(`(()=>({host:document.getElementById('host').textContent,paused:document.body.classList.contains('paused'),
    popupsHidden:document.getElementById('popups').hidden,popups:document.getElementById('popups').textContent,
    toggleOff:document.getElementById('toggleSite').classList.contains('off'),pickerDisabled:document.getElementById('picker').disabled,
    strictOn:document.getElementById('strictPopups').getAttribute('aria-pressed'),rebuildHidden:document.getElementById('rebuild').hidden,
    toggleHidden:document.getElementById('toggleSite').hidden}))()`).catch(() => null)) || {};
  const popupClick = (id) => popupUi.ev(`document.getElementById(${JSON.stringify(id)}).click()`);
  await waitFor(async () => (await popupState()).host === "opener.test", { timeout: 8000, interval: 100 });
  await check("popup shows the host and the closed pop-up count", async () => {
    const s = await popupState();
    return [s.host, s.popupsHidden, s.popups, s.toggleOff, s.pickerDisabled];
  }, ["opener.test", false, "1 pop-up closed", false, false]);

  // Each click scenario uses a fresh opener tab so earlier clicks cannot count as recent.
  const clickScenario = async (href, { style = "", wait, rewrite } = {}) => {
    const p = await attach(OPENER);
    const box = await addLink(href, style, p);
    if (rewrite) await p.ev(`document.querySelector('a.mz').addEventListener('click',(e)=>{e.preventDefault();window.open(${JSON.stringify(rewrite)})})`);
    const result = await openFromPage("", { how: "click", box, wait, from: p });
    await p.close();
    await closeStray(keep);
    return result;
  };
  await check("clicked link to a learned site stays open", () => clickScenario("http://learned.test/?p=2", { wait: 2000 }), "open");
  await check("same URL opened by script without a click is closed", async () => {
    const p = await attach(OPENER);
    const result = await openFromPage("http://learned.test/?p=2", { wait: 8000, from: p });
    await p.close();
    return result;
  }, "closed");
  await check("click on a transparent link is not a deliberate click", () => clickScenario("http://learned.test/?p=3", { style: "opacity:0;", wait: 8000 }), "closed");
  await check("click on a tiny link is not a deliberate click", () => clickScenario("http://learned.test/?p=4", { style: "width:1px;height:1px;", wait: 8000 }), "closed");

  await check("redirect chain from an unclicked pop-up is closed and the first domain learned", async () => {
    const result = await openFromPage("http://hop.test/chain?h=hop-b.test,hop-c.test", { wait: 10000 });
    const list = await waitFor(async () => ((await ev("chrome.storage.local.get('learnedPopups')")).learnedPopups || []).map((l) => l?.d).includes("hop.test"), { timeout: 5000, interval: 100 });
    return [result, !!list];
  }, ["closed", true]);
  await check("redirect chain from a clicked link whose first hop matches stays open", () => clickScenario("http://hop2.test/chain?h=hop2-b.test,hop2-c.test", { wait: 3000 }), "open");
  await check("redirect chain from a clicked link with a different first hop is closed", () =>
    clickScenario("http://hop3.test/", { rewrite: "http://hop4.test/chain?h=hop4-b.test,hop4-c.test", wait: 10000 }), "closed");

  await set({ learnedPopups: [learned("old.test", Date.now() - 31 * 86400000), "str.test", null, { d: 5, t: Date.now() }] });
  await check("expired and malformed learned entries do not close pop-ups", async () => [
    await openFromPage("http://old.test/", { wait: 1800 }),
    await openFromPage("http://str.test/", { wait: 1800 })
  ], ["open", "open"]);
  await closeStray(keep);

  const visit = await attach("http://visit.test/");
  await check("sites you visit yourself are remembered", async () => !!(await waitFor(async () => Object.keys(await stored("visitedDomains")).includes("visit.test"), { timeout: 8000, interval: 100 })), true);
  await check("a visited domain is not learned from a redirect-chain pop-up", async () => {
    const result = await openFromPage("http://visit.test/chain?h=visit-b.test,visit-c.test", { wait: 10000 });
    await sleep(600);
    return [result, ((await ev("chrome.storage.local.get('learnedPopups')")).learnedPopups || []).some((l) => l?.d === "visit.test")];
  }, ["closed", false]);
  await visit.close();
  await closeStray(keep);

  await set({ learnedPopups: [learned("learned.test")], blockPopups: false });
  await check("nothing is closed when pop-up blocking is off", () => openFromPage("http://learned.test/?off=1", { wait: 1800 }), "open");
  await closeStray(keep);
  await set({ blockPopups: true, allowlist: ["opener.test"] });
  await check("nothing is closed on a trusted opener", () => openFromPage("http://learned.test/?off=2", { wait: 1800 }), "open");
  await closeStray(keep);
  await set({ allowlist: [], enabled: false });
  await check("nothing is closed while paused", () => openFromPage("http://learned.test/?off=3", { wait: 1800 }), "open");
  await closeStray(keep);
  await set({ enabled: true });
  await check("learned entries are forgotten on request and the matcher resets", async () => {
    await ev("chrome.runtime.sendMessage({type:'clearLearnedPopups'})");
    await sleep(200);
    const result = await openFromPage("http://learned.test/?forgot=1", { wait: 1800 });
    await closeStray(keep);
    return [result, ((await ev("chrome.storage.local.get('learnedPopups')")).learnedPopups || []).length];
  }, ["open", 0]);
  await page.reload();
  await check("per-tab closed count resets after the opener navigates", () => closedFor(pageTabId), 0);

  // Popup UI flows

  await set({ strictPopupSites: [], allowlist: [] });
  await popupUi.reload();
  await waitFor(async () => (await popupState()).host === "opener.test", { timeout: 8000, interval: 100 });
  await check("popup hides the closed-pop-up line when none were closed", async () => (await popupState()).popupsHidden, true);
  await check("popup: trusting a site flips the button and applies rules", async () => {
    await popupClick("toggleSite");
    await waitFor(async () => (await popupState()).toggleOff, { timeout: 6000, interval: 100 });
    const s = await popupState();
    await settle();
    const rule = await ev("chrome.declarativeNetRequest.getDynamicRules().then(r=>r.some(x=>x.action.type==='allowAllRequests'&&x.condition.requestDomains?.includes('opener.test')))");
    return [s.toggleOff, s.pickerDisabled, (await ev("chrome.storage.local.get('allowlist')")).allowlist, rule, await scriptField("cosmetic", "excludeMatches")];
  }, [true, true, ["opener.test"], true, ["*://*.opener.test/*"]]);
  await check("popup: un-trusting reverts everything", async () => {
    await popupClick("toggleSite");
    await waitFor(async () => !(await popupState()).toggleOff, { timeout: 6000, interval: 100 });
    await settle();
    return [(await popupState()).pickerDisabled, (await ev("chrome.storage.local.get('allowlist')")).allowlist, await dynamicCount(), (await scriptField("cosmetic", "excludeMatches")) || []];
  }, [false, [], 0, []]);
  await check("popup: strict toggle stores the host and registers the script", async () => {
    await popupClick("strictPopups");
    await waitFor(async () => (await popupState()).strictOn === "true", { timeout: 6000, interval: 100 });
    await settle();
    return [(await ev("chrome.storage.local.get('strictPopupSites')")).strictPopupSites, await scriptField("no-popups", "matches")];
  }, [["opener.test"], ["*://*.opener.test/*"]]);
  await popupClick("strictPopups");
  await waitFor(async () => (await popupState()).strictOn === "false", { timeout: 6000, interval: 100 });
  await check("popup: power off pauses everything", async () => {
    await popupClick("power");
    await waitFor(async () => (await popupState()).paused, { timeout: 6000, interval: 100 });
    await settle();
    return [await enabledRulesets(), (await scriptIds()).length];
  }, [[], 0]);
  await popupClick("power");
  await waitFor(async () => !(await popupState()).paused, { timeout: 6000, interval: 100 });
  await settle();
  await check("popup: power on restores all rulesets and scripts", async () => [(await enabledRulesets()).length, (await scriptIds()).length], [6, 4]);
  await check("popup: rebuild notice shows when a rebuild is flagged", async () => {
    await ev("chrome.storage.local.set({listUpdate:{rebuild:['test reason']}})");
    await popupUi.reload();
    await waitFor(async () => (await popupState()).host === "opener.test", { timeout: 8000, interval: 100 });
    const shown = !(await popupState()).rebuildHidden;
    await ev("chrome.storage.local.remove('listUpdate')");
    return shown;
  }, true);
  await popupUi.close();
  const popupOnExtPage = await attach(`chrome-extension://${ext}/popup/popup.html?tab=${optionsTabId}`);
  await waitFor(async () => (await popupOnExtPage.ev("document.getElementById('host').textContent")) !== "—", { timeout: 8000, interval: 100 });
  await check("popup: non-web page cannot be filtered", () => popupOnExtPage.ev("[document.getElementById('host').textContent, document.getElementById('toggleSite').hidden]"), ["This page can't be filtered", true]);
  await popupOnExtPage.close();

  // Options page flows

  await check("options: list switch writes enabledLists in LISTS order", async () => {
    await ev("document.querySelectorAll('#lists input')[1].click()");
    await waitFor(async () => (await enabledRulesets()).length === 4, { timeout: 6000, interval: 100 });
    const off = (await ev("chrome.storage.local.get('enabledLists')")).enabledLists;
    await ev("document.querySelectorAll('#lists input')[1].click()");
    await waitFor(async () => (await enabledRulesets()).length === 6, { timeout: 6000, interval: 100 });
    return [off, (await ev("chrome.storage.local.get('enabledLists')")).enabledLists];
  }, [["ads", "annoyances"], ["ads", "trackers", "annoyances"]]);
  await check("options: trusted-site list is normalised and saved", async () => {
    await ev(`document.getElementById('allowlist').value=" HTTPS://www.Foo.test/path\\na..b\\nfoo.test"; document.getElementById('saveAllowlist').click()`);
    await waitFor(async () => (await ev("document.getElementById('allowStatus').textContent")) !== "", { timeout: 4000, interval: 50 });
    return [(await ev("chrome.storage.local.get('allowlist')")).allowlist, await ev("document.getElementById('allowStatus').textContent")];
  }, [["foo.test"], "Saved 1 site"]);
  await set({ allowlist: [] });
  await check("options: custom filter save reports rules and skipped lines", async () => {
    await ev(`document.getElementById('custom').value="||opt-a.test^\\n/regex/"; document.getElementById('saveCustom').click()`);
    await waitFor(async () => (await ev("document.getElementById('customStatus').textContent")) !== "", { timeout: 6000, interval: 50 });
    return ev("document.getElementById('customStatus').textContent");
  }, "Saved · 1 network rules active · 1 unsupported lines ignored");
  await set({ customFilters: "" });

  // Picker

  await set({ enabledLists: ["ads"] });
  await page.reload();
  await check("annoyance hiding off with list off", async () => {
    await page.ev("window.__expectHidden=false");
    const shown = await page.ev(PROBE);
    return shown;
  }, ["none", "block", "block"]);
  await check("single list enabled", enabledRulesets, ["ads", "ads-extra"]);
  await check("picker injects and shows its overlay", async () => {
    await ev(`chrome.scripting.executeScript({target:{tabId:${pageTabId}},files:['content/picker.js']})`);
    return page.ev("!!document.querySelector('mizpah-picker')");
  }, true);
  await set({ enabledLists: ["ads", "trackers", "annoyances"], customFilters: "" });

  const pressEnter = async () => {
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) }, page.sessionId);
  };
  const pickTarget = async (arm) => {
    await page.reload();
    await page.ev(`(()=>{const d=document.createElement('div');d.id='pick-me';d.textContent='pick';d.style.cssText='position:fixed;left:40px;top:200px;width:200px;height:80px;background:#ccc;z-index:2147483000';document.body.append(d);return true})()`);
    if (arm) await ev(`chrome.runtime.sendMessage({type:'armPicker',tabId:${pageTabId}})`);
    await ev(`chrome.scripting.executeScript({target:{tabId:${pageTabId}},files:['content/picker.js']})`);
    await page.clickAt(100, 230);
    await sleep(150);
    await pressEnter();
  };
  const customText = async () => (await ev("chrome.storage.local.get('customFilters')")).customFilters;
  await check("picker: an armed pick saves one site filter and hides the element", async () => {
    await pickTarget(true);
    await waitFor(async () => (await customText()) !== "", { timeout: 4000, interval: 100 });
    return [await customText(), await page.ev("getComputedStyle(document.getElementById('pick-me')).display")];
  }, ["opener.test###pick-me", "none"]);
  await set({ customFilters: "" });
  await check("picker: a pick without arming from the popup is ignored", async () => {
    await pickTarget(false);
    await sleep(800);
    return customText();
  }, "");
  const fromContent = (msg) =>
    ev(`chrome.scripting.executeScript({target:{tabId:${pageTabId}},func:(m)=>chrome.runtime.sendMessage(m).then((r)=>r??'no reply',(e)=>'rejected'),args:[${JSON.stringify(msg)}]}).then(r=>r[0].result)`);
  await check("content scripts can't add filters for other sites or reuse an arm", async () => {
    await ev(`chrome.runtime.sendMessage({type:'armPicker',tabId:${pageTabId}})`);
    const other = await fromContent({ type: "addFilter", line: "other.test##div" });
    await ev(`chrome.runtime.sendMessage({type:'armPicker',tabId:${pageTabId}})`);
    const network = await fromContent({ type: "addFilter", line: "opener.test##div\n||ads.test^" });
    await ev(`chrome.runtime.sendMessage({type:'armPicker',tabId:${pageTabId}})`);
    const first = await fromContent({ type: "addFilter", line: "opener.test##.once" });
    const again = await fromContent({ type: "addFilter", line: "opener.test##.twice" });
    return [other, network, first, again, await customText()];
  }, [false, false, true, false, "opener.test##.once"]);
  await set({ customFilters: "" });
  await check("content scripts can't call settings messages", async () => [
    await fromContent({ type: "setEnabled", enabled: false }),
    (await ev("chrome.storage.local.get('enabled')")).enabled
  ], ["no reply", true]);

  // Settings import

  const importBackup = (data, answer) =>
    ev(`(async()=>{window.confirm=()=>${answer};const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(JSON.stringify(data))}],'b.json',{type:'application/json'}));
      const i=document.getElementById('importFile');i.files=dt.files;document.getElementById('backupStatus').textContent='';i.dispatchEvent(new Event('change'));return true})()`);
  await check("import: declining the confirmation changes nothing", async () => {
    await importBackup({ allowlist: ["imported.test"] }, false);
    await sleep(500);
    return (await ev("chrome.storage.local.get('allowlist')")).allowlist;
  }, []);
  await check("import: valid keys apply and invalid ones are reported", async () => {
    await importBackup({ strictPopupSites: ["imported.test"], allowlist: ["imported.test", "com"], blockPopups: "yes", unknown: 1 }, true);
    await waitFor(async () => (await ev("document.getElementById('backupStatus').textContent")) !== "", { timeout: 4000, interval: 50 });
    const stored = await ev("chrome.storage.local.get(['strictPopupSites','allowlist','blockPopups','unknown'])");
    return [[stored.strictPopupSites, stored.allowlist, stored.blockPopups, stored.unknown ?? null], await ev("document.getElementById('backupStatus').textContent")];
  }, [[["imported.test"], [], true, null], "Imported, but skipped invalid allowlist, blockPopups"]);
  await set({ strictPopupSites: [] });

  // Update cleanup on a staged copy

  await check("an update clears downloaded rules and old browsing data", async () => {
    const copy = mkdtempSync(join(tmpdir(), "mizpah-update-"));
    cpSync(stageExtension(EXT_DIR), copy, { recursive: true });
    const loaded = await send("Extensions.loadUnpacked", { path: copy });
    if (loaded.error) throw new Error(JSON.stringify(loaded.error));
    const id = loaded.result.id;
    await sleep(1500);
    const url = `chrome-extension://${id}/options/options.html`;
    const before = await attach(url);
    await before.ev(`chrome.storage.local.set({remoteNetwork:{ads:[]},remoteRetired:{ads:[]},visitedDomains:{'a.test':1},lastPopup:{},allowlist:['kept.test']})`);
    const manifestFile = join(copy, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, version: "999.0.0" }));
    await before.close();
    const reloaded = await send("Extensions.loadUnpacked", { path: copy });
    if (reloaded.result?.id !== id) throw new Error(`reload gave ${JSON.stringify(reloaded)}`);
    await sleep(1500);
    const after = await attach(url);
    await waitFor(async () => {
      const ok = await after.ev("typeof chrome.storage?.local?.get === 'function'").catch(() => false);
      if (!ok) await after.reload().catch(() => {});
      return ok;
    }, { timeout: 15000, interval: 500 });
    const keys = ["remoteNetwork", "remoteRetired", "visitedDomains", "lastPopup", "allowlist"];
    const left = await waitFor(async () => {
      const got = await after.ev(`chrome.storage.local.get(${JSON.stringify(keys)})`);
      return Object.keys(got).length === 1 ? got : null;
    }, { timeout: 8000, interval: 200 });
    const version = await after.ev("chrome.runtime.getManifest().version");
    await after.close();
    await send("Extensions.uninstall", { id }).catch(() => {});
    rmSync(copy, { recursive: true, force: true });
    return [version, left];
  }, ["999.0.0", { allowlist: ["kept.test"] }]);

  // YouTube on a local fixture served as www.youtube.com

  const yt = await attach("https://www.youtube.com/");
  await check("youtube: JSON.parse strips ad keys", () => yt.ev(`JSON.stringify(JSON.parse('{"adPlacements":[1],"playerAds":[2],"videoDetails":{}}'))`), '{"videoDetails":{}}');
  await check("youtube: Response.json strips ad keys", () => yt.ev(`fetch('/youtubei/v1/player').then(r=>r.json()).then(j=>JSON.stringify(j))`), '{"videoDetails":{"id":"x"},"playerResponse":{}}');
  await check("youtube: Response.text strips ad keys on player URLs", () => yt.ev(`fetch('/youtubei/v1/player').then(r=>r.text()).then(t=>/adPlacements|playerAds/.test(t))`), false);
  await check("youtube: ytInitialPlayerResponse setter prunes", () => yt.ev(`(()=>{window.ytInitialPlayerResponse={adPlacements:[1],videoDetails:{}};return JSON.stringify(window.ytInitialPlayerResponse)})()`), '{"videoDetails":{}}');
  await check("youtube: bodies without ads are returned untouched", () => yt.ev(`new Response('{"a":1}').text()`), '{"a":1}');
  await yt.close();
  await check("youtube scripts are not registered when the setting is off", async () => {
    await set({ youtube: false }, async () => !(await scriptIds()).includes("yt-main"));
    const off = await scriptIds();
    await set({ youtube: true }, async () => (await scriptIds()).includes("yt-main"));
    return [off.some((id) => id.startsWith("yt-")), (await scriptIds()).filter((id) => id.startsWith("yt-"))];
  }, [false, ["yt-main", "yt-skip"]]);

  if (WITH_REFRESH) {
    await set({ enabledLists: ["ads", "trackers", "annoyances"] });
    const status = await ev("chrome.runtime.sendMessage({type:'refreshLists'})");
    await waitFor(async () => !!(await ev("chrome.storage.local.get('listUpdate')")).listUpdate?.lastSuccess, { timeout: 30000, interval: 500 });
    await check("list update succeeded", () => [!!status.lastSuccess, status.errors], [true, []]);
    console.log("      " + Object.entries(status.lists).map(([id, l]) => `${id} +${l.added}/-${l.removed} of ${l.total}`).join(", "));
    const added = Object.values(status.lists).reduce((n, l) => n + l.added, 0);
    const removed = Object.values(status.lists).reduce((n, l) => n + l.removed, 0);
    await check("new rules loaded as dynamic rules", () => ev("chrome.declarativeNetRequest.getDynamicRules().then(r=>r.filter(x=>x.id>=100000).length)"), Math.min(added, 30000));
    await check("retired rules switched off", () => ev(`Promise.all(["ads","ads-extra","trackers","trackers-extra","annoyances","annoyances-extra"].map(id=>chrome.declarativeNetRequest.getDisabledRuleIds({rulesetId:id}))).then(a=>a.flat().length)`), Math.min(removed, 5000));
    const domain = await ev(`chrome.storage.local.get('remoteNetwork').then(({remoteNetwork})=>{const r=Object.values(remoteNetwork||{}).flat().find(r=>r.action.type==='block'&&/^\\|\\|[a-z0-9.-]+\\^$/.test(r.condition.urlFilter||'')&&Object.keys(r.condition).length===1);return r?r.condition.urlFilter.slice(2,-1):null})`);
    await check("a downloaded plain-domain rule exists", () => !!domain, true);
    if (domain) await check(`downloaded rule blocks ${domain}`, () => match(`https://${domain}/x.js`), true);
    await check("still blocks adsbygoogle.js", () => match("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"), true);
    await check("rebuild flagged", () => status.rebuild.length > 0, EXPECT_REBUILD);
    if (status.rebuild.length) console.log(`      reasons: ${status.rebuild.join("; ")}`);
    await check("rebuild notification shown", () => ev("chrome.notifications.getAll().then(n=>Object.keys(n))"), EXPECT_REBUILD ? ["rebuild-needed"] : []);
    await check("toolbar badge", () => ev("chrome.action.getBadgeText({})"), EXPECT_REBUILD ? "!" : "");
    const opt2 = await attach(`chrome-extension://${ext}/options/options.html`);
    console.log(`      settings: ${await opt2.ev("document.getElementById('updateInfo').textContent")}`);
    await check("settings rebuild banner", () => opt2.ev("!document.getElementById('rebuildBanner').hidden"), EXPECT_REBUILD);
  }
} catch (e) {
  failures++;
  console.error("ERROR", e.message);
}

try {
  proc.kill();
} catch {}
server.close();
tlsServer?.close();
rmSync(certDir, { recursive: true, force: true });
rmSync(join(EXT_DIR, "_metadata"), { recursive: true, force: true });
setTimeout(() => rmSync(PROFILE, { recursive: true, force: true }), 500);
console.log(failures ? `\n${failures} of ${results.length} check(s) failed` : `\nAll ${results.length} checks passed`);
setTimeout(() => process.exit(failures ? 1 : 0), 700);
