#!/bin/sh
set -e
cd "$(dirname "$0")/.."
node tools/package.mjs --target=safari "$@"
xcrun safari-web-extension-converter dist/safari \
  --project-location platforms \
  --app-name Mizpah \
  --bundle-identifier io.github.stephenhazra.mizpah \
  --swift --copy-resources --no-open --no-prompt --force
python3 tools/apple-setup.py
echo "Open platforms/Mizpah/Mizpah.xcodeproj in Xcode, choose your team under Signing, then use Product > Archive for each scheme."
