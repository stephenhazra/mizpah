#!/bin/sh
set -e
cd "$(dirname "$0")/.."
TEAM=${APPLE_TEAM_ID:-$(cat platforms/team.local 2>/dev/null || true)}
[ -n "$TEAM" ] || { echo "Set APPLE_TEAM_ID or put your team ID in platforms/team.local (gitignored)" >&2; exit 1; }
NAME=$(node -p 'require("./tools/release.config.json").apple.appName')
OUT=dist/apple
mkdir -p "$OUT"
for platform in iOS macOS; do
  [ "$platform" = iOS ] && dest="generic/platform=iOS" || dest="generic/platform=macOS"
  xcodebuild archive -project "platforms/$NAME/$NAME.xcodeproj" -scheme "$NAME ($platform)" \
    -destination "$dest" -archivePath "$OUT/$NAME-$platform.xcarchive" \
    -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic
done
echo "Archives are in $OUT. Upload them with Xcode Organizer or xcrun altool."
