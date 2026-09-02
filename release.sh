#!/bin/bash
# Build a notarized, directly-distributable Closiq Sync.dmg.
#
#   ./release.sh                 build, sign, notarize, staple, verify
#   VERSION=1.1 ./release.sh
#   SKIP_NOTARIZE=1 ./release.sh  local smoke test only, produces an unusable dmg
#
# This is the THIRD signing path in this repo and it shares nothing with the
# other two:
#
#   sign-local.sh   Apple Development, hand-signed, for the dev loop
#   archive.sh      Apple Distribution + Mac App Store profiles, for the store
#   release.sh      Developer ID Application + notarization, for direct download
#
# Developer ID builds take NO provisioning profile. The project pins App Store
# profiles per target, so those settings are overridden on the command line
# here, where they apply to every target at once.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="ClosiqSync"
DISPLAY_NAME="Closiq Sync"
TEAM_ID="QFJW3NFT2M"
BUNDLE_ID="com.closiq.ClosiqSync"

VERSION="${VERSION:-1.0}"
BUILD="${BUILD:-$(date +%s)}"

ARCHIVE="$ROOT/build/$APP_NAME-devid.xcarchive"
EXPORT_DIR="$ROOT/build/release"
DMG="$ROOT/build/release/$APP_NAME-$VERSION.dmg"
PROJECT="$ROOT/build/$APP_NAME/$APP_NAME.xcodeproj"

IDENTITY="Developer ID Application"

if ! security find-identity -v -p codesigning | grep -q "$IDENTITY"; then
  cat <<MSG
No "$IDENTITY" certificate in the keychain.

It cannot be created over the API: /v1/certificates answers 403 "This operation
can only be performed by the Account Holder", and App Store Connect API keys
cannot hold that role. Create it by hand, once:

  Xcode > Settings > Accounts > Closiq Inc. > Manage Certificates > + >
  Developer ID Application

The cap is 5 certificates per account, not 5 apps, and one cert signs every app
for its full five-year life.
MSG
  exit 1
fi

"$ROOT/scripts/check-manifest.py"
"$ROOT/build.sh" >/dev/null
echo "== archiving $DISPLAY_NAME $VERSION ($BUILD) for Developer ID =="

\rm -rf "$ARCHIVE" "$EXPORT_DIR"

xcodebuild -project "$PROJECT" -scheme "$APP_NAME" \
  -configuration Release \
  -destination 'generic/platform=macOS' \
  -archivePath "$ARCHIVE" \
  MARKETING_VERSION="$VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="$IDENTITY" \
  PROVISIONING_PROFILE_SPECIFIER="" \
  archive 2>&1 | grep -iE "error:|ARCHIVE (SUCCEEDED|FAILED)" || true

[ -d "$ARCHIVE" ] || { echo "archive failed"; exit 1; }

cat > "$ROOT/build/ExportOptions-devid.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>developer-id</string>
	<key>teamID</key>
	<string>$TEAM_ID</string>
	<key>signingStyle</key>
	<string>manual</string>
	<key>signingCertificate</key>
	<string>$IDENTITY</string>
	<!-- Export only. "upload" would hand the archive to the notary service and
	     return before we can build the dmg users actually download. -->
	<key>destination</key>
	<string>export</string>
</dict>
</plist>
PLIST

echo "== exporting =="
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$ROOT/build/ExportOptions-devid.plist" \
  -exportPath "$EXPORT_DIR" 2>&1 | grep -iE "error:|Exported|EXPORT (SUCCEEDED|FAILED)" || true

APP="$EXPORT_DIR/$APP_NAME.app"
[ -d "$APP" ] || { echo "no exported app; see output above"; exit 1; }

echo "== checks that decide whether notarization can succeed =="
# Capture first, match second. Piping into `grep -q` under `set -o pipefail` is
# a trap: grep exits on the first match, codesign takes SIGPIPE and reports
# non-zero, and the pipeline "fails" precisely when the thing being looked for
# was FOUND. That inverts every check written this way, and for a check phrased
# as "fail if present" it inverts silently in the unsafe direction.
SIGINFO="$(codesign -d --verbose=2 "$APP" 2>&1 || true)"
ENTS="$(codesign -d --entitlements - --xml "$APP" 2>/dev/null || true)"

case "$SIGINFO" in
  *"(runtime)"*) echo "  ok   hardened runtime" ;;
  *) echo "  FAIL hardened runtime missing; notarization will reject this"; exit 1 ;;
esac

case "$ENTS" in
  *get-task-allow*)
    echo "  FAIL get-task-allow present; notarization will reject this"; exit 1 ;;
  *) echo "  ok   no debug entitlement" ;;
esac
codesign -dvv "$APP" 2>&1 | grep -E "^(Identifier|Authority|TeamIdentifier)" | sed 's/^/  /'

echo "== building dmg =="
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/$DISPLAY_NAME.app"
# A symlink to /Applications is the whole install UX: open, drag, done.
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "$DISPLAY_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
echo "  $DMG"

# The dmg is signed too, so Gatekeeper trusts the container as well as the app.
codesign --force --sign "$IDENTITY" --timestamp "$DMG"

if [ "${SKIP_NOTARIZE:-0}" = "1" ]; then
  echo "SKIP_NOTARIZE set. This dmg will be blocked by Gatekeeper; do not ship it."
  exit 0
fi

echo "== notarizing (this waits on Apple, typically a few minutes) =="
# shellcheck disable=SC1090
source ~/.config/appstore/env
xcrun notarytool submit "$DMG" \
  --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" \
  --wait 2>&1 | tee "$ROOT/build/notarize.log"

if ! grep -q "status: Accepted" "$ROOT/build/notarize.log"; then
  echo
  echo "Notarization did not succeed. Get the reasons with:"
  ID=$(grep -m1 -oE '\bid: [0-9a-f-]{36}' "$ROOT/build/notarize.log" | head -1 | awk '{print $2}')
  echo "  xcrun notarytool log $ID --key \"\$ASC_KEY_PATH\" --key-id \"\$ASC_KEY_ID\" --issuer \"\$ASC_ISSUER_ID\""
  exit 1
fi

echo "== stapling =="
# Staples the ticket into the dmg so it validates with no network on first run.
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"

echo "== final verification =="
spctl --assess --type open --context context:primary-signature -vv "$DMG" 2>&1 | sed 's/^/  /'

echo
echo "Ready: $DMG"
echo "Size:  $(du -h "$DMG" | cut -f1)"
echo "Attach it to the GitHub release, then point the download page at that URL."
