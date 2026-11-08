const MULTI_TLD = /\.(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/;
const SHARED_SUFFIXES = new Set([
  "github.io", "gitlab.io", "codeberg.page", "pages.dev", "workers.dev", "vercel.app", "netlify.app", "herokuapp.com",
  "onrender.com", "fly.dev", "deno.dev", "web.app", "firebaseapp.com", "appspot.com", "run.app", "cloudfunctions.net",
  "blogspot.com", "wordpress.com", "tumblr.com", "substack.com", "wixsite.com", "weebly.com", "squarespace.com",
  "myshopify.com", "webflow.io", "framer.app", "notion.site", "carrd.co", "itch.io", "neocities.org", "surge.sh",
  "glitch.me", "replit.app", "repl.co", "readthedocs.io", "pythonanywhere.com", "azurewebsites.net",
  "azurestaticapps.net", "azureedge.net", "cloudfront.net", "amazonaws.com", "translate.goog", "ngrok.io", "ngrok-free.app"
]);

export const isIp = (host) => /^\d+(\.\d+)+$/.test(host) || /^\[?[0-9a-f]*:[0-9a-f]*:[0-9a-f:.]*\]?$/i.test(host);
export const isHostname = (host) => isIp(host) || /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host);
const PUBLIC_SUFFIX = /^((co|com|net|org|gov|edu|ac|or|ne|go)\.)?[a-z]{2,}$/;
export const isSiteHost = (host) =>
  typeof host === "string" && (isIp(host) || host === "localhost" || (isHostname(host) && !PUBLIC_SUFFIX.test(host) && !SHARED_SUFFIXES.has(host)));

export const normalizeHost = (host) => host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function domainSuffixes(host) {
  if (isIp(host) || !host.includes(".")) return [host];
  const parts = host.split(".");
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
}

export const hostCandidates = (hostname) => domainSuffixes(normalizeHost(hostname));

export function isAllowlisted(hostname, allowlist) {
  const candidates = hostCandidates(hostname);
  return allowlist.some((d) => candidates.includes(d));
}

export function registrableDomain(host) {
  host = (host || "").toLowerCase().replace(/\.$/, "");
  if (isIp(host)) return host;
  const parts = host.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    if (SHARED_SUFFIXES.has(parts.slice(i).join("."))) return parts.slice(i - 1).join(".");
  }
  return parts.slice(MULTI_TLD.test(host) ? -3 : -2).join(".");
}

export const parseDomainList = (text) =>
  [
    ...new Set(
      text
        .split(/\s+/)
        .map((d) => normalizeHost(d.trim().replace(/^https?:\/\//i, "").replace(/[/?#].*$/, "")))
        .filter(isSiteHost)
    )
  ].sort();
