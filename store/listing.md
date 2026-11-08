# Chrome Web Store listing

Paste these into the Developer Dashboard.

## Store listing tab

**Category:** Privacy & Security

**Language:** English

**Summary** (from manifest, 109 of 132 characters)

Blocks ads, trackers, pop-ups and cookie banners. Fast, private, built on EasyList with daily filter updates.

**Description**

Mizpah (Hebrew for "watchtower") blocks ads, trackers, pop-ups and cookie banners on every site, using the same public filter lists that other ad blockers use.

WHAT IT BLOCKS
• Ads: banner, video, sticky and native ads, including YouTube ads
• Trackers: analytics, tracking pixels and fingerprinting scripts
• Pop-ups: pop-up and pop-under ad tabs, closed the moment they open
• Annoyances: cookie banners, newsletter pop-ups and social widgets

HOW IT WORKS
• Built on Chrome's modern blocking engine, so pages load faster and nothing slows your browser down
• Over 110,000 network rules from EasyList, EasyPrivacy and Fanboy's Annoyance list
• Filter lists update automatically every day
• Element hiding removes leftover ad boxes without breaking page layouts

YOU STAY IN CONTROL
• Turn blocking off for any site in one click
• Hide anything on a page with the element picker
• Block every pop-up on a site with strict pop-up mode
• Add your own filters in Adblock Plus or uBlock Origin syntax
• Turn each filter list on or off
• Export and import your settings

PRIVATE BY DESIGN
Mizpah collects no data. No analytics, no accounts, no tracking. Everything runs on your device: your settings, the sites learned from pop-ups it closed and the blocked counts stay there, and Settings › Clear learned data removes them.

## Privacy practices tab

**Single purpose**

Mizpah blocks advertisements, trackers, pop-ups and page annoyances while the user browses the web.

**Permission justifications**

declarativeNetRequest: Blocks requests to ad and tracker servers using built-in filter rules.

declarativeNetRequestFeedback: Shows the number of requests blocked on the current page in the toolbar popup.

storage: Saves the user's settings, trusted sites and custom filters on the device.

unlimitedStorage: Stores the daily-updated filter lists, which are larger than the default storage quota.

scripting: Injects the styles that hide ad elements, and the element picker the user starts from the popup.

webNavigation: Detects when a page opens a new tab, so pop-up ad tabs can be identified.

webRequest: Observes the redirects a newly opened tab follows, which webNavigation does not report, so pop-up ad tabs that bounce through ad servers can be closed. It does not modify or block requests.

alarms: Schedules the daily filter-list update.

Host permission (all sites): Ads and trackers appear on every site, so filtering must work wherever the user browses.

**Remote code:** No, I am not using remote code. (The extension downloads filter lists, which are data, not code.)

**Data usage:** Check none of the data types. Then tick all three certifications:
• I do not sell or transfer user data to third parties, outside of the approved use cases
• I do not use or transfer user data for purposes that are unrelated to my item's single purpose
• I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://stephenhazra.github.io/mizpah/privacy-policy.html

**Homepage URL:** https://stephenhazra.github.io/mizpah/

**Support URL:** https://github.com/stephenhazra/mizpah/issues

**Notes for certification (Microsoft Edge Add-ons)**

Mizpah ships its filter rules as static declarativeNetRequest rulesets inside the package. Filter lists change every day and static rulesets can't be replaced after install, so once a day Mizpah downloads the public EasyList, EasyPrivacy and Fanboy's Annoyance lists and converts new entries into dynamic declarativeNetRequest rules, and disables shipped rules the lists have removed. The downloads are declarative data, not code, and are checked for format and size before use. Users can turn the daily update off in Settings. Source: https://github.com/stephenhazra/mizpah.

**Notes to reviewer (Firefox Add-ons)**

The source is not minified. To reproduce the package: install Node.js 20 or later, run `node tools/build-rules.mjs --remote` and then `node tools/package.mjs --target=firefox`. The xpi is written to `dist/`. The filter rules in `rules/` are generated from the public lists named above.

## Images

Upload these from the store folder:
• Store icon: icons/icon128.png
• Screenshots (1280×800): screenshot-1.png, screenshot-2.png, screenshot-3.png
• Small promo tile (440×280): promo-small.png
• Marquee promo tile (1400×560): promo-marquee.png
