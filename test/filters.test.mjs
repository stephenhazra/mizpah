import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LISTS, parseFilterList, toRules, ruleKey, ruleHash, selectorToken, groupCosmetic, plainAdDomains } from "../lib/filters.js";

const one = (line) => parseFilterList(line);
const rule = (line) => one(line).network[0];

describe("parseFilterList: general", () => {
  test("ignores comments, headers and blank lines", () => {
    assert.deepEqual(parseFilterList("! c\n[Adblock Plus 2.0]\n# x\n\n"), { network: [], cosmetic: [], popups: [], skipped: 0 });
  });
  test("handles CRLF line endings", () => {
    const r = parseFilterList("||a.example.com^\r\n||b.example.com^\r\n");
    assert.equal(r.network.length, 2);
  });
  test("counts one skipped per rejected line", () => {
    assert.equal(parseFilterList("/regex/\n||ab^\n##.a:has-text(x)\n||ok.example.com^").skipped, 3);
  });
  test("LISTS ids are unique and have sources", () => {
    assert.equal(new Set(LISTS.map((l) => l.id)).size, LISTS.length);
    for (const l of LISTS) assert.ok(l.sources.every((s) => s.startsWith("https://")));
  });
});

describe("parseFilterList: network options", () => {
  test("script + third-party", () => {
    assert.deepEqual(rule("||ads.example.com^$script,third-party"), {
      action: { type: "block" },
      condition: { urlFilter: "||ads.example.com^", resourceTypes: ["script"], domainType: "thirdParty" },
      priority: 1
    });
  });
  test("first-party aliases and negation", () => {
    assert.equal(rule("||a.example.com^$~third-party").condition.domainType, "firstParty");
    assert.equal(rule("||a.example.com^$1p").condition.domainType, "firstParty");
    assert.equal(rule("||a.example.com^$3p").condition.domainType, "thirdParty");
    assert.equal(rule("||a.example.com^$first-party").condition.domainType, "firstParty");
    assert.equal(rule("||a.example.com^$~first-party").condition.domainType, "thirdParty");
  });
  test("$important raises priority to 3", () => {
    assert.equal(rule("||a.example.com^$important").priority, 3);
  });
  test("exception is allow at priority 2", () => {
    assert.deepEqual(rule("@@||ok.example.com^").action, { type: "allow" });
    assert.equal(rule("@@||ok.example.com^").priority, 2);
  });
  test("exception with $document becomes allowAllRequests on frames", () => {
    const r = rule("@@||ok.example.com^$document");
    assert.deepEqual(r.action, { type: "allowAllRequests" });
    assert.deepEqual(r.condition.resourceTypes, ["main_frame", "sub_frame"]);
  });
  test("blocking $document is a main_frame block", () => {
    const r = rule("||a.example.com^$document");
    assert.deepEqual(r.action, { type: "block" });
    assert.deepEqual(r.condition.resourceTypes, ["main_frame"]);
  });
  test("$domain and $from split include and exclude", () => {
    const c = rule("||a.example.com^$domain=b.com|~c.com").condition;
    assert.deepEqual(c.initiatorDomains, ["b.com"]);
    assert.deepEqual(c.excludedInitiatorDomains, ["c.com"]);
    assert.deepEqual(rule("||a.example.com^$from=b.com").condition.initiatorDomains, ["b.com"]);
  });
  test("wildcard TLD in $domain is skipped", () => {
    const r = one("||a.example.com^$domain=foo.*");
    assert.equal(r.network.length, 0);
    assert.equal(r.skipped, 1);
  });
  test("positive types win over negated types", () => {
    const c = rule("||a.example.com^$image,~script").condition;
    assert.deepEqual(c.resourceTypes, ["image"]);
    assert.equal(c.excludedResourceTypes, undefined);
  });
  test("only negated types gives excludedResourceTypes", () => {
    const c = rule("||a.example.com^$~image").condition;
    assert.deepEqual(c.excludedResourceTypes, ["image"]);
    assert.equal(c.resourceTypes, undefined);
  });
  test("type aliases", () => {
    assert.deepEqual(rule("||a.example.com^$css,xhr,subdocument,beacon").condition.resourceTypes, ["stylesheet", "xmlhttprequest", "sub_frame", "ping"]);
  });
  test("$all expands to 12 types", () => {
    assert.equal(rule("||a.example.com^$all").condition.resourceTypes.length, 12);
  });
  test("duplicate types collapse", () => {
    assert.deepEqual(rule("||a.example.com^$script,script").condition.resourceTypes, ["script"]);
  });
  test("$match-case sets case sensitivity", () => {
    assert.equal(rule("||a.example.com^$match-case").condition.isUrlFilterCaseSensitive, true);
  });
  test("$webrtc and unknown options are skipped", () => {
    assert.equal(one("||a.example.com^$webrtc").skipped, 1);
    assert.equal(one("||a.example.com^$bogus").skipped, 1);
  });
  test("ignored options do not skip the rule", () => {
    assert.equal(one("||a.example.com^$collapse").network.length, 1);
  });
  test("$ inside a path before a slash is not an option separator", () => {
    assert.equal(rule("||a.example.com/x$y/z").condition.urlFilter, "||a.example.com/x$y/z");
  });
});

