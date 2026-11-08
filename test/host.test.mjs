import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isIp, isHostname, normalizeHost, hostOf, domainSuffixes, hostCandidates, isAllowlisted, registrableDomain, parseDomainList, isSiteHost } from "../lib/host.js";

describe("hostOf", () => {
  const cases = [
    ["https://Sub.Example.com/x", "sub.example.com"],
    ["http://[::1]:80/", "[::1]"],
    ["http://user:pw@a.example.com:8080/p?q#h", "a.example.com"],
    ["not a url", ""],
    ["", ""],
    ["about:blank", ""]
  ];
  for (const [url, host] of cases) test(JSON.stringify(url), () => assert.equal(hostOf(url), host));
});

describe("isIp / isHostname / normalizeHost", () => {
  test("isIp", () => {
    assert.equal(isIp("1.2.3.4"), true);
    assert.equal(isIp("[::1]"), true);
    assert.equal(isIp("example.com"), false);
  });
  test("isHostname", () => {
    assert.deepEqual(["a-b.c", "localhost", "1.2.3.4", "a b", "a_b", ""].map(isHostname), [true, true, true, false, false, false]);
  });
  test("normalizeHost strips case, trailing dot and www", () => {
    assert.equal(normalizeHost("WWW.Example.COM."), "example.com");
    assert.equal(normalizeHost("wwwx.com"), "wwwx.com");
  });
});

describe("hostCandidates", () => {
  test("walks up to the second-level suffix", () => {
    assert.deepEqual(hostCandidates("a.b.example.com"), ["a.b.example.com", "b.example.com", "example.com"]);
  });
  test("strips www and folds case", () => {
    assert.deepEqual(hostCandidates("WWW.A.com"), ["a.com"]);
  });
  test("includes the public suffix for multi-part TLDs (current behaviour)", () => {
    assert.deepEqual(hostCandidates("example.co.uk"), ["example.co.uk", "co.uk"]);
  });
  test("localhost is a candidate of itself", () => {
    assert.deepEqual(hostCandidates("localhost"), ["localhost"]);
  });
  test("IPv4 is not split into fake suffixes", () => {
    assert.deepEqual(hostCandidates("1.2.3.4"), ["1.2.3.4"]);
  });
  test("bracketed IPv6 stays whole", () => {
    assert.deepEqual(hostCandidates("[::1]"), ["[::1]"]);
  });
  test("domainSuffixes of single label", () => {
    assert.deepEqual(domainSuffixes("intranet"), ["intranet"]);
  });
});

describe("isAllowlisted", () => {
  test("matches parent domains and www", () => {
    assert.equal(isAllowlisted("www.a.b.com", ["b.com"]), true);
    assert.equal(isAllowlisted("a.b.com", ["a.b.com"]), true);
  });
  test("does not match siblings or suffix lookalikes", () => {
    assert.equal(isAllowlisted("a.com", ["b.com"]), false);
    assert.equal(isAllowlisted("notb.com", ["b.com"]), false);
    assert.equal(isAllowlisted("b.com", ["a.b.com"]), false);
  });
  test("matches localhost and IPs", () => {
    assert.equal(isAllowlisted("localhost", ["localhost"]), true);
    assert.equal(isAllowlisted("1.2.3.4", ["1.2.3.4"]), true);
    assert.equal(isAllowlisted("2.3.4", ["3.4"]), false);
  });
  test("empty list", () => {
    assert.equal(isAllowlisted("a.com", []), false);
  });
});

describe("registrableDomain", () => {
  const cases = [
    ["a.b.example.com", "example.com"],
    ["example.com", "example.com"],
    ["a.b.co.uk", "b.co.uk"],
    ["x.com.au", "x.com.au"],
    ["example.com.", "example.com"],
    ["EXAMPLE.com", "example.com"],
    ["127.0.0.1", "127.0.0.1"],
    ["[::1]", "[::1]"],
    ["localhost", "localhost"],
    ["", ""],
    ["x.github.io", "x.github.io"],
    ["a.b.github.io", "b.github.io"],
    ["github.io", "github.io"],
    ["user.pages.dev", "user.pages.dev"],
    ["a.user.vercel.app", "user.vercel.app"]
  ];
  for (const [host, expected] of cases) test(`${JSON.stringify(host)} -> ${JSON.stringify(expected)}`, () => assert.equal(registrableDomain(host), expected));
  test("two projects on a shared host are different domains", () => {
    assert.notEqual(registrableDomain("alice.github.io"), registrableDomain("bob.github.io"));
  });
  test("undefined is tolerated", () => {
    assert.equal(registrableDomain(undefined), "");
  });
});

describe("parseDomainList", () => {
  test("normalises URLs, case, www and duplicates, and sorts", () => {
    assert.deepEqual(parseDomainList(" HTTPS://www.Foo.com/path\n.\na..b\nfoo.com\nzed.org\nbar.net"), ["bar.net", "foo.com", "zed.org"]);
  });
  test("drops invalid entries", () => {
    assert.deepEqual(parseDomainList("b_c\n_x\n.\n..\na..b\n.a"), []);
  });
  test("accepts localhost and IPv4", () => {
    assert.deepEqual(parseDomainList("localhost 10.0.0.1"), ["10.0.0.1", "localhost"]);
  });
  test("strips query and fragment", () => {
    assert.deepEqual(parseDomainList("a.com?x=1 b.com#y"), ["a.com", "b.com"]);
  });
  test("empty and whitespace input", () => {
    assert.deepEqual(parseDomainList(""), []);
    assert.deepEqual(parseDomainList(" \n\t "), []);
  });
  test("a host:port entry is not stored verbatim", () => {
    assert.ok(!parseDomainList("bar.org:80").includes("bar.org:80"));
  });
});

describe("isSiteHost", () => {
  test("accepts normal hosts, localhost and IPs", () => {
    for (const h of ["example.com", "a.b.example.co.uk", "localhost", "10.0.0.1", "[::1]"]) assert.equal(isSiteHost(h), true, h);
  });
  test("rejects bare TLDs, public suffixes and shared hosting suffixes", () => {
    for (const h of ["com", "intranet", "co.uk", "github.io", "pages.dev", ""]) assert.equal(isSiteHost(h), false, h);
  });
  test("rejects non-strings", () => {
    for (const h of [undefined, null, 5, {}]) assert.equal(isSiteHost(h), false);
  });
  test("parseDomainList drops public suffixes", () => {
    assert.deepEqual(parseDomainList("com co.uk github.io a.github.io"), ["a.github.io"]);
  });
});
