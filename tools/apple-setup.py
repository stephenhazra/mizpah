import datetime, json, os, re, shutil, sys

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
proj = os.path.join(root, "platforms", "Mizpah")
src = os.path.join(root, "platforms", "apple")
with open(os.path.join(root, "tools", "release.config.json")) as f:
    apple = json.load(f)["apple"]
with open(os.path.join(root, "manifest.json")) as f:
    version = json.load(f)["version"]
build = os.environ.get("BUILD_NUMBER") or datetime.datetime.now(datetime.timezone.utc).strftime("%y%m%d%H%M")

if not re.fullmatch(r"\d+(\.\d+){0,2}", version):
    sys.exit(f"version {version} must be up to three dot-separated integers")
if not re.fullmatch(r"\d+(\.\d+){0,2}", build):
    sys.exit(f"BUILD_NUMBER {build} must be up to three dot-separated integers")

year = datetime.date.today().year
first = apple["firstReleaseYear"]
years = str(first) if year <= first else f"{first}-{year}"
copyright = f"© {years} {apple['copyrightHolder']}"

PRIVACY = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyTracking</key>
	<false/>
	<key>NSPrivacyTrackingDomains</key>
	<array/>
	<key>NSPrivacyCollectedDataTypes</key>
	<array/>
	<key>NSPrivacyAccessedAPITypes</key>
	<array/>
</dict>
</plist>
"""

HANDLER = """import SafariServices

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: nil, completionHandler: nil)
    }

}
"""

app_res = os.path.join(proj, "Shared (App)", "Resources")
shutil.copy(os.path.join(src, "Main.html"), os.path.join(app_res, "Base.lproj", "Main.html"))
for name in ("Style.css", "Script.js"):
    shutil.copy(os.path.join(src, name), os.path.join(app_res, name))
shutil.copy(os.path.join(src, "AppIcon", "mac-icon-128@2x.png"), os.path.join(app_res, "Icon.png"))

icons = os.path.join(proj, "Shared (App)", "Assets.xcassets", "AppIcon.appiconset")
for name in os.listdir(os.path.join(src, "AppIcon")):
    shutil.copy(os.path.join(src, "AppIcon", name), os.path.join(icons, name))
large = os.path.join(proj, "Shared (App)", "Assets.xcassets", "LargeIcon.imageset")
for name in os.listdir(large):
    if name.endswith(".png"):
        shutil.copy(os.path.join(src, "AppIcon", "mac-icon-128@2x.png"), os.path.join(large, name))

for folder in ("Shared (App)", "Shared (Extension)"):
    with open(os.path.join(proj, folder, "PrivacyInfo.xcprivacy"), "w") as f:
        f.write(PRIVACY)
with open(os.path.join(proj, "Shared (Extension)", "SafariWebExtensionHandler.swift"), "w") as f:
    f.write(HANDLER)

pbx = os.path.join(proj, "Mizpah.xcodeproj", "project.xcproj")
with open(pbx) as f:
    s = f.read()


def sub(pattern, repl, minimum, expected=None):
    global s
    s, n = re.subn(pattern, repl, s)
    if n < minimum or (expected is not None and n != expected):
        sys.exit(f"{pattern} replaced {n} times, expected {expected or minimum}")


def add_membership(before, name, targets):
    global s
    if re.search(rf'"path": "{re.escape(name)}",[^}}]*\}}, \{{\s*"path": "{re.escape(before)}"', s):
        return
    entry = (
        f'"path": "{name}",\n          "target-membership": [\n'
        + "".join(f'            "{t}/resources",\n' for t in targets)
        + "          ],\n        }, {\n          "
    )
    s, n = re.subn(rf'(\}}, \{{\n\s*)("path": "{re.escape(before)}",)', lambda m: m.group(1) + entry + m.group(2), s)
    if n != 1:
        sys.exit(f"could not add {name} to the project")


sub(r'"IPHONEOS_DEPLOYMENT_TARGET": "[\d.]+"', f'"IPHONEOS_DEPLOYMENT_TARGET": "{apple["iosDeployment"]}"', 1)
sub(r'"MACOSX_DEPLOYMENT_TARGET": "[\d.]+"', f'"MACOSX_DEPLOYMENT_TARGET": "{apple["macosDeployment"]}"', 1)
sub(r'"MARKETING_VERSION": "[^"]*"', f'"MARKETING_VERSION": "{version}"', 4, 4)
sub(r'"CURRENT_PROJECT_VERSION": "[^"]*"', f'"CURRENT_PROJECT_VERSION": "{build}"', 4, 4)
sub(r'\n\s*"ENABLE_USER_SELECTED_FILES": "[^"]*",', "", 0)
sub(r'\n\s*"ENABLE_OUTGOING_NETWORK_CONNECTIONS": "[^"]*",', "", 0)
sub(r'\n\s*"INFOPLIST_KEY_(ITSAppUsesNonExemptEncryption|LSApplicationCategoryType|NSHumanReadableCopyright)": "[^"]*",', "", 0)


def add_keys(m):
    indent = m.group(1)
    extra = [
        '"INFOPLIST_KEY_ITSAppUsesNonExemptEncryption": "NO",',
        '"INFOPLIST_KEY_LSApplicationCategoryType": "public.app-category.utilities",',
        f'"INFOPLIST_KEY_NSHumanReadableCopyright": "{copyright}",',
    ]
    return m.group(0) + "".join(f"\n{indent}{line}" for line in extra)


s, n = re.subn(rf'\n(\s*)"INFOPLIST_KEY_CFBundleDisplayName": "{re.escape(apple["appName"])}",', add_keys, s)
if n != 2:
    sys.exit(f"expected 2 app targets, patched {n}")

add_membership("Assets.xcassets", "PrivacyInfo.xcprivacy", ["Mizpah (iOS)", "Mizpah (macOS)"])
add_membership("SafariWebExtensionHandler.swift", "PrivacyInfo.xcprivacy", ["Mizpah Extension (iOS)", "Mizpah Extension (macOS)"])

with open(pbx, "w") as f:
    f.write(s)

final_version = set(re.findall(r'"MARKETING_VERSION": "([^"]*)"', s))
final_build = set(re.findall(r'"CURRENT_PROJECT_VERSION": "([^"]*)"', s))
print(f"Apple project set to version {', '.join(final_version)} (build {', '.join(final_build)}), iOS {apple['iosDeployment']}, macOS {apple['macosDeployment']}")
