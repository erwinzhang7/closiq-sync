#!/usr/bin/env python3
"""Push the App Store listing from store/listing.md into App Store Connect.

store/listing.md is the single source of truth. Editing metadata in the web UI
and in a file separately guarantees they drift, so everything the API can set is
set from here.

Not settable by the API, and left for the web UI: the age-rating questionnaire,
pricing and availability, and the App Privacy questionnaire.

    ./scripts/push-metadata.py [--dry-run]
"""
import json
import re
import subprocess
import sys
from pathlib import Path

APP_ID = "6807276045"
DRY = "--dry-run" in sys.argv

ROOT = Path(__file__).resolve().parent.parent
LISTING = (ROOT / "store" / "listing.md").read_text()


def asc(method, path, body=None):
    cmd = ["asc", "raw", method, path]
    if body is not None:
        cmd.append(json.dumps(body))
    if DRY:
        print(f"  DRY {method} {path}")
        return {}
    r = subprocess.run(cmd, capture_output=True, text=True)
    out = (r.stdout or "").strip()
    try:
        return json.loads(out)
    except Exception:
        if r.returncode != 0 or "error" in out.lower():
            sys.exit(f"  FAIL {method} {path}\n{out}\n{r.stderr}")
        return {}


def block(heading):
    """The first fenced code block under a `## heading`.

    Prose is allowed between the heading and the fence, so the section can
    explain itself without breaking extraction.
    """
    start = re.search(rf"^## {re.escape(heading)}\s*$", LISTING, re.M)
    if not start:
        sys.exit(f"listing.md has no '## {heading}' section")
    rest = LISTING[start.end() :]
    # Stop at the next heading so a missing fence cannot silently swallow the
    # rest of the document.
    nxt = re.search(r"^## ", rest, re.M)
    section = rest[: nxt.start()] if nxt else rest
    m = re.search(r"```\n(.*?)\n```", section, re.S)
    if not m:
        sys.exit(f"listing.md is missing a code block for '{heading}'")
    return m.group(1).strip()


def field(label):
    """A `- **Label** value` bullet from the header list."""
    m = re.search(rf"^- \*\*{re.escape(label)}\*\* (.+)$", LISTING, re.M)
    if not m:
        sys.exit(f"listing.md is missing '{label}'")
    return m.group(1).strip().strip("`")


def one(path, what):
    data = asc("GET", path).get("data") or []
    if DRY:
        return "DRY-ID"
    if not data:
        sys.exit(f"no {what} found at {path}")
    return data[0]["id"]


print("resolving records")
app_info = one(f"/v1/apps/{APP_ID}/appInfos", "appInfo")
version = one(f"/v1/apps/{APP_ID}/appStoreVersions", "appStoreVersion")
info_loc = one(f"/v1/appInfos/{app_info}/appInfoLocalizations", "appInfoLocalization")
ver_loc = one(
    f"/v1/appStoreVersions/{version}/appStoreVersionLocalizations",
    "appStoreVersionLocalization",
)
print(f"  appInfo={app_info}\n  version={version}")

# --- categories -------------------------------------------------------------
print("categories")
asc(
    "PATCH",
    f"/v1/appInfos/{app_info}",
    {
        "data": {
            "type": "appInfos",
            "id": app_info,
            "relationships": {
                "primaryCategory": {
                    "data": {"type": "appCategories", "id": "ENTERTAINMENT"}
                },
                "secondaryCategory": {
                    "data": {"type": "appCategories", "id": "SOCIAL_NETWORKING"}
                },
            },
        }
    },
)

# --- name, subtitle, privacy policy ----------------------------------------
print("app info localization")
asc(
    "PATCH",
    f"/v1/appInfoLocalizations/{info_loc}",
    {
        "data": {
            "type": "appInfoLocalizations",
            "id": info_loc,
            "attributes": {
                "name": block("Name"),
                "subtitle": block("Subtitle"),
                "privacyPolicyUrl": field("Privacy Policy URL"),
            },
        }
    },
)

# --- copyright --------------------------------------------------------------
print("version")
asc(
    "PATCH",
    f"/v1/appStoreVersions/{version}",
    {
        "data": {
            "type": "appStoreVersions",
            "id": version,
            "attributes": {"copyright": field("Copyright")},
        }
    },
)

# --- description, keywords, urls -------------------------------------------
print("version localization")
attrs = {
    "description": block("Description"),
    "keywords": block("Keywords"),
    "promotionalText": block("Promotional text"),
    "supportUrl": field("Support URL"),
    "marketingUrl": field("Marketing URL"),
}

# "What's New" describes what changed since the last release, so it does not
# exist on a first version. Sending it anyway fails the whole PATCH with a 409
# ("cannot be edited at this time") and takes the other five fields down with
# it, so decide by whether a previous version exists rather than by guessing.
all_versions = (asc("GET", f"/v1/apps/{APP_ID}/appStoreVersions").get("data") or [])
if len(all_versions) > 1:
    attrs["whatsNew"] = block("What's New (1.0)")
else:
    print("  first release: skipping whatsNew, which only applies to updates")

asc(
    "PATCH",
    f"/v1/appStoreVersionLocalizations/{ver_loc}",
    {"data": {"type": "appStoreVersionLocalizations", "id": ver_loc, "attributes": attrs}},
)

# --- review notes -----------------------------------------------------------
print("review details")
notes = block("App Review notes")
existing = asc("GET", f"/v1/appStoreVersions/{version}/appStoreReviewDetail")
detail = (existing or {}).get("data")
# App Store Connect requires all four contact fields on any write to this
# record, so a notes-only PATCH is rejected outright with four "missing
# required attribute" errors rather than just saving the notes.
phone = field("Review contact phone")
if "TODO" in phone:
    sys.exit("  set 'Review contact phone' in listing.md (E.164, e.g. +1 416 555 0123)")
body_attrs = {
    "notes": notes,
    "demoAccountRequired": False,
    "contactFirstName": field("Review contact name").split()[0],
    "contactLastName": " ".join(field("Review contact name").split()[1:]),
    "contactEmail": field("Review contact email"),
    "contactPhone": phone,
}
if detail and not DRY:
    asc(
        "PATCH",
        f"/v1/appStoreReviewDetails/{detail['id']}",
        {
            "data": {
                "type": "appStoreReviewDetails",
                "id": detail["id"],
                "attributes": body_attrs,
            }
        },
    )
else:
    asc(
        "POST",
        "/v1/appStoreReviewDetails",
        {
            "data": {
                "type": "appStoreReviewDetails",
                "attributes": body_attrs,
                "relationships": {
                    "appStoreVersion": {
                        "data": {"type": "appStoreVersions", "id": version}
                    }
                },
            }
        },
    )

print("\ndone. Still to do by hand in App Store Connect:")
print("  - Age rating questionnaire")
print("  - Pricing and availability")
print("  - App Privacy questionnaire (see 'App Privacy' in store/listing.md)")
