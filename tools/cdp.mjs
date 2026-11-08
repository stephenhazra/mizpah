import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(check, { timeout = 10000, interval = 200 } = {}) {
  const end = Date.now() + timeout;
  let value;
  while (!(value = await check()) && Date.now() < end) await sleep(interval);
  return value;
}

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (existsSync(MAC_CHROME)) return MAC_CHROME;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
    const found = spawnSync("which", [name], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error("Chrome not found, set CHROME_PATH");
}

export function launchChrome({ profilePrefix = "mizpah-", args = [], extDir } = {}) {
  const profile = mkdtempSync(join(tmpdir(), profilePrefix));
  const proc = spawn(findChrome(), ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "--no-first-run", ...args, "about:blank"], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"]
  });
  const [out, inp] = [proc.stdio[3], proc.stdio[4]];
  const pending = new Map();
  const events = new EventEmitter();
  let nextId = 0;
  let exited = false;
  let buf = "";
  inp.setEncoding("utf8");
  inp.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\0")) !== -1) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.id && pending.has(m.id)) {
        clearTimeout(pending.get(m.id).timer);
        pending.get(m.id).resolve(m);
        pending.delete(m.id);
      } else if (m.method) {
        events.emit(m.method, m);
      }
    }
  });
  const failAll = (reason) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    pending.clear();
  };
  proc.on("exit", () => {
    exited = true;
    failAll("Chrome exited");
  });
  const send = (method, params = {}, sessionId, timeout = 60000) =>
    new Promise((resolve, reject) => {
      if (exited) return reject(new Error("Chrome exited"));
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      out.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    });
  const cleanup = () => {
    try { proc.kill(); } catch {}
    rmSync(profile, { recursive: true, force: true });
    if (extDir) rmSync(join(extDir, "_metadata"), { recursive: true, force: true });
  };
  process.once("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { cleanup(); process.exit(130); });
  const close = async () => {
    try { proc.kill(); } catch {}
    await sleep(500);
    cleanup();
  };
  return { proc, profile, send, events, close };
}

export function unwrap(message, what = "CDP call") {
  if (message.error) throw new Error(`${what} failed: ${JSON.stringify(message.error)}`);
  return message.result;
}

export async function desktopUA(send) {
  const { userAgent } = unwrap(await send("Browser.getVersion"), "Browser.getVersion");
  return userAgent.replace("HeadlessChrome", "Chrome");
}

export async function openPage(chrome, url, { width, height, dpr = 1, mobile = false, ua, timeout = 30000, waitLoad = true } = {}) {
  const { send, events } = chrome;
  const { targetId } = unwrap(await send("Target.createTarget", { url: "about:blank" }), "Target.createTarget");
  const { sessionId } = unwrap(await send("Target.attachToTarget", { targetId, flatten: true }), "Target.attachToTarget");
  if (ua) await send("Emulation.setUserAgentOverride", { userAgent: ua }, sessionId);
  if (width) await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile }, sessionId);
  await send("Page.enable", {}, sessionId);
  const loaded = new Promise((resolve) => {
    const handler = (m) => {
      if (m.sessionId !== sessionId) return;
      events.off("Page.loadEventFired", handler);
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      events.off("Page.loadEventFired", handler);
      resolve(false);
    }, timeout);
    events.on("Page.loadEventFired", handler);
  });
  unwrap(await send("Page.navigate", { url }, sessionId), "Page.navigate");
  if (waitLoad) await loaded;
  const ev = async (expression, evalTimeout = 30000) => {
    const r = unwrap(await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId, evalTimeout), "Runtime.evaluate");
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  const shot = async (file, clip) => {
    const r = unwrap(await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, sessionId), "Page.captureScreenshot");
    writeFileSync(file, Buffer.from(r.data, "base64"));
  };
  const close = () => send("Target.closeTarget", { targetId }).catch(() => {});
  return { ev, shot, close, targetId, sessionId };
}

export function stageExtension(root) {
  execFileSync(process.execPath, [join(root, "tools", "package.mjs"), "--target=chrome", "--stage-only", "--force"], { stdio: "ignore" });
  return join(root, "dist", "stage-chrome");
}
