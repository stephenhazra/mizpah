#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, sleep, waitFor, desktopUA, openPage, stageExtension } from "./cdp.mjs";
import { startDemoSite } from "./demo-site.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "store");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const NAME = manifest.short_name;
const demo = await startDemoSite();
const SITE = process.argv[2] || demo.url;
const WORK = mkdtempSync(join(tmpdir(), "store-compose-"));
const OUT = join(WORK, "out");
mkdirSync(OUT);
const buildInfo = JSON.parse(readFileSync(join(root, "rules", "build-info.json"), "utf8"));
const ruleCount = (Math.floor(Object.values(buildInfo.counts).reduce((n, c) => n + c, 0) / 1000) * 1000).toLocaleString("en-US");
const { results: resultRows } = JSON.parse(readFileSync(join(outDir, "results.json"), "utf8"));
const EXT_DIR = stageExtension(root);

const chrome = launchChrome({ profilePrefix: "store-assets-", args: ["--hide-scrollbars", ...(process.argv[2] ? [] : demo.chromeArgs)] });
const { send } = chrome;
const UA = await desktopUA(send);

async function open(url, width, height, wait = 0) {
  const page = await openPage(chrome, url, { width, height, ua: UA });
  if (wait) await sleep(wait);
  return page;
}

const theme = `
  :root { --bg:#16171b; --text:#f2f2f5; --muted:#a3a5ae; --accent:#e0503f; }
  * { box-sizing:border-box; margin:0; }
  body { width:WIDTHpx; height:HEIGHTpx; overflow:hidden; background:radial-gradient(1200px 700px at 85% 20%, #3a1d1a 0%, var(--bg) 60%); color:var(--text); font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
`;
const page = (w, h, css, body) => `<!doctype html><html><head><meta charset="utf-8"><style>${theme.replace("WIDTH", w).replace("HEIGHT", h)}${css}</style></head><body>${body}</body></html>`;
const compose = async (name, w, h, css, body) => {
  const file = join(WORK, `${name}.html`);
  writeFileSync(file, page(w, h, css, body));
  const p = await open(`file://${file}`, w, h, 500);
  await p.shot(join(OUT, `${name}.png`));
  await p.close();
};