describe("parseFilterList: rejections", () => {
  test("regex filters are skipped", () => {
    assert.equal(one("/ads\\d+/").skipped, 1);
  });
  test("core under 3 characters is skipped", () => {
    assert.equal(one("||ab^").skipped, 1);
  });
  test("non-ASCII patterns are skipped", () => {
    assert.equal(one("||abécd.com^").skipped, 1);
  });
  test("bare wildcard is skipped without $domain", () => {
    assert.equal(one("*").skipped, 1);
    assert.equal(one("$script").skipped, 1);
  });
  test("bare wildcard with $domain is kept", () => {
    assert.deepEqual(rule("*$domain=a.com").condition, { initiatorDomains: ["a.com"] });
  });
});

describe("parseFilterList: pop-up filters", () => {
  test("$popup yields a popup entry and no network rule", () => {
    const r = one("||x.example.com^$popup");
    assert.deepEqual(r.popups, [{ p: "||x.example.com^" }]);
    assert.equal(r.network.length, 0);
  });
  test("$popup with a type yields both", () => {
    const r = one("||x.example.com^$popup,script");
    assert.equal(r.popups.length, 1);
    assert.deepEqual(r.network[0].condition.resourceTypes, ["script"]);
  });
  test("exception sets e:1", () => {
    assert.deepEqual(one("@@||x.example.com^$popup").popups, [{ p: "||x.example.com^", e: 1 }]);
  });
  test("domain restrictions become d and x", () => {
    assert.deepEqual(one("||x.example.com^$popup,domain=a.com|~b.com").popups, [{ p: "||x.example.com^", d: ["a.com"], x: ["b.com"] }]);
  });
  test("negated $popup is ignored", () => {
    assert.equal(one("||x.example.com^$~popup").popups.length, 0);
  });
});

describe("parseFilterList: cosmetic", () => {
  test("site rule", () => {
    assert.deepEqual(one("example.com##.a").cosmetic, [{ selector: ".a", exception: false, include: ["example.com"], exclude: [] }]);
  });
  test("generic rule", () => {
    assert.deepEqual(one("##.a").cosmetic, [{ selector: ".a", exception: false, include: [], exclude: [] }]);
  });
  test("include and exclude domains", () => {
    const [c] = one("~a.com,b.com##.x").cosmetic;
    assert.deepEqual(c.include, ["b.com"]);
    assert.deepEqual(c.exclude, ["a.com"]);
  });
  test("#@# is an exception", () => {
    assert.equal(one("example.com#@#.a").cosmetic[0].exception, true);
  });
  for (const line of [
    "##.a:has-text(x)",
    "example.*##.a",
    "a.com#?#.x",
    "a.com#$#.x",
    "a.com#%#.x",
    "a.com#@?#.x",
    "a.com##+js(x)",
    "a.com##.a{x}",
    "a.com##.é",
    "a.com##",
    "a.com##.x:remove()"
  ]) {
    test(`skips ${JSON.stringify(line)}`, () => {
      const r = one(line);
      assert.equal(r.cosmetic.length, 0);
      assert.equal(r.skipped, 1);
    });
  }
  test("# comment that is not ## is not counted", () => {
    assert.equal(one("# hi").skipped, 0);
  });
  test("invalid domain part is skipped", () => {
    assert.equal(one("nodot##.a").skipped, 1);
  });
});

