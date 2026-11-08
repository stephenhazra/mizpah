#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATTERNS = [
  [/\/Users\/[A-Za-z0-9._-]+/, "home path"],
  [/[A-Za-z]:\\Users\\/, "home path"],
  [/DEVELOPMENT_TEAM = [A-Z0-9]{10}\b/, "Apple team id"],
  [/DEVELOPMENT_TEAM": "[A-Z0-9]{10}"/, "Apple team id"],
  [/\b[A-Za-z0-9._%+-]+@(?!(?:users\.)?noreply\.github\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "email address"]
];
const LITERALS = [root, homedir()].filter((s) => s && s.length > 3);
const ALLOWED_EMAIL = [JSON.parse(readFileSync(join(root, "tools", "release.config.json"), "utf8")).geckoId];
const HARMLESS_EMAIL = /@(\d+x\.(png|jpe?g)|([a-z0-9-]+\.)*example\.(com|org|net))$/i;

function findIn(text, label) {
  const found = [];
  const isList = /(^|\/)(rules|filters)\/[^/]+$|\.(zip|xpi)$/.test(label);
  for (const [re, what] of PATTERNS) {
    if (isList && what === "email address") continue;
    const m = re.global ? [...text.matchAll(re)].map((x) => x[0]).find((e) => !ALLOWED_EMAIL.includes(e) && !HARMLESS_EMAIL.test(e)) : text.match(re)?.[0];
    if (m) found.push(`${label}: ${what} ${JSON.stringify(m)}`);
  }
  for (const lit of LITERALS) if (text.includes(lit)) found.push(`${label}: contains ${JSON.stringify(lit)}`);
  return found;
}

function* walk(path) {
  const st = statSync(path);
  if (!st.isDirectory()) return yield path;
  for (const name of readdirSync(path)) yield* walk(join(path, name));
}

export function scanPaths(paths) {
  const found = [];
  for (const p of paths) {
    for (const file of walk(resolve(p))) {
      const text = /\.(zip|xpi)$/.test(file)
        ? execFileSync("unzip", ["-p", file], { maxBuffer: 1 << 30 }).toString("latin1")
        : readFileSync(file).toString("latin1");
      found.push(...findIn(text, file));
    }
  }
  return found;
}

export function scanStaged() {
  const diff = execFileSync("git", ["diff", "--cached", "-U0", "--no-color"], { cwd: root, maxBuffer: 1 << 30 }).toString("utf8");
  const found = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) file = line.slice(6);
    else if (line.startsWith("+")) found.push(...findIn(line.slice(1), file));
  }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const found = args[0] === "--staged" ? scanStaged() : scanPaths(args);
  if (found.length) {
    console.error(`Leak check failed:\n- ${[...new Set(found)].join("\n- ")}`);
    process.exit(1);
  }
  console.log("Leak check passed");
}
