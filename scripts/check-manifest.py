#!/usr/bin/env python3
"""Validate manifest.json against the rules App Store upload enforces.

These are checked by Apple's ingestion service, not by Xcode, so breaking one
costs a full archive, export and upload before you find out. Error 90849 for the
description limit is the one that has actually bitten.
"""
import json
import sys
from pathlib import Path

manifest = Path(__file__).resolve().parent.parent / "extension" / "manifest.json"
m = json.loads(manifest.read_text())

problems = []

desc = m.get("description")
if not isinstance(desc, str) or not desc:
    problems.append("description must be present and a string")
elif len(desc) > 112:
    problems.append(f"description is {len(desc)} chars; the limit is 112 (error 90849)")

name = m.get("name")
if not isinstance(name, str) or not name:
    problems.append("name must be present and a string")
elif len(name) > 50:
    problems.append(f"name is {len(name)} chars; keep it short enough for Safari's list")

if not m.get("version"):
    problems.append("version must be present")

# Test code must never reach the shipping appex: everything under extension/ is
# copied verbatim into the bundle.
ext_dir = manifest.parent
for stray in ("test", "tests", "node_modules"):
    if (ext_dir / stray).exists():
        problems.append(f"extension/{stray}/ would ship inside the appex; move it out")

for p in problems:
    print(f"  FAIL {p}")
if not problems:
    print(f"  ok   manifest: description {len(desc)}/112, name {name!r}, v{m['version']}")

sys.exit(1 if problems else 0)
