# Mizpah Ad Blocker

A Manifest V3 Chrome extension that blocks ads, trackers and annoyances.

## Features

- **Network blocking** with `declarativeNetRequest` static rulesets for ads, trackers and annoyances.
- **Cosmetic filtering** with generic and per-site element hiding, injected as user-origin CSS that pages cannot override.
- **Pop-up blocking** closes pop-up and pop-under ad tabs that match EasyList's pop-up rules or its ad-server domains. It also closes tabs you didn't open from a visible link that bounce through three or more outside domains, and remembers where they started. "Block all pop-ups on this site" in the popup stops a site from opening new windows at all.
- **YouTube ad removal** that strips ad data from player responses and skips any ad that still plays.
- **Element picker** to hide anything on a page and save it as a custom filter.
- **Custom filters** in Adblock Plus / uBlock Origin syntax.
- **Trusted sites** to turn blocking off per domain, and a global pause switch.
- **Badge count** of blocked requests per tab.
- **Backup** export and import of settings.
- **Automatic list updates** once a day, with an "Update now" button in Settings.
- **Rebuild alerts** by Chrome notification, a "!" badge and a Settings banner when the built-in rules need refreshing.

## Platforms

| Browser | Package | Store |
| --- | --- | --- |
| Chrome (Windows, macOS, Linux, ChromeOS) | `dist/mizpah-<version>-chrome.zip` | Chrome Web Store |
| Microsoft Edge (Windows, macOS) | same Chrome zip | Microsoft Edge Add-ons |
| Firefox (desktop and Android) | `dist/mizpah-<version>-firefox.xpi` | Firefox Add-ons |
| Safari (macOS, iOS, iPadOS) | Xcode project in `platforms/Mizpah` | Mac and iOS App Store |

Chrome on iOS cannot run extensions, because Apple allows extensions only in Safari. Chrome on Android does not support extensions yet, so Android users get Mizpah through Firefox.

Safari lacks a few APIs, so Mizpah adapts there. It detects pop-up tabs through tab events instead of navigation events, and it has no blocked-request count or notifications. Firefox shows no blocked-request count either.

```bash
node tools/package.mjs
```

```bash
tools/safari.sh
```

The first builds the Chrome, Edge and Firefox packages. The second regenerates the Safari Xcode project; set `BUILD_NUMBER` to a number above your last upload, or it uses the current UTC time as `yymmddHHMM`. `tools/safari.sh --check` compares the committed Xcode copy of the extension with a fresh build. `tools/apple-archive.sh` archives the iOS and macOS apps; it takes your Apple team ID from `APPLE_TEAM_ID` or the gitignored `platforms/team.local`, so the ID is never written into the project. Versions, store limits and Apple settings are in `tools/release.config.json`. Publishing to the App Store needs a paid Apple Developer Program membership. The App Store listing, screenshots in `store/apple/` and the build and upload steps are in [store/app-store.md](store/app-store.md). Regenerate the App Store screenshots with `node tools/apple-assets.mjs`.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.

## Use the full EasyList filter lists

The bundled lists are curated and small. To match uBlock Origin Lite coverage, rebuild the rulesets with EasyList, EasyPrivacy and Fanboy's Annoyance list:

```bash
node tools/build-rules.mjs --remote
```

Then click the reload icon for Mizpah on `chrome://extensions`. Each list is split across a main and an `-extra` ruleset of up to 29,000 network rules each. General hiding rules keyed by a class or id are applied only when that class or id appears on the page.

## Keeping lists current

Chrome does not let an extension replace its built-in rule sets after install. Mizpah works around this between rebuilds:

- It downloads EasyList, EasyPrivacy and Fanboy's Annoyance list once a day.
- Network rules that are new since the last build are added as dynamic rules, up to Chrome's 30,000 limit.
- Shipped rules that the lists have since removed are switched off, up to Chrome's 5,000 limit.
- Hiding rules are replaced completely, since they have no size limit.

A rebuild is flagged when new rules no longer fit, when more than 5,000 shipped rules have been retired, or when the built-in rules are over 30 days old. Mizpah then shows a notification and a banner in Settings with the command to run. Rebuilding or reloading the extension clears the downloaded data, and the next daily update starts fresh from the new build.

## Supported filter syntax

