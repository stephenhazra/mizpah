const MULTI_TLD = /\.(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/;

export function registrableDomain(host) {
  host = (host || "").toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".");
  const keep = MULTI_TLD.test(host) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const PLAIN_DOMAIN = /^\|\|([a-z0-9.-]+)\^?$/;

function toRegex(pattern) {
  let re = "";
  let i = 0;
  if (pattern.startsWith("||")) {
    re = "^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*\\.)?";
    i = 2;
  } else if (pattern.startsWith("|")) {
    re = "^";
    i = 1;
  }
  let end = "";
  let body = pattern.slice(i);
  if (body.endsWith("|")) {
    body = body.slice(0, -1);
    end = "$";
  }
  for (const ch of body) {
    if (ch === "*") re += ".*";
    else if (ch === "^") re += "(?:[^\\w.%-]|$)";
    else re += ch.replace(/[.+?${}()[\]\\/]/g, "\\$&");
  }
  return new RegExp(re + end, "i");
}

export function compilePopupFilters(entries, adDomains = []) {
  const domains = new Map();
  const patterns = [];
  const exceptions = [];
  for (const e of entries) {
    const plain = PLAIN_DOMAIN.exec(e.p || "");
    if (plain && !e.d && !e.x && !e.e) {
      domains.set(plain[1], true);
      continue;
    }
    if (!e.p) continue;
    let re;
    try {
      re = toRegex(e.p);
    } catch {
      continue;
    }
    (e.e ? exceptions : patterns).push({ re, d: e.d, x: e.x });
  }
  for (const d of adDomains) domains.set(d, true);
  return { domains, patterns, exceptions };
}

const suffixes = (host) => {
  const parts = host.split(".");
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
};

const domainOk = (entry, openerHost) => {
  const opener = suffixes(openerHost);
  if (entry.x && entry.x.some((d) => opener.includes(d))) return false;
  if (entry.d && !entry.d.some((d) => opener.includes(d))) return false;
  return true;
};

export function matchPopup(compiled, url, openerHost) {
  const host = hostOf(url);
  if (!host) return false;
  if (compiled.exceptions.some((e) => domainOk(e, openerHost) && e.re.test(url))) return false;
  if (suffixes(host).some((s) => compiled.domains.has(s))) return true;
  return compiled.patterns.some((e) => domainOk(e, openerHost) && e.re.test(url));
}
