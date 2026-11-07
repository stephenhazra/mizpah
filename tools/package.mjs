#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INCLUDE = ["LICENSE", "THIRD_PARTY_NOTICES.md", "lib", "content", "popup", "options", "icons", "rules", "filters/ads.txt", "filters/trackers.txt", "filters/annoyances.txt"];
const TARGETS = ["chrome", "firefox", "safari"];
const GECKO_ID = "mizpah@stephenhazra.github.io";

const args = process.argv.slice(2);
const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1] || "all";
const targets = targetArg === "all" ? TARGETS : targetArg.split(",");
for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`unknown target ${t}, use one of ${TARGETS.join(", ")}`);

const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const info = JSON.parse(await readFile(join(root, "rules", "build-info.json"), "utf8"));
const problems = [];
if (!info.remote) problems.push("rules were built without --remote, run: node tools/build-rules.mjs --remote");
if (Date.now() - info.builtAt > 7 * 86400000) problems.push("rules are over a week old, run: node tools/build-rules.mjs --remote");
if (manifest.description.length > 132) problems.push(`manifest description is ${manifest.description.length} chars, the store limit is 132`);
if (manifest.update_url) problems.push("manifest must not contain update_url");
if (problems.length && !args.includes("--force")) {
  console.error("Not packaging:\n- " + problems.join("\n- ") + "\nRe-run with --force to package anyway.");
  process.exit(1);
}

async function bundleBackground() {
  const parts = [];
  for (const file of ["lib/filters.js", "lib/popup.js", "background.js"]) {
    const src = await readFile(join(root, file), "utf8");
    parts.push(src.replace(/^import [^;]+;\n/gm, "").replace(/^export /gm, ""));
  }
  return `(() => {\n${parts.join("\n")}\n})();\n`;
}

function manifestFor(target) {
  const m = structuredClone(manifest);
  if (target === "chrome") return m;
  delete m.minimum_chrome_version;
  if (target === "firefox") {
    m.background = { scripts: ["background.js"] };
    m.options_ui = { page: m.options_page, open_in_tab: true };
    delete m.options_page;
    m.browser_specific_settings = {
      gecko: { id: GECKO_ID, strict_min_version: "128.0", data_collection_permissions: { required: ["none"] } },
      gecko_android: { strict_min_version: "128.0" }
    };
  }
  if (target === "safari") {
    m.background = { service_worker: "background.js" };
    m.permissions = m.permissions.filter((p) => !["notifications", "declarativeNetRequestFeedback"].includes(p));
  }
  return m;
}

const dist = join(root, "dist");
const slug = manifest.short_name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

async function stageTarget(target) {
  const stage = join(dist, target === "safari" ? "safari" : `stage-${target}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(join(stage, "filters"), { recursive: true });
  for (const path of INCLUDE) await cp(join(root, path), join(stage, path), { recursive: true });
  const { root: _localPath, ...publicInfo } = info;
  await writeFile(join(stage, "rules", "build-info.json"), JSON.stringify(publicInfo));
  await rm(join(stage, "rules", "local-root.json"), { force: true });
  await writeFile(join(stage, "manifest.json"), JSON.stringify(manifestFor(target), null, 2));
  if (target === "chrome") await cp(join(root, "background.js"), join(stage, "background.js"));
  else await writeFile(join(stage, "background.js"), await bundleBackground());
  execFileSync(process.execPath, ["--check", join(stage, "background.js")]);
  return stage;
}

for (const target of targets) {
  const stage = await stageTarget(target);
  if (target === "safari") {
    console.log(`${stage}\n  Safari extension folder, convert it with tools/safari.sh`);
    continue;
  }
  const ext = target === "firefox" ? "xpi" : "zip";
  const out = join(dist, `${slug}-${manifest.version}-${target}.${ext}`);
  await rm(out, { force: true });
  execFileSync("zip", ["-qr", "-X", out, ".", "-x", "*.DS_Store"], { cwd: stage });
  await rm(stage, { recursive: true, force: true });
  if (execFileSync("unzip", ["-p", out], { maxBuffer: 1 << 30 }).includes(Buffer.from(root))) {
    console.error(`${out} contains the local path ${root}`);
    process.exit(1);
  }
  const size = (await stat(out)).size;
  const stores = target === "chrome" ? "Chrome Web Store and Microsoft Edge Add-ons" : "Firefox Add-ons (desktop and Android)";
  console.log(`${out}\n  ${(size / 1048576).toFixed(1)} MB, for ${stores}`);
}
console.log(`${manifest.name} ${manifest.version}, rules built ${new Date(info.builtAt).toLocaleDateString()}`);
