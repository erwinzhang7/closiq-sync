#!/usr/bin/env python3
"""Generate Mac App Store screenshots.

2880x1800 is one of the accepted macOS sizes and the largest 16:10 one, so it
scales down cleanly to the others.

These are drawn rather than captured. Capturing a real session would put a
streaming service's interface into the listing, which is someone else's
copyrighted UI and a routine rejection reason, and it would mean screenshotting
a real person's desktop. Everything here is our own artwork depicting our own
interface.

    ./scripts/make-screenshots.py            -> store/screenshots/*.png
"""
import subprocess
import sys
from pathlib import Path

W, H = 2880, 1800
OUT = Path(__file__).resolve().parent.parent / "store" / "screenshots"

FONT = "SF Pro Display, Helvetica Neue, Helvetica"
MONO = "SF Mono, Menlo, monospace"

ACCENT = "#6d6dfa"
ACCENT2 = "#8a45e8"
FG = "#f4f4f8"
MUTED = "#9a9aa6"


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def defs():
    return f"""
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#17171d"/>
      <stop offset="1" stop-color="#0c0c10"/>
    </linearGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{ACCENT}"/>
      <stop offset="1" stop-color="{ACCENT2}"/>
    </linearGradient>
    <linearGradient id="poster" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2a2740"/>
      <stop offset="0.55" stop-color="#1b1b28"/>
      <stop offset="1" stop-color="#141420"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="{ACCENT}"/>
      <stop offset="1" stop-color="{ACCENT2}"/>
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="26" stdDeviation="34" flood-color="#000" flood-opacity="0.55"/>
    </filter>
    <!-- Softness comes from radial gradients that fade to zero opacity, not
         from feGaussianBlur: the SVG rasteriser used here ignores filter
         primitives, and blurred blobs come out as hard-edged circles that read
         as clip art. -->
    <radialGradient id="blob1">
      <stop offset="0" stop-color="{ACCENT}" stop-opacity="0.55"/>
      <stop offset="0.6" stop-color="{ACCENT}" stop-opacity="0.18"/>
      <stop offset="1" stop-color="{ACCENT}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="blob2">
      <stop offset="0" stop-color="{ACCENT2}" stop-opacity="0.50"/>
      <stop offset="0.6" stop-color="{ACCENT2}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="{ACCENT2}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="blob3">
      <stop offset="0" stop-color="#2ec5c0" stop-opacity="0.34"/>
      <stop offset="0.6" stop-color="#2ec5c0" stop-opacity="0.11"/>
      <stop offset="1" stop-color="#2ec5c0" stop-opacity="0"/>
    </radialGradient>
  </defs>"""


def app_mark(x, y, size):
    """The Watchalong icon, drawn at an arbitrary size."""
    s = size / 512
    return f"""
  <g transform="translate({x},{y}) scale({s})">
    <rect width="512" height="512" rx="114" fill="url(#mark)"/>
    <polygon points="180,140 264,187.8 264,324.2 180,372" fill="#fff"/>
    <polygon points="280,196.9 384,256 280,315.1" fill="#fff" fill-opacity="0.82"/>
  </g>"""


def window(x, y, w, h, progress, marker=None):
    """A mock browser window playing something abstract."""
    tb = 76
    vid_y = y + tb
    vid_h = h - tb
    bar_y = y + h - 92
    bar_w = w - 160
    filled = bar_w * progress

    parts = [f"""
  <g filter="url(#shadow)">
    <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="26" fill="#1b1b21"/>
  </g>
  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="26" fill="none"
        stroke="#ffffff" stroke-opacity="0.09"/>
  <path d="M{x} {y+26} a26 26 0 0 1 26 -26 h{w-52} a26 26 0 0 1 26 26 v{tb-26} h-{w} z"
        fill="#232329"/>
  <circle cx="{x+38}" cy="{y+38}" r="10" fill="#ff5f57"/>
  <circle cx="{x+72}" cy="{y+38}" r="10" fill="#febc2e"/>
  <circle cx="{x+106}" cy="{y+38}" r="10" fill="#28c840"/>
  <rect x="{x}" y="{vid_y}" width="{w}" height="{vid_h}" fill="url(#poster)"/>
  <!-- Abstract shapes so the player does not read as broken or empty. They
       depict nothing, which is the point: no third party's content appears in
       the listing. -->
  <clipPath id="vid{x}">
    <rect x="{x}" y="{vid_y}" width="{w}" height="{vid_h}"/>
  </clipPath>
  <g clip-path="url(#vid{x})">
    <ellipse cx="{x+w*0.26:.0f}" cy="{vid_y+vid_h*0.44:.0f}" rx="620" ry="520" fill="url(#blob1)"/>
    <ellipse cx="{x+w*0.55:.0f}" cy="{vid_y+vid_h*0.76:.0f}" rx="700" ry="480" fill="url(#blob2)"/>
    <ellipse cx="{x+w*0.78:.0f}" cy="{vid_y+vid_h*0.26:.0f}" rx="560" ry="440" fill="url(#blob3)"/>
  </g>
  <rect x="{x+80}" y="{bar_y}" width="{bar_w}" height="8" rx="4"
        fill="#ffffff" fill-opacity="0.18"/>
  <rect x="{x+80}" y="{bar_y}" width="{filled:.0f}" height="8" rx="4" fill="url(#bar)"/>
  <circle cx="{x+80+filled:.0f}" cy="{bar_y+4}" r="15" fill="#fff"/>"""]

    if marker:
        # The on-page HUD, drawn where it actually appears: top-centre.
        text, tw = marker
        mx = x + (w - tw) / 2
        my = vid_y + 54
        parts.append(f"""
  <rect x="{mx:.0f}" y="{my}" width="{tw}" height="76" rx="38"
        fill="#141416" fill-opacity="0.90"/>
  <text x="{x+w/2:.0f}" y="{my+50}" font-family="{FONT}" font-size="34"
        fill="{FG}" text-anchor="middle">{esc(text)}</text>""")

    return "".join(parts)


