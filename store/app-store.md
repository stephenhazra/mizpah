# App Store listing

One app record covers iPhone, iPad and Mac. In App Store Connect, create a new app with platforms iOS and macOS, bundle ID `io.github.stephenhazra.mizpah`, and SKU `mizpah`.

## App information

**Name** (30 max)

Mizpah Ad Blocker

**Subtitle** (30 max)

Block ads, trackers & pop-ups

**Primary category:** Utilities

**Secondary category:** Productivity

**Content rights:** The app does not contain, show or access third-party content.

**Age rating:** answer "None" or "No" to every question. The result is 4+.

## Pricing and availability

**Price:** Free

**Availability:** All countries and regions

## Version 1.0.0

**Promotional text** (170 max)

Ads, trackers, pop-ups and cookie banners, blocked in Safari. Built on EasyList with daily filter updates. No data collected.

**Description** (4000 max)

Mizpah (Hebrew for "watchtower") blocks ads, trackers, pop-ups and cookie banners in Safari, using the same filter lists trusted by the major ad blockers.

WHAT IT BLOCKS
• Ads: banner, video, sticky and native ads
• Trackers: analytics, tracking pixels and fingerprinting scripts
• Pop-ups: pop-up and pop-under ad tabs, closed the moment they open
• Annoyances: cookie banners, newsletter pop-ups and social widgets

HOW IT WORKS
• Built on Safari's native content blocking, so pages load faster
• Over 110,000 network rules from EasyList, EasyPrivacy and Fanboy's Annoyance list
• Filter lists update automatically every day
• Element hiding removes leftover ad boxes

YOU STAY IN CONTROL
• Turn blocking off for any site in one tap
• Hide anything on a page with the element picker
• Block every pop-up on a site with strict pop-up mode
• Add your own filters in Adblock Plus or uBlock Origin syntax
• Turn each filter list on or off

PRIVATE BY DESIGN
Mizpah collects no data. No accounts, no analytics, no tracking. Everything runs on your device.

TURN IT ON
iPhone and iPad: Settings › Apps › Safari › Extensions › Mizpah Ad Blocker. Turn on Allow Extension and set All Websites to Allow.
Mac: Safari › Settings › Extensions. Tick Mizpah Ad Blocker, then set Other Websites to Allow.

**Keywords** (100 max, comma-separated)

adblock,ad blocker,content blocker,privacy,tracker,popup,safari,easylist,cookie,block ads

**Support URL:** https://github.com/stephenhazra/mizpah/issues

**Marketing URL:** https://stephenhazra.github.io/mizpah/

**Privacy policy URL:** https://stephenhazra.github.io/mizpah/privacy-policy.html

**Copyright:** 2026 Stephen Hazra

**What's New:** leave empty for the first version.

## App Privacy

Choose **Data Not Collected**. Mizpah collects no data, and nothing is sent anywhere except plain downloads of the public filter lists.

## App Review information

**Sign-in required:** No

**Notes for the reviewer**

Mizpah is a Safari Web Extension. The app itself only explains how to turn the extension on.

To test on iPhone or iPad: open Settings › Apps › Safari › Extensions › Mizpah Ad Blocker, turn on Allow Extension and set All Websites to Allow. Then open any ad-supported site in Safari, for example https://www.forbes.com. Tap the puzzle-piece icon in the address bar and choose Mizpah Ad Blocker to see the controls.

To test on Mac: open Safari › Settings › Extensions, tick Mizpah Ad Blocker, click Edit Websites and set Other Websites to Allow. Then visit an ad-supported site and click the Mizpah button in the toolbar.

The extension downloads public filter lists from easylist.to and secure.fanboy.co.nz once a day. These are data files, not code. The source code is at https://github.com/stephenhazra/mizpah.

## Screenshots

Upload from `store/apple/`:

| Device slot | Files |
| --- | --- |
| iPhone with Dynamic Island (medium display) | iphone-1.jpg, iphone-2.png, iphone-3.png |
| iPad 13" display | ipad-1.jpg, ipad-2.png, ipad-3.png |
| Mac | mac-1.png, mac-2.png, mac-3.png |

## Build and upload

1. Accept any pending agreements at https://developer.apple.com/account and in App Store Connect under Business.
2. Run `tools/safari.sh` to regenerate the Xcode project with the App Store settings.
3. Open `platforms/Mizpah/Mizpah.xcodeproj` in Xcode and choose your team under Signing & Capabilities for all four targets.
4. Choose the **Mizpah (iOS)** scheme with **Any iOS Device**, then Product › Archive. In the Organizer, click Distribute App › App Store Connect.
5. Repeat with the **Mizpah (macOS)** scheme and **Any Mac**.
6. In App Store Connect, attach both builds to version 1.0.0, add the screenshots, and submit for review.

For later versions, raise `version` in `manifest.json` and set a higher build number, for example `BUILD_NUMBER=2 tools/safari.sh`.
