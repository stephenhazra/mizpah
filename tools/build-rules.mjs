#!/usr/bin/env node
import { readFile, writeFile, mkdir, rm, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { LISTS, parseFilterList, toRules, groupCosmetic, plainAdDomains, ruleHash } from "../lib/filters.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_RULES_PER_LIST = 29000;
const MAX_DROPPED_RULES = 5000;
const MIN_SOURCE_BYTES = 200 * 1024;
const MIN_KEPT_FRACTION = 0.8;
const MIN_TOTAL_RULES = 20000;
const FETCH_TIMEOUT_MS = 30000;

const useRemote = process.argv.includes("--remote");
const allowCache = process.argv.includes("--allow-cache");

const lineCount = (text) => text.split("\n").length;
const looksLikeList = (text) => /^\s*(\[Adblock Plus|! Title:)/i.test(text);

async function download(url, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  if (!looksLikeList(body)) throw new Error("not a filter list");
  if (body.length < MIN_SOURCE_BYTES) throw new Error(`only ${body.length} bytes`);
  const declared = Number(res.headers.get("content-length"));
  if (!res.headers.get("content-encoding") && declared && declared !== Buffer.byteLength(body)) throw new Error("truncated download");
  if (existsSync(file)) {
    const previous = lineCount(await readFile(file, "utf8"));
    if (lineCount(body) < previous * MIN_KEPT_FRACTION) throw new Error(`${lineCount(body)} lines, previously ${previous}`);
  }
  await writeFile(file + ".tmp", body);
  await rename(file + ".tmp", file);
  return body;
}

const sources = [];
const failures = [];

async function loadSources({ id, sources: urls }) {
  const texts = [await readFile(join(root, "filters", `${id}.txt`), "utf8")];
  if (!useRemote) return texts.join("\n");
  const cacheDir = join(root, "filters", "remote");
  await mkdir(cacheDir, { recursive: true });
  for (const url of urls) {
    const file = join(cacheDir, basename(new URL(url).pathname));
    let body;
    let fromCache = false;
    let fetchedAt = Date.now();
    try {
      body = await download(url, file);
      console.log(`  fetched ${url}`);
    } catch (err) {
      if (allowCache && existsSync(file)) {
        body = await readFile(file, "utf8");
        fromCache = true;
        fetchedAt = (await stat(file)).mtimeMs;
        console.warn(`  ${url} failed (${err.message}), using cached copy`);
      } else {
        failures.push(`${url}: ${err.message}`);
        console.error(`  ${url} failed (${err.message})`);
        continue;
      }
    }
    sources.push({ url, fetchedAt: Math.round(fetchedAt), bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"), fromCache });
    texts.push(body);
  }
  return texts.join("\n");
}

const names = LISTS.flatMap((l) => l.sources).map((u) => basename(new URL(u).pathname));
if (new Set(names).size !== names.length) throw new Error("two sources share a file name");

const counts = {};
const outputs = {};
const popup = { entries: [], adDomains: [] };
for (const list of LISTS) {
  const parsed = parseFilterList(await loadSources(list));
  const all = toRules(parsed.network);
  const rules = all.slice(0, MAX_RULES_PER_LIST);
  const extra = all.slice(MAX_RULES_PER_LIST, MAX_RULES_PER_LIST * 2);
  const dropped = Math.max(0, all.length - MAX_RULES_PER_LIST * 2);
  if (dropped > MAX_DROPPED_RULES) throw new Error(`${list.id}: ${dropped} rules over the limit`);
  if (dropped) console.warn(`  ${list.id}: dropping ${dropped} rules over the limit`);
  outputs[`${list.id}.json`] = JSON.stringify(rules);
  outputs[`${list.id}-extra.json`] = JSON.stringify(extra);
  outputs[`keys-${list.id}.json`] = JSON.stringify(rules.flatMap((r) => [r.id, ruleHash(r)]));
  outputs[`keys-${list.id}-extra.json`] = JSON.stringify(extra.flatMap((r) => [r.id, ruleHash(r)]));
  counts[list.id] = rules.length + extra.length;
  popup.entries.push(...parsed.popups);
  if (list.id === "ads") popup.adDomains.push(...plainAdDomains(parsed.network));
  const cosmetic = groupCosmetic(parsed.cosmetic);
  outputs[`cosmetic-${list.id}.json`] = JSON.stringify(cosmetic);
  const tokenCount = Object.values(cosmetic.genericTokens).reduce((n, a) => n + a.length, 0);
  const specificCount = Object.values(cosmetic.specific).reduce((n, a) => n + a.length, 0);
  console.log(
    `${list.id}: ${rules.length + extra.length} network rules, ${cosmetic.generic.length + tokenCount} generic + ${specificCount} site cosmetic filters, ${parsed.skipped} unsupported skipped`
  );
}
popup.adDomains = [...new Set(popup.adDomains)];
outputs["popup.json"] = JSON.stringify(popup);
console.log(`popups: ${popup.entries.length} pop-up filters, ${popup.adDomains.length} ad-server domains`);

if (useRemote) {
  const total = Object.values(counts).reduce((n, c) => n + c, 0);
  if (total < MIN_TOTAL_RULES) failures.push(`only ${total} network rules built`);
  if (failures.length) {
    console.error(`Not writing rules:\n- ${failures.join("\n- ")}${allowCache ? "" : "\nPass --allow-cache to fall back to cached downloads."}`);
    process.exit(1);
  }
}

const fresh = useRemote && sources.length > 0 && sources.every((s) => !s.fromCache);
const builtAt = useRemote && sources.length ? Math.max(...sources.map((s) => s.fetchedAt)) : Date.now();
const info = { builtAt, remote: fresh, counts, sources };
if (useRemote && !fresh) console.warn("Some sources came from the cache, so the build is not marked remote and cannot be packaged without --force.");

const rulesDir = join(root, "rules");
const tmpDir = join(rulesDir, `.tmp-${process.pid}`);
try {
  await mkdir(tmpDir, { recursive: true });
  for (const [name, content] of Object.entries(outputs)) await writeFile(join(tmpDir, name), content);
  await writeFile(join(tmpDir, "local-root.json"), JSON.stringify({ root }));
  await writeFile(join(tmpDir, "build-info.json"), JSON.stringify(info));
  for (const name of [...Object.keys(outputs), "local-root.json", "build-info.json"]) await rename(join(tmpDir, name), join(rulesDir, name));
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}
await rm(join(rulesDir, "cosmetic.json"), { force: true });