| Syntax | Meaning |
| --- | --- |
| `\|\|ads.example^` | Block a domain and its subdomains |
| `@@\|\|cdn.example^` | Exception |
| `@@\|\|site.example^$document` | Turn off blocking on a site |
| `$third-party`, `$1p` | Party restriction |
| `$script`, `$image`, `$xhr`, `~$font` and similar | Resource types |
| `$domain=a.com\|~b.com` | Restrict to pages on these domains |
| `$important` | Overrides exceptions |
| `##.selector` | Hide everywhere |
| `site.com##.selector` | Hide on one site |
| `site.com#@#.selector` | Cosmetic exception |

Regex network filters, `redirect`, `removeparam`, `csp`, scriptlet (`##+js`) and procedural cosmetic filters (`:has-text`, `:upward` and similar) are skipped.

## Development

```bash
node tools/build-rules.mjs
```

```bash
python3 tools/make-icons.py icons
```

## Testing

Unit tests need only Node, no install step:

```bash
node --test test/
```

They cover the filter parser, pop-up matcher, host helpers and settings validation.

The smoke test loads the extension into a headless Chrome with a throwaway profile and local fixture sites, and takes about a minute. It checks rulesets, network rule semantics, cosmetic hiding, trusted sites, pause, strict pop-up sites, the pop-up guard, the popup and Settings pages, the picker and the YouTube scriptlet. It needs Chrome (set `CHROME_PATH` if it is not in the default location) and `openssl`.

```bash
node tools/smoke-test.mjs
```

With `--refresh` it also downloads the lists and checks the update path.

```bash
node tools/smoke-test.mjs --refresh
```

The real-site test loads well-known ad-heavy sites with blocking on and then paused, and compares visible ads and ad requests. It is a report, not a pass or fail test. Pass your own URLs as arguments to test other sites.

```bash
node tools/real-test.mjs
```

## Publishing to the Chrome Web Store

```bash
node tools/build-rules.mjs --remote
```

```bash
node tools/store-assets.mjs
```

```bash
node tools/package.mjs
```

`build-rules.mjs --remote` fails when a download is missing, truncated or much smaller than the cached copy, and marks the build as remote only when every list was fetched fresh. Pass `--allow-cache` to fall back to cached lists, which `package.mjs` then refuses to package without `--force`. The packaging script refuses to build from rules older than a week or not built with `--remote`, writes `store: true` into the packaged `build-info.json`, strips your local folder path, scans every output with `tools/leak-check.mjs` for local paths, emails and Apple team IDs, and writes a reproducible upload zip to `dist/`. Pass `--keep-stage` to keep the staged folder for testing. To scan staged changes before each commit, run `ln -s ../../tools/pre-commit .git/hooks/pre-commit`. Store installs never show the rebuild alert, which stays on for your unpacked development copy. Listing text and permission justifications are in `store/`. The privacy policy and homepage are in `docs/`, served by GitHub Pages at https://stephenhazra.github.io/mizpah/.

## Layout

- `manifest.json` declares the extension.
- `background.js` is the service worker entry: message handlers and lifecycle events.
- `background/` holds the worker modules: `apply.js` (rulesets, dynamic rules, content-script registration), `cosmetic.js` (cosmetic CSS injection), `lists.js` (daily list updates and the rebuild notice), `popup-guard.js` (pop-up closing) and `settings.js` (cached settings).
- `lib/filters.js` is the filter parser, shared by the background worker and the build tool. `lib/host.js`, `lib/popup.js` and `lib/settings.js` hold host helpers, the pop-up matcher and the settings schema.
- `filters/*.txt` holds the source filter lists, and `rules/` holds the generated rulesets and per-list cosmetic files.
- `content/` holds the cosmetic loader, click reporter, element picker, strict pop-up and YouTube scripts.
- `tools/cdp.mjs` is the headless-Chrome harness shared by the smoke, real-site and store-asset scripts.
- `popup/` and `options/` hold the UI.

## License

Mizpah is licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE).

Copyright (c) 2026 Stephen Hazra. As the copyright holder, I permit distribution of Mizpah through the Apple App Store. Outside contributions are accepted only with a Developer Certificate of Origin sign-off (`git commit -s`) that also agrees to this App Store distribution.

The bundled rules are converted from EasyList, EasyPrivacy and Fanboy's Annoyance list. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for their authors and licenses.
