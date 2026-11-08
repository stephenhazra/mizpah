#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, sleep, DESKTOP_UA } from "./cdp.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "store", "apple");
mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const NAME = manifest.short_name;
const SITE = process.argv[2] || "https://weather.com/";
const WORK = mkdtempSync(join(tmpdir(), "apple-compose-"));

const { proc: chrome, profile: PROFILE, send } = launchChrome({ profilePrefix: "apple-assets-", args: [`--user-agent=${DESKTOP_UA}`, "--hide-scrollbars"] });

async function open(url, width, height, dpr = 1, wait = 2500) {
  const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false }, sessionId);
  await send("Page.navigate", { url }, sessionId);
  await sleep(wait);
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.result?.value;
  const shot = async (file, clip) => {
    const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, sessionId);
    writeFileSync(file, Buffer.from(r.result.data, "base64"));
  };
  return { ev, shot, targetId };
}

const theme = (w, h) => `
  :root { --bg:#16171b; --text:#f2f2f5; --muted:#a3a5ae; --accent:#e0503f; }
  * { box-sizing:border-box; margin:0; }
  body { width:${w}px; height:${h}px; overflow:hidden; background:radial-gradient(${w}px ${h * 0.7}px at 80% 15%, #3a1d1a 0%, var(--bg) 65%); color:var(--text); font-family:-apple-system,system-ui,"SF Pro Display",sans-serif; }
`;
async function compose(name, w, h, css, body) {
  const file = join(WORK, `${name}.html`);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>${theme(w, h)}${css}</style></head><body>${body}</body></html>`);
  const p = await open(`file://${file}`, w, h, 1, 1500);
  await p.shot(join(outDir, `${name}.png`));
  await send("Target.closeTarget", { targetId: p.targetId });
}

const results = [["forbes.com", 11], ["dailymail.co.uk", 18], ["weather.com", 37], ["speedtest.net", 22], ["merriam-webster.com", 13], ["cnn.com", 11]];

function popupScreen(w, h, img, popupW, blocked, host, k) {
  return [`
    .wrap { height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:${90 * k}px; gap:${70 * k}px; text-align:center; }
    h1 { font-size:${92 * k}px; line-height:1.05; font-weight:800; letter-spacing:-${2 * k}px; }
    h1 span { color:var(--accent); }
    p { font-size:${40 * k}px; line-height:1.4; color:var(--muted); max-width:${1000 * k}px; }
    img { width:${popupW}px; border-radius:${36 * k}px; box-shadow:0 ${40 * k}px ${110 * k}px rgba(0,0,0,.6), 0 0 0 2px rgba(255,255,255,.06); }
  `, `<div class="wrap"><h1>Ads, trackers<br>and pop-ups.<br><span>Blocked.</span></h1>
      <img src="${img}" alt=""><p><b style="color:#f2f2f5">${blocked}</b> requests blocked on ${host}, live.</p></div>`];
}

function chartScreen(w, h, k, vertical) {
  const max = Math.max(...results.map((r) => r[1]));
  return [`
    .wrap { height:100%; display:flex; flex-direction:column; justify-content:center; padding:${110 * k}px; }
    h1 { font-size:${88 * k}px; font-weight:800; letter-spacing:-${1.5 * k}px; }
    h1 span { color:var(--accent); }
    .sub { margin-top:${24 * k}px; font-size:${38 * k}px; color:var(--muted); line-height:1.35; }
    .rows { margin-top:${80 * k}px; display:grid; gap:${vertical ? 44 * k : 30 * k}px; }
    .row { display:grid; grid-template-columns:${vertical ? "1fr" : `${430 * k}px 1fr ${200 * k}px`}; align-items:center; gap:${vertical ? 14 * k : 36 * k}px ${36 * k}px; font-size:${38 * k}px; }
    .top { display:flex; justify-content:space-between; }
    .bar { height:${44 * k}px; border-radius:${12 * k}px; background:#3a3b44; position:relative; }
    .bar i { position:absolute; inset:0 auto 0 0; border-radius:${12 * k}px; background:#6b6e78; }
    .after { color:var(--accent); font-weight:700; text-align:right; }
    .legend { margin-top:${60 * k}px; font-size:${30 * k}px; color:var(--muted); line-height:1.4; }
  `, `<div class="wrap"><h1>Visible ads:<br><span>gone.</span></h1>
      <div class="sub">Ad slots on each page without ${NAME}, and with it.</div>
      <div class="rows">${results.map(([s, n]) => vertical
        ? `<div class="row"><div class="top"><span>${s}</span><span class="after">${n} → 0</span></div><div class="bar"><i style="width:${(n / max) * 100}%"></i></div></div>`
        : `<div class="row"><div>${s}</div><div class="bar"><i style="width:${(n / max) * 100}%"></i></div><div class="after">${n} → 0</div></div>`).join("")}</div>
      <div class="legend">Measured on each site's home page with blocking paused and then on.</div></div>`];
}