try {
  const load = await send("Extensions.loadUnpacked", { path: EXT_DIR });
  if (load.error) throw new Error(JSON.stringify(load.error));
  const ext = load.result.id;
  await sleep(2500);

  const site = await open(SITE, 1366, 900, 3000);
  const opt = await open(`chrome-extension://${ext}/options/options.html`, 1280, 800);
  console.log("site:", await site.ev("document.title + ' | ' + location.href"));
  const tabId = await opt.ev(`chrome.tabs.query({}).then(t=>t.find(x=>(x.url||"").startsWith(${JSON.stringify(new URL(SITE).origin)}))?.id)`);
  if (!tabId) throw new Error(`could not find tab for ${SITE}`);
  const matched = () => opt.ev(`chrome.declarativeNetRequest.getMatchedRules({tabId:${tabId}}).then(r=>r.rulesMatchedInfo.length).catch(()=>0)`);
  if (!(await waitFor(matched, { timeout: 60000, interval: 1000 }))) throw new Error(`no requests were blocked on ${SITE}`);
  if (/\/Users\/|\/home\//.test(await opt.ev("document.body.innerText"))) throw new Error("the options page shows a local path");

  const popup = await open(`chrome-extension://${ext}/popup/popup.html?tab=${tabId}`, 300, 600, 1000);
  const popupHeight = await popup.ev("Math.ceil(document.body.getBoundingClientRect().height)");
  await popup.shot(join(WORK, "popup.png"), { x: 0, y: 0, width: 300, height: popupHeight });
  const blocked = await popup.ev("document.getElementById('blocked').textContent");
  console.log("matched:", await matched(), "popup shows:", blocked);
  if (!(Number(String(blocked).replace(/\D/g, "")) > 0)) throw new Error(`popup shows ${blocked} blocked requests`);

  await opt.ev("window.scrollTo(0,0)");
  await opt.shot(join(OUT, "screenshot-2.png"));

  const popupImg = `file://${join(WORK, "popup.png")}`;
  const host = process.argv[2] ? new URL(SITE).hostname.replace(/^www\./, "") : "a demo news page";

  await compose("screenshot-1", 1280, 800, `
    .wrap { display:flex; align-items:center; justify-content:space-between; height:100%; padding:0 110px; gap:60px; }
    h1 { font-size:58px; line-height:1.08; letter-spacing:-1px; font-weight:800; }
    h1 span { color:var(--accent); }
    p { margin-top:22px; font-size:22px; line-height:1.5; color:var(--muted); max-width:520px; }
    .stat { margin-top:34px; font-size:18px; color:var(--muted); }
    .stat b { color:var(--text); font-size:22px; }
    img { width:360px; border-radius:16px; box-shadow:0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06); }
  `, `<div class="wrap"><div>
      <h1>Block ads, trackers<br>and pop-ups. <span>Everywhere.</span></h1>
      <p>${NAME} uses over ${ruleCount} rules from EasyList, EasyPrivacy and Fanboy's lists, updated daily.</p>
      <div class="stat"><b>${blocked}</b> requests blocked on ${host}, live</div>
    </div><img src="${popupImg}" alt=""></div>`);

  const results = resultRows.map((r) => [r.site, r.adSlots]);
  const max = Math.max(...results.map((r) => r[1]));
  await compose("screenshot-3", 1280, 800, `
    .wrap { padding:90px 110px; }
    h1 { font-size:46px; font-weight:800; letter-spacing:-.5px; }
    h1 span { color:var(--accent); }
    .sub { margin-top:12px; font-size:20px; color:var(--muted); }
    .rows { margin-top:52px; display:grid; gap:18px; }
    .row { display:grid; grid-template-columns:240px 1fr 120px; align-items:center; gap:22px; font-size:20px; }
    .bar { height:30px; border-radius:8px; background:#3a3b44; position:relative; }
    .bar i { position:absolute; inset:0 auto 0 0; border-radius:8px; background:#6b6e78; }
    .after { color:var(--accent); font-weight:700; text-align:right; }
    .legend { margin-top:34px; font-size:16px; color:var(--muted); }
  `, `<div class="wrap">
      <h1>Visible ads: <span>gone.</span></h1>
      <div class="sub">Ad slots visible on each page without ${NAME}, and with it.</div>
      <div class="rows">${results.map(([s, n]) => `<div class="row"><div>${s}</div><div class="bar"><i style="width:${(n / max) * 100}%"></i></div><div class="after">${n} → 0</div></div>`).join("")}</div>
      <div class="legend">Measured in Chrome on each site's home page, with blocking paused and then on.</div>
    </div>`);

  const icon = `file://${join(root, "icons", "icon128.png")}`;
  await compose("promo-small", 440, 280, `
    .wrap { height:100%; display:flex; flex-direction:column; justify-content:center; padding:0 34px; }
    .brand { display:flex; align-items:center; gap:14px; }
    img { width:54px; height:54px; }
    h1 { font-size:40px; font-weight:800; letter-spacing:-.5px; }
    p { margin-top:16px; font-size:19px; line-height:1.35; color:var(--muted); }
    p b { color:var(--text); font-weight:600; }
  `, `<div class="wrap"><div class="brand"><img src="${icon}" alt=""><h1>${NAME}</h1></div>
      <p><b>Ads, trackers and pop-ups,</b><br>blocked on every site.</p></div>`);

  await compose("promo-marquee", 1400, 560, `
    .wrap { height:100%; display:flex; align-items:center; justify-content:space-between; padding:0 120px; gap:60px; }
    .brand { display:flex; align-items:center; gap:22px; }
    .brand img { width:96px; height:96px; }
    h1 { font-size:84px; font-weight:800; letter-spacing:-1.5px; }
    p { margin-top:26px; font-size:30px; line-height:1.35; color:var(--muted); }
    p b { color:var(--text); font-weight:600; }
    .meaning { margin-top:22px; font-size:20px; color:var(--muted); letter-spacing:.3px; }
    .meaning span { color:var(--accent); }
    .shot { width:340px; border-radius:16px; box-shadow:0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06); }
  `, `<div class="wrap"><div>
      <div class="brand"><img src="${icon}" alt=""><h1>${NAME}</h1></div>
      <p><b>Ads, trackers and pop-ups,</b><br>blocked on every site.</p>
      <div class="meaning"><span>מצפה</span> · Hebrew for "watchtower"</div>
    </div><img class="shot" src="${popupImg}" alt=""></div>`);

  for (const file of readdirSync(OUT)) copyFileSync(join(OUT, file), join(outDir, file));
  console.log(`Wrote screenshot-1.png, screenshot-2.png, screenshot-3.png, promo-small.png and promo-marquee.png to ${outDir} (${blocked} requests blocked on ${host})`);
} catch (e) {
  console.error("ERROR", e.message);
  process.exitCode = 1;
} finally {
  await chrome.close();
  demo.close();
  rmSync(WORK, { recursive: true, force: true });
  rmSync(join(root, "dist", "stage-chrome"), { recursive: true, force: true });
}
