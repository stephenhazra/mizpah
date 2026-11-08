import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compilePopupFilters, matchPopup } from "../lib/popup.js";

const compile = (entries, ad) => compilePopupFilters(Array.isArray(entries) ? entries : [entries], ad);
const hit = (entries, url, opener = "opener.example", ad) => matchPopup(compile(entries, ad), url, opener);

describe("plain domain entries", () => {
  const c = compile({ p: "||evil.com^" });
  test("match the domain and its subdomains", () => {
    assert.equal(matchPopup(c, "https://evil.com/x", "a.com"), true);
    assert.equal(matchPopup(c, "https://sub.evil.com/", "a.com"), true);
  });
  test("do not match lookalikes", () => {
    assert.equal(matchPopup(c, "https://notevil.com/", "a.com"), false);
    assert.equal(matchPopup(c, "https://evil.com.org/", "a.com"), false);
    assert.equal(matchPopup(c, "https://other.com/evil.com/", "a.com"), false);
  });
  test("are stored in the domain set, not the pattern list", () => {
    assert.ok(c.domains.has("evil.com"));
    assert.equal(c.patterns.length, 0);
  });
  test("adDomains argument matches the same way", () => {
    const m = compile([], ["ads.net"]);
    assert.equal(matchPopup(m, "http://x.ads.net/", "a.com"), true);
    assert.equal(matchPopup(m, "http://ads.net.evil.com/", "a.com"), false);
  });
  test("a learned domain added later matches", () => {
    const m = compile([]);
    assert.equal(matchPopup(m, "http://x.learned.org/", "a.com"), false);
    m.domains.add("learned.org");
    assert.equal(matchPopup(m, "http://x.learned.org/", "a.com"), true);
  });
  test("an entry with d, x or e is not a plain domain", () => {
    for (const extra of [{ d: ["a.com"] }, { x: ["a.com"] }, { e: 1 }]) assert.equal(compile({ p: "||x.com^", ...extra }).domains.size, 0);
  });
});

describe("unparseable input", () => {
  test("unparseable URL returns false", () => {
    assert.equal(matchPopup(compile({ p: "||evil.com^" }), "not a url", "a.com"), false);
    assert.equal(matchPopup(compile({ p: "||evil.com^" }), "", "a.com"), false);
  });
  test("entries without a pattern are ignored", () => {
    assert.doesNotThrow(() => compile([{}, { d: ["a.com"] }]));
  });
});

describe("glob patterns", () => {
  test("^ matches a separator or end", () => {
    assert.equal(hit({ p: "/pop^" }, "http://h.com/pop/"), true);
    assert.equal(hit({ p: "/pop^" }, "http://h.com/pop?x"), true);
    assert.equal(hit({ p: "/pop^" }, "http://h.com/pop"), true);
    assert.equal(hit({ p: "/pop^" }, "http://h.com/popular"), false);
  });
  test("* is a wildcard", () => {
    assert.equal(hit({ p: "/ads/*/pop" }, "http://h.com/ads/1/2/pop"), true);
    assert.equal(hit({ p: "/ads/*/pop" }, "http://h.com/ads/pop"), false);
  });
  test("leading | anchors the start", () => {
    assert.equal(hit({ p: "|http://x.com/" }, "http://x.com/z"), true);
    assert.equal(hit({ p: "|http://x.com/" }, "http://y.com/?u=http://x.com/"), false);
  });
  test("trailing | anchors the end", () => {
    assert.equal(hit({ p: "/pop|" }, "http://h.com/pop"), true);
    assert.equal(hit({ p: "/pop|" }, "http://h.com/pops"), false);
    assert.equal(hit({ p: "/a*b|" }, "http://h.com/a123b"), true);
    assert.equal(hit({ p: "/a*b|" }, "http://h.com/a123bc"), false);
  });
  test("both anchors", () => {
    assert.equal(hit({ p: "|http://x.com|" }, "http://x.com"), true);
    assert.equal(hit({ p: "|http://x.com|" }, "http://x.com/"), false);
  });
  test("|| with a path anchors at a domain boundary", () => {
    assert.equal(hit({ p: "||x.com/pop^" }, "http://a.x.com/pop?q"), true);
    assert.equal(hit({ p: "||x.com/pop^" }, "http://x.com/pop"), true);
    assert.equal(hit({ p: "||x.com/pop^" }, "http://y.com/?u=http://x.com/pop"), false);
    assert.equal(hit({ p: "||x.com/pop^" }, "http://notx.com/pop"), false);
  });
  test("|| with a wildcard keeps the domain anchor", () => {
    assert.equal(hit({ p: "||x.com^*z" }, "http://x.com/q/z"), true);
    assert.equal(hit({ p: "||x.com^*z" }, "http://y.com/x.com/z"), false);
  });
  test("matching is case-insensitive", () => {
    assert.equal(hit({ p: "/Ads/*/POP" }, "http://h.com/ADS/1/pop"), true);
  });
  test("regex metacharacters are literal", () => {
    assert.equal(hit({ p: "/q.+?x" }, "http://h.com/q.+?x"), true);
    assert.equal(hit({ p: "/q.+?x" }, "http://h.com/qaax"), false);
    assert.equal(hit({ p: "/a.b" }, "http://h.com/axb"), false);
  });
  test("pattern foo|bar is not an alternation", () => {
    assert.equal(hit({ p: "foo|bar" }, "https://q.com/bar"), false);
    assert.equal(hit({ p: "foo|bar" }, "https://q.com/foo"), false);
  });
  test("unbalanced bracket patterns do not throw", () => {
    assert.doesNotThrow(() => hit({ p: "([" }, "http://h.com/(["));
    assert.equal(hit({ p: "([" }, "http://h.com/(["), true);
  });
  test("pattern with only a separator", () => {
    assert.equal(hit({ p: "^pop" }, "http://h.com/pop"), true);
  });
});

