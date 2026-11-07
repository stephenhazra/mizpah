#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INCLUDE = ["manifest.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "background.js", "lib", "content", "popup", "options", "icons", "rules", "filters/ads.txt", "filters/trackers.txt", "filters/annoyances.txt"];

const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const info = JSON.parse(await readFile(join(root, "rules", "build-info.json"), "utf8"));
const problems = [];
if (!info.remote) problems.push("rules were built without --remote, run: node tools/build-rules.mjs --remote");
if (Date.now() - info.builtAt > 7 * 86400000) problems.push("rules are over a week old, run: node tools/build-rules.mjs --remote");
if (manifest.description.length > 132) problems.push(`manifest description is ${manifest.description.length} chars, the store limit is 132`);
if (manifest.update_url) problems.push("manifest must not contain update_url");
if (problems.length && !process.argv.includes("--force")) {
  console.error("Not packaging:\n- " + problems.join("\n- ") + "\nRe-run with --force to package anyway.");
  process.exit(1);
}

const dist = join(root, "dist");
const stage = join(dist, "stage");
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, "filters"), { recursive: true });
for (const path of INCLUDE) await cp(join(root, path), join(stage, path), { recursive: true });
const { root: _localPath, ...publicInfo } = info;
await writeFile(join(stage, "rules", "build-info.json"), JSON.stringify(publicInfo));
await rm(join(stage, "rules", "local-root.json"), { force: true });

const slug = manifest.short_name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const zip = join(dist, `${slug}-${manifest.version}.zip`);
await rm(zip, { force: true });
execFileSync("zip", ["-qr", "-X", zip, ".", "-x", "*.DS_Store"], { cwd: stage });
await rm(stage, { recursive: true, force: true });

const leak = execFileSync("unzip", ["-p", zip], { maxBuffer: 1 << 30 }).includes(Buffer.from(root));
if (leak) {
  console.error(`Packaged files still contain ${root}`);
  process.exit(1);
}
const size = (await stat(zip)).size;
console.log(`${zip}\n${manifest.name} ${manifest.version}, ${(size / 1048576).toFixed(1)} MB, built ${new Date(info.builtAt).toLocaleDateString()}`);
