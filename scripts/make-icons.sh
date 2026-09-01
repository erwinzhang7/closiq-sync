#!/bin/bash
# Generate the Watchalong icon set.
#
# The mark is a play triangle split down the middle: one control, two people.
# It has to survive being 16px in a Safari toolbar, so the seam is deliberately
# wide -- at small sizes it reads as a single play button, which is the right
# fallback, rather than as mush.
#
# Rendered from SVG at each target size rather than downsampled from one large
# PNG; sips' resampler softens the small toolbar sizes noticeably.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/extension/images"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

# Left piece is a trapezoid, right piece a triangle; coordinates are the split
# of a play triangle with vertices (180,140) (180,372) (384,256).
LEFT="180,140 264,187.8 264,324.2 180,372"
RIGHT="280,196.9 384,256 280,315.1"

app_svg() {
  cat <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="$1" height="$1" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6D6DFA"/>
      <stop offset="1" stop-color="#8A45E8"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="114" ry="114" fill="url(#g)"/>
  <polygon points="$LEFT" fill="#ffffff"/>
  <polygon points="$RIGHT" fill="#ffffff" fill-opacity="0.82"/>
</svg>
SVG
}

# Toolbar icons are template images: Safari keys off the alpha channel and
# recolours them for light, dark and the pressed state. Any colour here would be
# thrown away, so they are flat black, and drawn larger in the frame because a
# toolbar glyph has no background plate to sit on.
toolbar_svg() {
  cat <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="$1" height="$1" viewBox="60 60 392 392">
  <polygon points="$LEFT" fill="#000000"/>
  <polygon points="$RIGHT" fill="#000000" fill-opacity="0.75"/>
</svg>
SVG
}

render() { # svg-file  png-file
  sips -s format png "$1" --out "$2" >/dev/null
}

for s in 16 32 48 64 96 128 256 512 1024; do
  app_svg "$s" > "$TMP/icon-$s.svg"
  render "$TMP/icon-$s.svg" "$OUT/icon-$s.png"
done

for s in 16 19 32 38 64; do
  toolbar_svg "$s" > "$TMP/toolbar-$s.svg"
  render "$TMP/toolbar-$s.svg" "$OUT/toolbar-$s.png"
done

# Keep the vector sources alongside the rasters; the App Store icon and any
# future marketing asset should come from these, not from an upscaled PNG.
app_svg 512 > "$OUT/icon.svg"
toolbar_svg 512 > "$OUT/toolbar.svg"

echo "wrote $(ls -1 "$OUT" | wc -l | tr -d ' ') files to extension/images"