describe("opener restrictions", () => {
  test("d restricts to the opener and its subdomains", () => {
    const e = { p: "||x.com^$popup".replace("$popup", ""), d: ["a.com"] };
    assert.equal(hit(e, "http://x.com/", "a.com"), true);
    assert.equal(hit(e, "http://x.com/", "sub.a.com"), true);
    assert.equal(hit(e, "http://x.com/", "b.com"), false);
    assert.equal(hit(e, "http://x.com/", "nota.com"), false);
  });
  test("x excludes openers", () => {
    const e = { p: "||x.com^", x: ["a.com"] };
    assert.equal(hit(e, "http://x.com/", "a.com"), false);
    assert.equal(hit(e, "http://x.com/", "b.com"), true);
  });
  test("d works with pattern entries", () => {
    const e = { p: "/pop^", d: ["a.com"] };
    assert.equal(hit(e, "http://h.com/pop", "a.com"), true);
    assert.equal(hit(e, "http://h.com/pop", "b.com"), false);
  });
});

describe("exceptions", () => {
  test("exception beats a plain domain match", () => {
    const c = compile([{ p: "||x.com^" }, { p: "||x.com^", e: 1 }]);
    assert.equal(matchPopup(c, "http://x.com/", "a.com"), false);
  });
  test("exception beats a pattern match", () => {
    const c = compile([{ p: "/pop^" }, { p: "/pop^", e: 1 }]);
    assert.equal(matchPopup(c, "http://h.com/pop", "a.com"), false);
  });
  test("exception respects its own d", () => {
    const c = compile([{ p: "||x.com^" }, { p: "||x.com^", e: 1, d: ["ok.com"] }]);
    assert.equal(matchPopup(c, "http://x.com/", "ok.com"), false);
    assert.equal(matchPopup(c, "http://x.com/", "no.com"), true);
  });
  test("exception beats an adDomains match", () => {
    const c = compile([{ p: "||x.com^", e: 1 }], ["x.com"]);
    assert.equal(matchPopup(c, "http://x.com/", "a.com"), false);
  });
});

describe("adversarial input", () => {
  const big = "http://h.com/" + "a".repeat(100 * 1024);
  const patterns = ["*a*a*a*b", "/a*a*a*a*a*a*a*c|", "||h.com^*x*y", "a^a^a^a^a^b", "*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b"];
  for (const p of patterns) {
    test(`100 KB URL against ${p} finishes in under 50 ms`, () => {
      const c = compile({ p });
      const start = performance.now();
      const result = matchPopup(c, big, "o.com");
      const ms = performance.now() - start;
      assert.equal(result, false);
      assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
    });
  }
  test("100 KB URL with many patterns finishes in under 50 ms", () => {
    const c = compile(patterns.map((p) => ({ p })));
    const start = performance.now();
    matchPopup(c, big, "o.com");
    const ms = performance.now() - start;
    assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
  });
  test("a long URL with a literal match inside the first 32 KB still matches", () => {
    assert.equal(hit({ p: "/needle^" }, "http://h.com/needle/" + "a".repeat(100 * 1024)), true);
  });
});
