#!/bin/sh
set -e
cd "$(dirname "$0")/.."
node tools/package.mjs --target=safari "$@"
xcrun safari-web-extension-converter dist/safari \
  --project-location platforms \
  --app-name Mizpah \
  --bundle-identifier io.github.stephenhazra.mizpah \
  --swift --copy-resources --no-open --no-prompt --force
echo "Open platforms/Mizpah/Mizpah.xcodeproj in Xcode, choose your team under Signing, then build the macOS and iOS schemes."
