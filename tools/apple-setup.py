import json, os, re, shutil, sys

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
proj = os.path.join(root, "platforms", "Mizpah")
src = os.path.join(root, "platforms", "apple")
build = os.environ.get("BUILD_NUMBER", "1")
version = json.load(open(os.path.join(root, "manifest.json")))["version"]

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

pbx = os.path.join(proj, "Mizpah.xcodeproj", "project.xcproj")
s = open(pbx).read()
s = re.sub(r'"IPHONEOS_DEPLOYMENT_TARGET": "[\d.]+"', '"IPHONEOS_DEPLOYMENT_TARGET": "17.0"', s)
s = re.sub(r'"MACOSX_DEPLOYMENT_TARGET": "[\d.]+"', '"MACOSX_DEPLOYMENT_TARGET": "14.0"', s)
s = re.sub(r'"MARKETING_VERSION": "[^"]*"', f'"MARKETING_VERSION": "{version}"', s)
s = re.sub(r'"CURRENT_PROJECT_VERSION": "[^"]*"', f'"CURRENT_PROJECT_VERSION": "{build}"', s)
s = re.sub(r'\n\s*"ENABLE_USER_SELECTED_FILES": "[^"]*",', "", s)
s = re.sub(r'\n\s*"ENABLE_OUTGOING_NETWORK_CONNECTIONS": "[^"]*",', "", s)
s = re.sub(r'\n\s*"INFOPLIST_KEY_(ITSAppUsesNonExemptEncryption|LSApplicationCategoryType|NSHumanReadableCopyright)": "[^"]*",', "", s)


def add_keys(m):
    indent = m.group(1)
    extra = [
        '"INFOPLIST_KEY_ITSAppUsesNonExemptEncryption": "NO",',
        '"INFOPLIST_KEY_LSApplicationCategoryType": "public.app-category.utilities",',
        '"INFOPLIST_KEY_NSHumanReadableCopyright": "© 2026 Stephen Hazra",',
    ]
    return m.group(0) + "".join(f"\n{indent}{line}" for line in extra)


s, n = re.subn(r'\n(\s*)"INFOPLIST_KEY_CFBundleDisplayName": "Mizpah",', add_keys, s)
if n != 2:
    sys.exit(f"expected 2 app targets, patched {n}")
open(pbx, "w").write(s)
print(f"Apple project set to version {version} ({build}), iOS 17.0, macOS 14.0")
