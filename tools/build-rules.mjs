#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LISTS, parseFilterList, toRules, groupCosmetic, plainAdDomains } from "../lib/filters.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_RULES_PER_LIST = 29000;

const useRemote = process.argv.includes("--remote");

async function loadSources({ id, sources }) {
  const texts = [await readFile(join(root, "filters", `${id}.txt`), "utf8")];
  if (useRemote) {
    const cacheDir = join(root, "filters", "remote");
    await mkdir(cacheDir, { recursive: true });
    for (const url of sources) {
      const file = join(cacheDir, url.split("/").pop());
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.text();
        await writeFile(file, body);
        texts.push(body);
        console.log(`  fetched ${url}`);
      } catch (err) {
        if (existsSync(file)) {
          texts.push(await readFile(file, "utf8"));
          console.warn(`  ${url} failed (${err.message}), using cached copy`);
        } else {
          console.warn(`  ${url} failed (${err.message}), skipped`);
        }
      }
    }
  }
  return texts.join("\n");
}

const cosmetic = {};
const counts = {};
const popup = { entries: [], adDomains: [] };
for (const list of LISTS) {
  const parsed = parseFilterList(await loadSources(list));
  const all = toRules(parsed.network);
  const rules = all.slice(0, MAX_RULES_PER_LIST);
  const extra = all.slice(MAX_RULES_PER_LIST, MAX_RULES_PER_LIST * 2);
  if (all.length > MAX_RULES_PER_LIST * 2) {
    console.warn(`  ${list.id}: dropping ${all.length - MAX_RULES_PER_LIST * 2} rules over the limit`);
  }
  await writeFile(join(root, "rules", `${list.id}.json`), JSON.stringify(rules));
  await writeFile(join(root, "rules", `${list.id}-extra.json`), JSON.stringify(extra));
  counts[list.id] = rules.length + extra.length;
  popup.entries.push(...parsed.popups);
  if (list.id === "ads") popup.adDomains.push(...plainAdDomains(parsed.network));
  cosmetic[list.id] = groupCosmetic(parsed.cosmetic);
  const specificCount = Object.values(cosmetic[list.id].specific).reduce((n, a) => n + a.length, 0);
  console.log(
    `${list.id}: ${rules.length + extra.length} network rules, ${cosmetic[list.id].generic.length} generic + ${specificCount} site cosmetic filters, ${parsed.skipped} unsupported skipped`
  );
}
await writeFile(join(root, "rules", "cosmetic.json"), JSON.stringify(cosmetic));
popup.adDomains = [...new Set(popup.adDomains)];
await writeFile(join(root, "rules", "popup.json"), JSON.stringify(popup));
await writeFile(join(root, "rules", "local-root.json"), JSON.stringify({ root }));
console.log(`popups: ${popup.entries.length} pop-up filters, ${popup.adDomains.length} ad-server domains`);
await writeFile(join(root, "rules", "build-info.json"), JSON.stringify({ builtAt: Date.now(), remote: useRemote, counts }));
