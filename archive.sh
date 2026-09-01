#!/bin/bash
# Build a Mac App Store archive and export a signed .pkg.
#
#   ./archive.sh                 build and export to build/export/
#   UPLOAD=1 ./archive.sh        also upload to App Store Connect
#   VERSION=1.1 BUILD=4 ./archive.sh
#
# This is the DISTRIBUTION path. sign-local.sh is the development one, and the
# two do not share signing: local dev uses the Apple Development cert with
# hand-signing, this uses the Closiq distribution identity and the Mac App Store
# provisioning profiles that scripts/patch-project.py wires into the project.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Watchalong"
TEAM_ID="QFJW3NFT2M"
APP_ID="com.closiq.Watchalong"
EXT_ID="com.closiq.Watchalong.Extension"

VERSION="${VERSION:-1.0}"
# A build number must be unique per version in App Store Connect and must only
# ever increase. Seconds-since-epoch is monotonic and needs no state file.
BUILD="${BUILD:-$(date +%s)}"

ARCHIVE="$ROOT/build/$APP_NAME.xcarchive"
EXPORT_DIR="$ROOT/build/export"
PROJECT="$ROOT/build/$APP_NAME/$APP_NAME.xcodeproj"

# Always regenerate: the archive must be built from the tracked sources plus the
# project patches, never from whatever happens to be sitting in build/.
"$ROOT/build.sh" >/dev/null
echo "== archiving $APP_NAME $VERSION ($BUILD) =="

\rm -rf "$ARCHIVE" "$EXPORT_DIR"

xcodebuild -project "$PROJECT" -scheme "$APP_NAME" \
  -configuration Release \
  -destination 'generic/platform=macOS' \
  -archivePath "$ARCHIVE" \
  MARKETING_VERSION="$VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD" \
  archive 2>&1 | grep -iE "error:|warning: (no|the)|ARCHIVE (SUCCEEDED|FAILED)" || true

[ -d "$ARCHIVE" ] || { echo "archive failed"; exit 1; }

# The App Store wants a .pkg signed with the installer certificate, which
# exportArchive produces from installerSigningCertificate.
cat > "$ROOT/build/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>teamID</key>
	<string>$TEAM_ID</string>
	<key>signingStyle</key>
	<string>manual</string>
	<key>installerSigningCertificate</key>
	<string>3rd Party Mac Developer Installer</string>
	<key>provisioningProfiles</key>
	<dict>
		<key>$APP_ID</key>
		<string>Watchalong Mac App Store</string>
		<key>$EXT_ID</key>
		<string>Watchalong Extension Mac App Store</string>
	</dict>
	<key>destination</key>
	<string>export</string>
</dict>
</plist>
PLIST

echo "== exporting =="
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$ROOT/build/ExportOptions.plist" \
  -exportPath "$EXPORT_DIR" 2>&1 | grep -iE "error:|Exported|EXPORT (SUCCEEDED|FAILED)" || true

PKG=$(find "$EXPORT_DIR" -name "*.pkg" | head -1)
[ -n "$PKG" ] || { echo "no .pkg produced; see output above"; exit 1; }
echo "package: $PKG"

echo "== verifying the archived app =="
APP="$ARCHIVE/Products/Applications/$APP_NAME.app"
codesign -dvv "$APP" 2>&1 | grep -E "^(Identifier|Authority|TeamIdentifier)" || true
echo "-- sandbox entitlement (mandatory for the store) --"
codesign -d --entitlements - --xml "$APP" 2>/dev/null |
  plutil -convert xml1 -o - - 2>/dev/null | grep -A1 app-sandbox || echo "  MISSING -- upload will be rejected"
echo "-- extension --"
codesign -d --entitlements - --xml "$APP/Contents/PlugIns/$APP_NAME Extension.appex" 2>/dev/null |
  plutil -convert xml1 -o - - 2>/dev/null | grep -A1 app-sandbox || echo "  MISSING"

if [ "${UPLOAD:-0}" = "1" ]; then
  # Credentials live in the same place asc reads them from, sourced rather than
  # baked in, so nothing secret lands in this file or in shell history.
  # shellcheck disable=SC1090
  source ~/.config/appstore/env
  echo "== uploading =="
  xcrun altool --upload-app -f "$PKG" -t macos \
    --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" 2>&1 | tail -20
else
  echo
  echo "Not uploaded. To upload:  UPLOAD=1 ./archive.sh"
  echo "An app record for $APP_ID must exist in App Store Connect first."
fi
