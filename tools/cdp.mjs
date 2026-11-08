import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(check, { timeout = 10000, interval = 200 } = {}) {
  const end = Date.now() + timeout;
  let value;
  while (!(value = await check()) && Date.now() < end) await sleep(interval);
  return value;
}

export function launchChrome({ profilePrefix = "mizpah-", args = [] } = {}) {
  const profile = mkdtempSync(join(tmpdir(), profilePrefix));
  const proc = spawn(CHROME_PATH, ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "--no-first-run", ...args, "about:blank"], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"]
  });
  const [out, inp] = [proc.stdio[3], proc.stdio[4]];
  const pending = new Map();
  let nextId = 0;
  let buf = "";
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
  return { proc, profile, send };
}
