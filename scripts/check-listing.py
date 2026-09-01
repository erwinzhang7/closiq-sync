#!/usr/bin/env python3
"""Check the listing copy against App Store Connect's field limits.

Pasting an over-length field into App Store Connect fails at save time with a
terse message, usually after the rest of the form has been filled in. Cheaper to
find out here.
"""
import re
import sys
from pathlib import Path

LIMITS = {
    "Name": 30,
    "Subtitle": 30,
    "Promotional text": 170,
    "Keywords": 100,
    "Description": 4000,
    "What's New (1.0)": 4000,
}

doc = Path(__file__).resolve().parent.parent / "store" / "listing.md"
text = doc.read_text()

bad = 0
for heading, limit in LIMITS.items():
    m = re.search(
        rf"^## {re.escape(heading)}\s*\n+```\n(.*?)\n```",
        text,
        re.S | re.M,
    )
    if not m:
        print(f"  MISSING  {heading}")
        bad += 1
        continue
    body = m.group(1)
    n = len(body)
    status = "ok  " if n <= limit else "OVER"
    if n > limit:
        bad += 1
    print(f"  {status} {heading:20} {n:>5} / {limit}")

# Keywords are comma separated with no spaces after commas; a space costs a
# character out of the same 100 and buys nothing.
m = re.search(r"^## Keywords\s*\n+```\n(.*?)\n```", text, re.S | re.M)
if m and ", " in m.group(1):
    print("  WARN keywords contain ', ' — spaces waste the 100-char budget")

sys.exit(1 if bad else 0)
