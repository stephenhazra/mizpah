#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, rm, writeFile, stat, utimes } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanPaths } from "./leak-check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INCLUDE = ["LICENSE", "THIRD_PARTY_NOTICES.md", "background.js", "lib", "background", "content", "popup", "options", "icons", "rules", "filters/ads.txt", "filters/trackers.txt", "filters/annoyances.txt"];
const TARGETS = ["chrome", "firefox", "safari"];
const RULESET_ORDER = ["ads", "trackers", "annoyances", "ads-extra", "trackers-extra", "annoyances-extra"];
const config = JSON.parse(await readFile(join(root, "tools", "release.config.json"), "utf8"));

const args = process.argv.slice(2);
const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1] || "all";
const targets = targetArg === "all" ? TARGETS : targetArg.split(",");
const stageOnly = args.includes("--stage-only");
const keepStage = stageOnly || args.includes("--keep-stage");
for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`unknown target ${t}, use one of ${TARGETS.join(", ")}`);
for (const tool of stageOnly ? [] : ["zip", "unzip"]) {
  if (spawnSync("which", [tool]).status !== 0) throw new Error(`${tool} is required but not installed`);
}

const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const info = JSON.parse(await readFile(join(root, "rules", "build-info.json"), "utf8"));
const problems = [];
if (!info.remote) problems.push("rules were built without --remote, run: node tools/build-rules.mjs --remote");
if (info.sources?.some((s) => s.fromCache)) problems.push("some rule sources came from the cache, run: node tools/build-rules.mjs --remote");
if (Date.now() - info.builtAt > 7 * 86400000) problems.push("rules are over a week old, run: node tools/build-rules.mjs --remote");
if (manifest.description.length > config.descriptionLimit) problems.push(`manifest description is ${manifest.description.length} chars, the Safari limit is ${config.descriptionLimit}`);
if (manifest.update_url) problems.push("manifest must not contain update_url");
if (targets.includes("safari") && !/^\d+(\.\d+){0,2}$/.test(manifest.version)) problems.push(`version ${manifest.version} is not up to three integers, which Safari requires`);
if (problems.length && !args.includes("--force")) {
  console.error("Not packaging:\n- " + problems.join("\n- ") + "\nRe-run with --force to package anyway.");
  process.exit(1);
}

const rulesetSizes = {};
for (const r of manifest.declarative_net_request.rule_resources) {
  rulesetSizes[r.id] = JSON.parse(await readFile(join(root, r.path), "utf8")).length;
}

function firefoxRulesets() {
  let budget = config.firefoxStaticRuleLimit;
  const enabled = new Set();
  for (const id of RULESET_ORDER) {
    if (rulesetSizes[id] > budget) continue;
    budget -= rulesetSizes[id];
    enabled.add(id);
  }
  const off = RULESET_ORDER.filter((id) => !enabled.has(id));
  if (off.length) console.warn(`  firefox: static rule limit is ${config.firefoxStaticRuleLimit}, disabling ${off.join(", ")}`);
  return enabled;
}

function manifestFor(target) {
  const m = structuredClone(manifest);
  m.permissions = m.permissions.filter((p) => p !== "notifications");
  if (target === "chrome") return m;
  delete m.minimum_chrome_version;
  delete m.externally_connectable;
  if (target === "firefox") {
    m.background = { scripts: ["background.js"], type: "module" };
    m.options_ui = { page: m.options_page, open_in_tab: true };
    delete m.options_page;
    m.browser_specific_settings = {
      gecko: { id: config.geckoId, strict_min_version: config.firefoxMinVersion, data_collection_permissions: { required: ["none"] } },
      gecko_android: { strict_min_version: config.firefoxMinVersion }
    };
    const enabled = firefoxRulesets();
    for (const r of m.declarative_net_request.rule_resources) r.enabled = enabled.has(r.id);
  }
  if (target === "safari") {
    m.background = { service_worker: "background.js", type: "module" };
    m.browser_specific_settings = { safari: { strict_min_version: config.safariMinVersion } };
    const total = m.declarative_net_request.rule_resources.filter((r) => r.enabled).reduce((n, r) => n + rulesetSizes[r.id], 0);
    if (total > config.safariStaticRuleLimit) {
      console.error(`Safari static rules total ${total}, over the ${config.safariStaticRuleLimit} limit`);
      process.exit(1);
    }
  }
  return m;
}

const dist = join(root, "dist");
const slug = manifest.short_name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

async function stageTarget(target) {
  const stage = join(dist, target === "safari" ? "safari" : `stage-${target}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(join(stage, "filters"), { recursive: true });
  const filter = (src) => !/(^|\/)(\.DS_Store|\.tmp-[^/]*)$/.test(src);
  for (const path of INCLUDE) await cp(join(root, path), join(stage, path), { recursive: true, filter });
  const { root: _localPath, ...publicInfo } = info;
  await writeFile(join(stage, "rules", "build-info.json"), JSON.stringify({ ...publicInfo, store: true }));
  await rm(join(stage, "rules", "local-root.json"), { force: true });
  await writeFile(join(stage, "manifest.json"), JSON.stringify(manifestFor(target), null, 2));
  execFileSync(process.execPath, ["--check", join(stage, "background.js")]);
  return stage;
}

async function listFiles(dir, base = "") {
  const out = [];
  for (const entry of await readdir(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else out.push(rel);
  }
  return out.sort();
}

async function zipStage(stage, out) {
  const files = await listFiles(stage);
  const when = new Date(Math.max(info.builtAt, 315619200000));
  for (const f of files) await utimes(join(stage, f), when, when);
  await rm(out, { force: true });
  execFileSync("zip", ["-q", "-X", out, "-@"], { cwd: stage, input: files.join("\n") + "\n", env: { ...process.env, TZ: "UTC" } });
}

for (const target of targets) {
  const stage = await stageTarget(target);
  if (stageOnly) {
    console.log(stage);
    continue;
  }
  const leaks = scanPaths([stage]);
  if (leaks.length) {
    console.error(`${target} build leaks local data:\n- ${leaks.join("\n- ")}`);
    process.exit(1);
  }
  if (target === "safari") {
    console.log(`${stage}\n  Safari extension folder, convert it with tools/safari.sh`);
    continue;
  }
  const ext = target === "firefox" ? "xpi" : "zip";
  const out = join(dist, `${slug}-${manifest.version}-${target}.${ext}`);
  await zipStage(stage, out);
  if (!keepStage) await rm(stage, { recursive: true, force: true });
  const archiveLeaks = scanPaths([out]);
  if (archiveLeaks.length) {
    console.error(`${out} leaks local data:\n- ${archiveLeaks.join("\n- ")}`);
    process.exit(1);
  }
  const size = (await stat(out)).size;
  const stores = target === "chrome" ? "Chrome Web Store and Microsoft Edge Add-ons" : "Firefox Add-ons (desktop and Android)";
  console.log(`${out}\n  ${(size / 1048576).toFixed(1)} MB, for ${stores}`);
}
console.log(`${manifest.name} ${manifest.version}, rules built ${new Date(info.builtAt).toISOString().slice(0, 10)}`);