describe("parseFilterList: generichide and elemhide", () => {
  test("@@||site^$generichide gives a hide entry", () => {
    const r = one("@@||site.example.com^$generichide");
    assert.deepEqual(r.cosmetic, [{ hide: "generic", include: ["site.example.com"], exclude: [] }]);
    assert.equal(r.network.length, 0);
    assert.equal(r.skipped, 0);
  });
  test("@@||site^$elemhide gives an elem entry", () => {
    assert.equal(one("@@||site.example.com^$elemhide").cosmetic[0].hide, "elem");
  });
  test("aliases ghide and ehide", () => {
    assert.equal(one("@@||a.example.com^$ghide").cosmetic[0].hide, "generic");
    assert.equal(one("@@||a.example.com^$ehide").cosmetic[0].hide, "elem");
  });
  test("$generichide on a blocking rule is skipped", () => {
    assert.equal(one("||a.example.com^$generichide").skipped, 1);
  });
  test("$generichide with a path pattern is skipped", () => {
    assert.equal(one("@@||a.example.com/path^$generichide").skipped, 1);
  });
});

describe("ruleKey and toRules", () => {
  const a = { action: { type: "block" }, condition: { urlFilter: "||a.example.com^", domainType: "thirdParty" }, priority: 1 };
  const b = { action: { type: "block" }, condition: { domainType: "thirdParty", urlFilter: "||a.example.com^" }, priority: 1 };
  test("ruleKey is key-order independent", () => {
    assert.equal(ruleKey(a), ruleKey(b));
  });
  test("ruleKey differs on priority", () => {
    assert.notEqual(ruleKey(a), ruleKey({ ...a, priority: 2 }));
  });
  test("ruleKey ignores id", () => {
    assert.equal(ruleKey({ id: 5, ...a }), ruleKey(a));
  });
  test("ruleKey is array-order sensitive for resourceTypes", () => {
    const x = { ...a, condition: { resourceTypes: ["script", "image"] } };
    const y = { ...a, condition: { resourceTypes: ["image", "script"] } };
    assert.notEqual(ruleKey(x), ruleKey(y));
  });
  test("toRules assigns ids from startId", () => {
    const rules = toRules([a, { ...a, priority: 2 }], 100);
    assert.deepEqual(rules.map((r) => r.id), [100, 101]);
  });
  test("toRules dedupes identical rules", () => {
    assert.equal(toRules([a, { ...a }]).length, 1);
  });
  test("toRules dedupes rules that differ only in key order", () => {
    assert.equal(toRules([a, b]).length, 1);
  });
  test("toRules does not mutate its input", () => {
    const input = [{ ...a }];
    toRules(input, 7);
    assert.equal("id" in input[0], false);
  });
});

describe("selectorToken", () => {
  const cases = [
    [".ad", ".ad"],
    ["div.ad-x > a", ".ad-x"],
    ["#a b", "#a"],
    ["a.b", ".b"],
    [".ad.other", ".ad"],
    ["[data-x]", null],
    ["div", null],
    ["a:not(.x)", null],
    [".a\\:b", null]
  ];
  for (const [sel, token] of cases) test(`${sel} -> ${token}`, () => assert.equal(selectorToken(sel), token));
});

