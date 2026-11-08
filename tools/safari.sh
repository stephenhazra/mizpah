#!/bin/sh
set -e
cd "$(dirname "$0")/.."
for tool in node python3 xcrun zip unzip diff; do
  command -v "$tool" >/dev/null || { echo "$tool is required but not installed" >&2; exit 1; }
done
RES="platforms/Mizpah/Shared (Extension)/Resources"
if [ "$1" = "--check" ]; then
  shift
  node tools/package.mjs --target=safari "$@"
  diff -rq dist/safari "$RES" && echo "Xcode copy matches dist/safari"
  exit
fi
NAME=$(node -p 'require("./tools/release.config.json").apple.appName')
BUNDLE=$(node -p 'require("./tools/release.config.json").apple.bundleId')
BUILD_NUMBER=${BUILD_NUMBER:-$(date -u +%y%m%d%H%M)}
export BUILD_NUMBER
node tools/package.mjs --target=safari "$@"
xcrun safari-web-extension-converter dist/safari \
  --project-location platforms \
  --app-name "$NAME" \
  --bundle-identifier "$BUNDLE" \
  --swift --copy-resources --no-open --no-prompt --force
python3 tools/apple-setup.py
node tools/leak-check.mjs platforms
echo "Open platforms/$NAME/$NAME.xcodeproj in Xcode, choose your team under Signing, then use Product > Archive for each scheme. Do not commit DEVELOPMENT_TEAM changes."
