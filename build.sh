#!/bin/bash
# Generate (or regenerate) the Xcode project that wraps the extension.
#
# --copy-resources is deliberately OMITTED: without it the project REFERENCES
# extension/ instead of snapshotting it, so editing the JS and hitting Cmd-B in
# Xcode is the whole edit loop. Pass --snapshot to freeze a copy instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Insync"
# Capital I is load-bearing. The packager derives the APP's identifier from
# --app-name but the EXTENSION's from --bundle-identifier, and Xcode's
# "embedded binary's bundle identifier is not prefixed with the parent app's"
# check is case-SENSITIVE. `app.closiq.insync` against an app named `Insync`
# fails the build with exactly that message.
BUNDLE_ID="app.closiq.Insync"

EXTRA=()
[[ "${1:-}" == "--snapshot" ]] && EXTRA=(--copy-resources)

# Apple renamed the tool to safari-web-extension-packager; the old name still
# works as an alias, so prefer the new one and fall back for older Xcode.
TOOL=safari-web-extension-packager
xcrun -f "$TOOL" >/dev/null 2>&1 || TOOL=safari-web-extension-converter

xcrun "$TOOL" "$ROOT/extension" \
  --project-location "$ROOT/build" \
  --app-name "$APP_NAME" \
  `# Case must match --app-name exactly: the packager derives the APP id from` \
  `# the app name but the EXTENSION id from this flag, and the embedded-binary` \
  `# prefix check is case-sensitive.` \
  --bundle-identifier "$BUNDLE_ID" \
  --swift \
  --macos-only \
  --no-open \
  --no-prompt \
  --force \
  ${EXTRA[@]+"${EXTRA[@]}"}

# --------------------------------------------------------------- overrides
#
# The packager regenerates build/ wholesale, so nothing in there can be edited
# by hand and kept. Everything we want to survive lives in tracked directories
# and is copied over the generated output here.

GEN="$ROOT/build/$APP_NAME/$APP_NAME"

# The container app's UI. Apple's stock page is a single sentence about turning
# the extension on, which is exactly the "empty container app" shape that App
# Store review pushes back on. Ours explains setup, use and what is transmitted.
cp "$ROOT/app/ViewController.swift" "$GEN/ViewController.swift"
cp "$ROOT/app/Main.html" "$GEN/Resources/Base.lproj/Main.html"
cp "$ROOT/app/Style.css" "$GEN/Resources/Style.css"
cp "$ROOT/app/Script.js" "$GEN/Resources/Script.js"
cp "$ROOT/extension/images/icon-256.png" "$GEN/Resources/Icon.png"

# App icon. The packager ships a generic placeholder; map our renders onto the
# asset catalogue's expected @1x/@2x pairs.
ICONS="$GEN/Assets.xcassets/AppIcon.appiconset"
copy_icon() { # source-size  target-filename
  [ -f "$ICONS/$2" ] && cp "$ROOT/extension/images/icon-$1.png" "$ICONS/$2"
}
copy_icon 16 "mac-icon-16@1x.png"
copy_icon 32 "mac-icon-16@2x.png"
copy_icon 32 "mac-icon-32@1x.png"
copy_icon 64 "mac-icon-32@2x.png"
copy_icon 128 "mac-icon-128@1x.png"
copy_icon 256 "mac-icon-128@2x.png"
copy_icon 256 "mac-icon-256@1x.png"
copy_icon 512 "mac-icon-256@2x.png"
copy_icon 512 "mac-icon-512@1x.png"
copy_icon 1024 "mac-icon-512@2x.png"
cp "$ROOT/extension/images/icon-512.png" "$GEN/Assets.xcassets/LargeIcon.imageset/"*.png 2>/dev/null || true

# The template window is 425x325, which is too short for real onboarding text
# and leaves it scrolling in a stub of a window. Widen and lengthen it.
STORYBOARD="$GEN/Base.lproj/Main.storyboard"
if grep -q 'width="425" height="325"' "$STORYBOARD"; then
  sed -i '' 's/width="425" height="325"/width="460" height="620"/g' "$STORYBOARD"
else
  # Not fatal, but say so: a silent no-op here would be blamed on CSS later.
  echo "note: window-size patch did not apply; Apple's template may have changed"
fi

echo
echo "Project: $ROOT/build/$APP_NAME/$APP_NAME.xcodeproj"
echo "Next:    ./sign-local.sh    (build, sign, install to /Applications)"
