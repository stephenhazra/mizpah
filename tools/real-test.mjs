#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = process.env.MIZPAH_DIR || join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = mkdtempSync(join(tmpdir(), "mizpah-real-"));
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const SITES = process.argv.slice(2).filter((a) => a.startsWith("http"));
const DEFAULT_SITES = [
  "https://www.forbes.com/",
  "https://www.dailymail.co.uk/home/index.html",
  "https://www.cnn.com/",
  "https://weather.com/",
  "https://www.speedtest.net/",
  "https://www.merriam-webster.com/dictionary/advertisement",
  "https://www.fandom.com/"
];
const AD_HOST = /doubleclick|googlesyndication|googleadservices|google-analytics|googletagmanager|adservice\.google|amazon-adsystem|adnxs|criteo|taboola|outbrain|pubmatic|rubiconproject|openx|casalemedia|scorecardresearch|moatads|adsrvr|teads|sharethrough|33across|media\.net|quantserve|chartbeat|hotjar|facebook\.net|bat\.bing|clarity\.ms|indexww|yieldmo|smartadserver|adform|krxd|bluekai|demdex|omtrdc|permutive|id5-sync|ads\./i;

const chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=${PROFILE}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "--no-first-run", `--user-agent=${UA}`, "--window-size=1366,900", "about:blank"], {
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
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]);

async function attach(url, wait = 2500) {
  const { result: { targetId } } = await send("Target.createTarget", { url });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await sleep(wait);
  const ev = async (expression) => {
    const r = await withTimeout(send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId), 30000);
    if (!r) throw new Error("evaluate timed out");
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
    return r.result?.result?.value;
  };
  const close = () => send("Target.closeTarget", { targetId });
  return { ev, close };
}

const MEASURE = `(async () => {
  for (let y = 0; y < 6; y++) { window.scrollBy(0, innerHeight); await new Promise(r => setTimeout(r, 700)); }
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 1000));
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 30 && r.height > 30 && s.display !== "none" && s.visibility !== "hidden"; };
  const adHost = ${AD_HOST};
  const adFrames = [...document.querySelectorAll("iframe")].filter(f => visible(f) && (adHost.test(f.src) || /google_ads|aswift|ad_iframe|div-gpt/i.test(f.id + " " + f.name))).length;
  const adSlots = [...document.querySelectorAll('ins.adsbygoogle, [id^="div-gpt-ad"], [id^="google_ads"], [data-google-query-id], .taboola, [id^="taboola-"], .OUTBRAIN, .trc_rbox_container, [data-ad-slot], [class*="ad-slot"], [class*="AdSlot"], [id*="ad-slot"], ytd-ad-slot-renderer')].filter(visible).length;
  const resources = performance.getEntriesByType("resource");
  const adRequests = resources.filter(r => adHost.test(new URL(r.name).hostname)).length;
  return { requests: resources.length, adRequests, adFrames, adSlots, title: document.title.slice(0, 40) };
})()`;

const rows = [];
try {
  const load = await send("Extensions.loadUnpacked", { path: EXT_DIR });
  if (load.error) throw new Error(JSON.stringify(load.error));
  const ext = load.result.id;
  await sleep(2000);
  const opt = await attach(`chrome-extension://${ext}/options/options.html`);
  const setEnabled = async (enabled) => {
    await opt.ev(`chrome.runtime.sendMessage({type:"setEnabled",enabled:${enabled}})`);
    await sleep(1500);
  };
  const blockedOn = (url) =>
    opt.ev(`chrome.tabs.query({}).then(async t=>{const tab=t.find(x=>(x.url||"").startsWith(${JSON.stringify(new URL(url).origin)}));if(!tab)return null;const r=await chrome.declarativeNetRequest.getMatchedRules({tabId:tab.id});return r.rulesMatchedInfo.length})`);

  for (const url of SITES.length ? SITES : DEFAULT_SITES) {
    const result = { site: new URL(url).hostname.replace(/^www\./, "") };
    for (const mode of ["on", "off"]) {
      await setEnabled(mode === "on");
      let page;
      try {
        page = await attach(url, 9000);
        const m = await page.ev(MEASURE);
        if (mode === "on") m.blocked = await blockedOn(url).catch(() => null);
        result[mode] = m;
      } catch (e) {
        result[mode] = { error: e.message.split("\n")[0] };
      } finally {
        await page?.close();
      }
    }
    rows.push(result);
    const f = (m) => (m?.error ? `error: ${m.error}` : `${m.adSlots} ad slots, ${m.adFrames} ad iframes, ${m.adRequests} ad/tracker requests of ${m.requests}`);
    console.log(`${result.site}\n  blocking ON : ${f(result.on)}${result.on?.blocked != null ? `, ${result.on.blocked} blocked by Mizpah` : ""}\n  blocking OFF: ${f(result.off)}`);
  }
  await setEnabled(true);

  const yt = await attach("https://www.youtube.com/watch?v=jNQXAC9IVRw", 9000);
  const ytResult = await yt.ev(`(async()=>{await new Promise(r=>setTimeout(r,4000));const p=document.querySelector('#movie_player');return {player:!!p,adShowing:!!p&&p.classList.contains('ad-showing'),adPlacements:!!(window.ytInitialPlayerResponse&&(ytInitialPlayerResponse.adPlacements||ytInitialPlayerResponse.playerAds)),feedAds:document.querySelectorAll('ytd-ad-slot-renderer,ytd-in-feed-ad-layout-renderer,#player-ads').length,visibleFeedAds:[...document.querySelectorAll('ytd-ad-slot-renderer,ytd-in-feed-ad-layout-renderer,#player-ads')].filter(e=>e.offsetHeight>0).length,videoDetails:!!window.ytInitialPlayerResponse?.videoDetails}})()`);
  console.log(`youtube.com watch page (blocking ON)\n  ${JSON.stringify(ytResult)}`);
} catch (e) {
  console.error("ERROR", e.message);
}

chrome.kill();
rmSync(join(EXT_DIR, "_metadata"), { recursive: true, force: true });
setTimeout(() => {
  rmSync(PROFILE, { recursive: true, force: true });
  process.exit(0);
}, 800);