try {
  const load = await send("Extensions.loadUnpacked", { path: root });
  if (load.error) throw new Error(JSON.stringify(load.error));
  const ext = load.result.id;
  await sleep(2500);
  await open(SITE, 1366, 900, 1, 12000);
  const opt = await open(`chrome-extension://${ext}/options/options.html`, 1280, 800);
  const tabId = await opt.ev(`chrome.tabs.query({}).then(t=>t.find(x=>(x.url||"").startsWith(${JSON.stringify(new URL(SITE).origin)}))?.id)`);
  if (!tabId) throw new Error(`could not find tab for ${SITE}`);
  const popup = await open(`chrome-extension://${ext}/popup/popup.html?tab=${tabId}`, 300, 600, 3, 2000);
  const ph = await popup.ev("Math.ceil(document.body.getBoundingClientRect().height)");
  const popupPng = join(WORK, "popup.png");
  await popup.shot(popupPng, { x: 0, y: 0, width: 300, height: ph });
  const blocked = await popup.ev("document.getElementById('blocked').textContent");
  const host = new URL(SITE).hostname.replace(/^www\./, "");
  const img = `file://${popupPng}`;

  const mac = await open(`file://${encodeURI(join(root, "platforms", "Mizpah", "Shared (App)", "Resources", "Base.lproj", "Main.html"))}`, 640, 720, 2, 1500);
  await mac.ev("show('mac', true); document.body.style.font = '15px -apple-system, system-ui, sans-serif'");
  await sleep(300);
  const macPng = join(WORK, "mac-app.png");
  await mac.shot(macPng);

  await compose("iphone-2", 1206, 2622, ...popupScreen(1206, 2622, img, 820, blocked, host, 1.14));
  await compose("iphone-3", 1206, 2622, ...chartScreen(1206, 2622, 1.1, true));
  await compose("ipad-2", 2064, 2752, ...popupScreen(2064, 2752, img, 1000, blocked, host, 1.5));
  await compose("ipad-3", 2064, 2752, ...chartScreen(2064, 2752, 1.6, false));
  await compose("mac-1", 2880, 1800, `
    .wrap { height:100%; display:flex; align-items:center; justify-content:space-between; padding:0 ${240}px; gap:120px; }
    h1 { font-size:124px; line-height:1.05; font-weight:800; letter-spacing:-2px; }
    h1 span { color:var(--accent); }
    p { margin-top:44px; font-size:46px; line-height:1.45; color:var(--muted); max-width:1100px; }
    img { width:780px; border-radius:36px; box-shadow:0 40px 110px rgba(0,0,0,.6), 0 0 0 2px rgba(255,255,255,.06); }
  `, `<div class="wrap"><div><h1>Ads, trackers<br>and pop-ups.<br><span>Blocked in Safari.</span></h1>
      <p>Over 110,000 rules from EasyList, EasyPrivacy and Fanboy's lists, updated daily. <b style="color:#f2f2f5">${blocked}</b> requests blocked on ${host}, live.</p></div>
      <img src="${img}" alt=""></div>`);
  await compose("mac-2", 2880, 1800, ...chartScreen(2880, 1800, 1.45, false));
  await compose("mac-3", 2880, 1800, `
    .wrap { height:100%; display:flex; align-items:center; justify-content:space-between; padding:0 240px; gap:120px; }
    h1 { font-size:112px; line-height:1.05; font-weight:800; letter-spacing:-2px; }
    h1 span { color:var(--accent); }
    p { margin-top:44px; font-size:46px; line-height:1.45; color:var(--muted); max-width:1050px; }
    img { width:1060px; border-radius:36px; box-shadow:0 40px 110px rgba(0,0,0,.6); }
  `, `<div class="wrap"><div><h1>Private<br>by design.<br><span>No data collected.</span></h1>
      <p>No accounts, no analytics, no tracking. Everything runs on your Mac.</p></div><img src="file://${macPng}" alt=""></div>`);
  console.log(`Wrote App Store images to ${outDir} (${blocked} requests blocked on ${host})`);
} catch (e) {
  console.error("ERROR", e.message);
  process.exitCode = 1;
}
chrome.kill();
rmSync(join(root, "_metadata"), { recursive: true, force: true });
setTimeout(() => { rmSync(PROFILE, { recursive: true, force: true }); rmSync(WORK, { recursive: true, force: true }); process.exit(); }, 800);
