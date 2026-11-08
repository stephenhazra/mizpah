import { hostOf, domainSuffixes } from "./host.js";

const PLAIN_DOMAIN = /^\|\|([a-z0-9.-]+)\^?$/;

const MAX_URL_LENGTH = 32768;
const SEPARATOR = /[^\w.%-]/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;

function compileGlob(pattern) {
  let body = pattern.toLowerCase();
  let start = "any";
  if (body.startsWith("||")) {
    start = "domain";
    body = body.slice(2);
  } else if (body.startsWith("|")) {
    start = "start";
    body = body.slice(1);
  }
  const end = body.endsWith("|");
  if (end) body = body.slice(0, -1);
  const parts = body.split("*").map((part) => ({ part, literal: part.split("^")[0] }));
  return { start, end, parts };
}

function matchAt(url, i, part) {
  for (let k = 0; k < part.length; k++, i++) {
    if (part[k] !== "^") {
      if (url[i] !== part[k]) return -1;
    } else if (i === url.length) {
      return k === part.length - 1 ? i : -1;
    } else if (!SEPARATOR.test(url[i])) {
      return -1;
    }
  }
  return i;
}

function findPart(url, from, { part, literal }, mustEnd) {
  for (let j = from; j <= url.length; j++) {
    if (literal) {
      j = url.indexOf(literal, j);
      if (j < 0) return -1;
    }
    const e = matchAt(url, j, part);
    if (e >= 0 && (!mustEnd || e === url.length)) return e;
  }
  return -1;
}

function anchorsFor(url, start) {
  if (start === "start") return [0];
  const scheme = SCHEME.exec(url);
  if (!scheme) return [];
  const out = [scheme[0].length];
  for (let j = scheme[0].length; j < url.length && !"/?#".includes(url[j]); j++) if (url[j] === ".") out.push(j + 1);
  return out;
}

function globMatch({ start, end, parts }, url) {
  const rest = (i, k) => {
    for (; k < parts.length; k++) {
      i = findPart(url, i, parts[k], end && k === parts.length - 1);
      if (i < 0) return false;
    }
    return true;
  };
  if (start === "any") return rest(0, 0);
  return anchorsFor(url, start).some((a) => {
    const e = matchAt(url, a, parts[0].part);
    return e >= 0 && (parts.length > 1 ? rest(e, 1) : !end || e === url.length);
  });
}

export function compilePopupFilters(entries, adDomains = []) {
  const domains = new Set(adDomains);
  const patterns = [];
  const exceptions = [];
  for (const e of entries) {
    const plain = PLAIN_DOMAIN.exec(e.p || "");
    if (plain && !e.d && !e.x && !e.e) {
      domains.add(plain[1]);
      continue;
    }
    if (!e.p) continue;
    (e.e ? exceptions : patterns).push({ glob: compileGlob(e.p), d: e.d, x: e.x });
  }
  return { domains, patterns, exceptions };
}

const domainOk = (entry, opener) => {
  if (entry.x && entry.x.some((d) => opener.includes(d))) return false;
  if (entry.d && !entry.d.some((d) => opener.includes(d))) return false;
  return true;
};

export function matchPopup(compiled, url, openerHost) {
  const host = hostOf(url);
  if (!host) return false;
  url = url.slice(0, MAX_URL_LENGTH).toLowerCase();
  const opener = domainSuffixes(openerHost);
  if (compiled.exceptions.some((e) => domainOk(e, opener) && globMatch(e.glob, url))) return false;
  if (domainSuffixes(host).some((s) => compiled.domains.has(s))) return true;
  return compiled.patterns.some((e) => domainOk(e, opener) && globMatch(e.glob, url));
}
