#!/bin/bash
# Build, sign and install ClosiqSync.app for LOCAL development.
#
# Safari silently refuses to LIST an extension whose container app is not signed
# by an Apple-issued certificate. An ad-hoc ("Sign to Run Locally") build runs
# fine and simply never appears in Safari Settings, which is a confusing way to
# lose an afternoon. So: build ad-hoc, then hand-sign inside-out with a real
# Apple Development cert. That is what makes the install persist instead of
# needing "Allow unsigned extensions" re-ticked after every Safari quit.
#
# This is the DEV path. The App Store build is archive.sh, which uses the
# Closiq distribution identity and Xcode's normal signing.
#
# Usage: ./sign-local.sh [/path/to/ClosiqSync.app]
set -euo pipefail

IDENTITY="${CLOSIQSYNC_SIGN_IDENTITY:-Apple Development: erwinzhang7@gmail.com}"
APP_NAME="ClosiqSync"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

APP="${1:-}"
if [ -z "$APP" ]; then
  [ -d "$ROOT/build/$APP_NAME/$APP_NAME.xcodeproj" ] || "$ROOT/build.sh"
  echo "== building Release =="
  # Release rather than Debug avoids the .debug.dylib / __preview.dylib splits.
  # Ad-hoc here is only an intermediate; the real signature is applied below.
  # Capture the status rather than piping straight to grep: a pipeline's exit
  # code is the LAST command's, so a failed build would otherwise sail past and
  # this script would happily sign whatever stale binary was left in
  # DerivedData from a previous run. That is a genuinely confusing way to
  # "successfully" install a broken app.
  BUILD_LOG="$TMP/xcodebuild.log"
  set +e
  xcodebuild -project "$ROOT/build/$APP_NAME/$APP_NAME.xcodeproj" -scheme "$APP_NAME" \
    -configuration Release -destination 'platform=macOS' \
    CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="-" DEVELOPMENT_TEAM="" build >"$BUILD_LOG" 2>&1
  BUILD_STATUS=$?
  set -e
  grep -iE "error:|BUILD (SUCCEEDED|FAILED)" "$BUILD_LOG" || true
  if [ $BUILD_STATUS -ne 0 ]; then
    echo
    echo "build failed; not signing. Full log:"
    tail -40 "$BUILD_LOG"
    exit 1
  fi
  APP=$(find ~/Library/Developer/Xcode/DerivedData -maxdepth 6 -name "$APP_NAME.app" \
        -path "*Build/Products/Release*" -not -path "*Index.noindex*" 2>/dev/null | head -1 || true)
fi
[ -d "$APP" ] || { echo "no $APP_NAME.app found"; exit 1; }

echo "signing:  $APP"
echo "identity: $IDENTITY"

# Preserve whatever entitlements the build produced (App Sandbox et al).
# Re-signing without --entitlements would silently strip them.
sign() {
  # Separate `local` statements on purpose: a single one expands $path before
  # assigning it.
  local path="$1"
  local ents="$TMP/$(basename "$path" | tr -d ' ').plist"
  if codesign -d --entitlements - --xml "$path" 2>/dev/null >"$ents" && [ -s "$ents" ]; then
    codesign -f -s "$IDENTITY" --entitlements "$ents" --timestamp=none "$path"
  else
    codesign -f -s "$IDENTITY" --timestamp=none "$path"
  fi
  echo "  ok $(basename "$path")"
}

echo "== 1. nested code (deepest first) =="
find "$APP" \( -name "*.dylib" -o -name "*.framework" \) -print0 2>/dev/null |
  while IFS= read -r -d '' f; do sign "$f"; done

echo "== 2. the extension =="
sign "$APP/Contents/PlugIns/$APP_NAME Extension.appex"

echo "== 3. the container app =="
sign "$APP"

echo "== verify =="
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | tail -3
codesign -dvv "$APP" 2>&1 | grep -E "^(Identifier|Authority|TeamIdentifier)" || true

if [ "${INSTALL:-1}" = "1" ]; then
  echo
  echo "== install to /Applications =="
  LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  \rm -rf "/Applications/$APP_NAME.app"
  cp -R "$APP" /Applications/
  # Two copies now exist. Safari binds to whichever LaunchServices resolves
  # first, and that is often the DerivedData one, which gets wiped by Clean
  # Build Folder and takes the extension registration with it. Unregister it so
  # only /Applications is live.
  "$LSREGISTER" -u "$APP" 2>/dev/null || true
  "$LSREGISTER" -f "/Applications/$APP_NAME.app"
  open "/Applications/$APP_NAME.app"
  echo "  installed and registered: /Applications/$APP_NAME.app"
  echo
  echo "One time only, in Safari:"
  echo "  1. Settings > Extensions > tick ClosiqSync"
  echo "  2. Toolbar button > Always Allow on Every Website"
  echo "  3. Reload any tabs that were already open"
  echo
  echo "NB: re-running this changes the cdhash, which makes Safari disable the"
  echo "    extension. Re-tick it; the host-access grant survives."
fi