def popup(x, y, code, status, tone, detail):
    """The extension popup, at roughly its real proportions."""
    w, h = 620, 560
    dot = {"ok": "#34c759", "warn": "#ff9f0a"}[tone]
    return f"""
  <g filter="url(#shadow)">
    <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="30" fill="#1f1f25"/>
  </g>
  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="30" fill="none"
        stroke="#ffffff" stroke-opacity="0.10"/>

  <text x="{x+48}" y="{y+74}" font-family="{FONT}" font-size="26"
        fill="{MUTED}" letter-spacing="3">ROOM CODE</text>

  <rect x="{x+44}" y="{y+100}" width="{w-88}" height="118" rx="18"
        fill="#ffffff" fill-opacity="0.06"/>
  <text x="{x+w/2}" y="{y+180}" font-family="{MONO}" font-size="74" font-weight="bold"
        fill="{FG}" text-anchor="middle" letter-spacing="12">{esc(code)}</text>

  <circle cx="{x+60}" cy="{y+278}" r="11" fill="{dot}"/>
  <text x="{x+88}" y="{y+290}" font-family="{FONT}" font-size="34"
        fill="{FG}">{esc(status)}</text>
  <text x="{x+88}" y="{y+340}" font-family="{FONT}" font-size="27"
        fill="{MUTED}">{esc(detail)}</text>

  <rect x="{x+44}" y="{y+400}" width="{w-88}" height="96" rx="18"
        fill="#ffffff" fill-opacity="0.07"/>
  <text x="{x+w/2}" y="{y+458}" font-family="{FONT}" font-size="32"
        fill="{FG}" text-anchor="middle">Leave session</text>"""


def screenshot(headline, sub, body):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  {defs()}
  <rect width="{W}" height="{H}" fill="url(#bg)"/>
  {app_mark(W/2 - 58, 120, 116)}
  <text x="{W/2}" y="380" font-family="{FONT}" font-size="104" font-weight="bold"
        fill="{FG}" text-anchor="middle" letter-spacing="-2">{esc(headline)}</text>
  <text x="{W/2}" y="462" font-family="{FONT}" font-size="46"
        fill="{MUTED}" text-anchor="middle">{esc(sub)}</text>
  {body}
</svg>"""


SHOTS = [
    (
        "01-together",
        "Watch together, actually in step.",
        "Share a six-character code. Play, pause and skip from either side.",
        window(240, 580, 2400, 1080,0.42)
        + popup(1960, 706,"K7MQD3", "In sync", "ok", "+12 ms apart · 38 ms ping"),
    ),
    (
        "02-nudge",
        "It nudges instead of jumping.",
        "Whoever is ahead eases off a few percent until you line up again.",
        window(240, 580, 2400, 1080,0.58, marker=("Easing off 3% to match", 560))
        + popup(1960, 706,"K7MQD3", "In sync, easing off 3%", "ok",
                "+240 ms apart · closing gently"),
    ),
    (
        "03-waiting",
        "Nobody gets left behind.",
        "If one of you stops to buffer, the other waits, then you resume together.",
        window(240, 580, 2400, 1080,0.31,
               marker=("Waiting for your partner to buffer", 800))
        + popup(1960, 706,"K7MQD3", "Waiting on a buffer", "warn",
                "paused until they catch up"),
    ),
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, headline, sub, body in SHOTS:
        svg = OUT / f"{name}.svg"
        png = OUT / f"{name}.png"
        svg.write_text(screenshot(headline, sub, body))
        r = subprocess.run(
            ["sips", "-s", "format", "png", str(svg), "--out", str(png)],
            capture_output=True,
        )
        if r.returncode != 0:
            print(r.stderr.decode(), file=sys.stderr)
            sys.exit(f"failed to render {name}")
        svg.unlink()

        # sips renders SVG at its intrinsic size; confirm rather than trust,
        # because a wrong-sized screenshot is rejected at upload.
        out = subprocess.run(
            ["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(png)],
            capture_output=True, text=True,
        ).stdout
        got = dict(
            line.strip().split(": ")
            for line in out.splitlines()
            if ": " in line
        )
        if (int(got.get("pixelWidth", 0)), int(got.get("pixelHeight", 0))) != (W, H):
            sys.exit(f"{name}: expected {W}x{H}, got {got}")
        print(f"  {png.name}  {W}x{H}")


if __name__ == "__main__":
    main()