describe("groupCosmetic", () => {
  const group = (text) => groupCosmetic(parseFilterList(text).cosmetic);
  test("generic with a token goes to genericTokens", () => {
    const g = group("##.ad");
    assert.deepEqual(g.genericTokens, { ".ad": [".ad"] });
    assert.deepEqual(g.generic, []);
  });
  test("generic without a token stays in generic", () => {
    assert.deepEqual(group("##div > [data-k]").generic, ["div > [data-k]"]);
  });
  test("duplicate generic selectors are deduped", () => {
    assert.deepEqual(group("##.ad\n##.ad").genericTokens[".ad"], [".ad"]);
  });
  test("include goes to specific", () => {
    assert.deepEqual(group("a.com##.s\nb.com##.s").specific, { "a.com": [".s"], "b.com": [".s"] });
  });
  test("exclude-only is generic plus exceptions", () => {
    const g = group("~a.com##.g");
    assert.deepEqual(g.genericTokens, { ".g": [".g"] });
    assert.deepEqual(g.exceptions, { "a.com": [".g"] });
  });
  test("exception with include goes to exceptions", () => {
    assert.deepEqual(group("b.com#@#.s").exceptions, { "b.com": [".s"] });
  });
  test("exception without include goes to genericExceptions", () => {
    assert.deepEqual(group("#@#.ge").genericExceptions, [".ge"]);
  });
  test("hide entries populate genericHide and elemHide", () => {
    const g = group("@@||q.example.com^$generichide\n@@||r.example.com^$elemhide");
    assert.deepEqual(g.genericHide, { "q.example.com": 1 });
    assert.deepEqual(g.elemHide, { "r.example.com": 1 });
  });
  test("empty input", () => {
    assert.deepEqual(groupCosmetic([]), { generic: [], genericTokens: {}, specific: {}, exceptions: {}, genericExceptions: [], genericHide: {}, elemHide: {} });
  });
});

describe("plainAdDomains", () => {
  const block = (urlFilter, extra = {}) => ({ action: { type: "block" }, condition: { urlFilter, ...extra }, priority: 1 });
  test("keeps plain domain blocks", () => {
    assert.deepEqual(plainAdDomains([block("||ads.example.com^")]), ["ads.example.com"]);
  });
  test("keeps thirdParty", () => {
    assert.deepEqual(plainAdDomains([block("||d.example.com^", { domainType: "thirdParty" })]), ["d.example.com"]);
  });
  test("drops rules with other conditions", () => {
    assert.deepEqual(plainAdDomains([block("||ads.example.com^", { resourceTypes: ["script"] }), block("||b.example.com^", { initiatorDomains: ["x.com"] })]), []);
  });
  test("drops allow rules, paths and non-anchored filters", () => {
    assert.deepEqual(
      plainAdDomains([{ action: { type: "allow" }, condition: { urlFilter: "||b.example.com^" }, priority: 2 }, block("||c.example.com/path^"), block("ads.example.com"), block("||ads.example.com")]),
      []
    );
  });
});

describe("ruleHash", () => {
  const a = { action: { type: "block" }, condition: { urlFilter: "||a.example.com^", domainType: "thirdParty" }, priority: 1 };
  test("is stable and key-order independent", () => {
    const b = { priority: 1, condition: { domainType: "thirdParty", urlFilter: "||a.example.com^" }, action: { type: "block" } };
    assert.equal(ruleHash(a), ruleHash(b));
    assert.equal(typeof ruleHash(a), "string");
  });
  test("ignores id and differs on content", () => {
    assert.equal(ruleHash({ id: 9, ...a }), ruleHash(a));
    assert.notEqual(ruleHash(a), ruleHash({ ...a, priority: 2 }));
    assert.notEqual(ruleHash(a), ruleHash({ ...a, condition: { ...a.condition, urlFilter: "||b.example.com^" } }));
  });
});

describe("unsafe cosmetic selectors", () => {
  for (const sel of ["/* x */.a", ".a */", ".a<!--", ".a-->", ".a\\", '.a[x="y]', ".a;b", ".a@b"]) {
    test(`skips ${JSON.stringify(sel)}`, () => {
      const r = one(`a.com##${sel}`);
      assert.equal(r.cosmetic.length, 0);
      assert.equal(r.skipped, 1);
    });
  }
  test("allows ; and @ inside quoted attribute values", () => {
    assert.equal(one('a.com##a[href="x;y@z"]').cosmetic.length, 1);
    assert.equal(one("a.com##a[href='x;y']").cosmetic.length, 1);
  });
});
