#!/usr/bin/env python3
"""Patch the generated Xcode project for Mac App Store distribution.

The Safari web-extension packager produces a project that needs two changes,
both of which fail silently rather than loudly if skipped.

  1. MACOSX_DEPLOYMENT_TARGET is set to the SDK version (macOS 26.5 as of
     writing) at the project level, and to 10.14 on the extension target. The
     app target inherits the project value, so a shipped build would refuse to
     install on anything but the newest macOS while the extension claimed to
     support a release predating MV3 entirely. Nothing warns about either.

  2. Signing is Automatic, which cannot be combined with the explicit Mac App
     Store profiles. Distribution settings live here rather than on the
     xcodebuild command line because the profile specifier differs per target,
     and command-line build settings apply to every target at once.

Deliberately NOT patched: entitlements. The project already carries
ENABLE_APP_SANDBOX, ENABLE_HARDENED_RUNTIME, ENABLE_OUTGOING_NETWORK_CONNECTIONS
and ENABLE_USER_SELECTED_FILES, the modern build-setting-driven form that makes
Xcode synthesise the entitlements at build time. Supplying a CODE_SIGN_ENTITLEMENTS
file on top of that only risks narrowing what those settings already grant.

Every change is verified, and the script exits non-zero if a substitution did
not apply, because a silently skipped patch becomes a rejected upload much later
with an unrelated-looking error.
"""
import re
import sys
from pathlib import Path

DEPLOYMENT_TARGET = "13.0"

APP_BUNDLE_ID = "com.closiq.Insync"
EXT_BUNDLE_ID = "com.closiq.Insync.Extension"

TEAM_ID = "QFJW3NFT2M"  # Closiq Inc.
APP_PROFILE = "Insync Mac App Store"
EXT_PROFILE = "Insync Extension Mac App Store"

CONFIG_BLOCK = r"\{\s*isa = XCBuildConfiguration;.*?\n\t\t\};"


def fail(msg):
    print(f"patch-project: {msg}", file=sys.stderr)
    sys.exit(1)


def set_setting(block, key, value):
    """Replace `key` inside a buildSettings block, or insert it if absent.

    Inserting unconditionally would leave two copies of the key. The pbxproj
    format tolerates that and the LAST one wins, so a prepended
    `CODE_SIGN_STYLE = Manual` sitting above the template's
    `CODE_SIGN_STYLE = Automatic` is silently ignored -- which surfaces only as
    "conflicting provisioning settings" at archive time.
    """
    pattern = re.compile(rf"^(\s*){re.escape(key)} = [^;]+;$", re.M)
    if pattern.search(block):
        return pattern.sub(rf"\g<1>{key} = {value};", block, count=1)
    return block.replace(
        "buildSettings = {", f"buildSettings = {{\n\t\t\t\t{key} = {value};", 1
    )


def main():
    if len(sys.argv) != 2:
        fail("usage: patch-project.py <path/to/project.pbxproj>")

    path = Path(sys.argv[1])
    if not path.is_file():
        fail(f"no such file: {path}")

    src = path.read_text()
    original = src

    # --- 1. deployment target ------------------------------------------------
    found = len(re.findall(r"MACOSX_DEPLOYMENT_TARGET = [^;]+;", src))
    if found == 0:
        fail("found no MACOSX_DEPLOYMENT_TARGET settings; template changed?")
    src = re.sub(
        r"MACOSX_DEPLOYMENT_TARGET = [^;]+;",
        f"MACOSX_DEPLOYMENT_TARGET = {DEPLOYMENT_TARGET};",
        src,
    )
    stale = [
        v
        for v in re.findall(r"MACOSX_DEPLOYMENT_TARGET = ([^;]+);", src)
        if v.strip() != DEPLOYMENT_TARGET
    ]
    if stale:
        fail(f"deployment target not fully applied, still see: {sorted(set(stale))}")

    # --- 2. App Store category ----------------------------------------------
    # Required for the store. The project sets GENERATE_INFOPLIST_FILE, so this
    # build setting is how LSApplicationCategoryType gets into Info.plist.
    # Without it the archive warns and App Store Connect will not accept the
    # listing.
    def add_category(text):
        added = 0

        def repl(m):
            nonlocal added
            block = m.group(0)
            if f"PRODUCT_BUNDLE_IDENTIFIER = {APP_BUNDLE_ID};" not in block:
                return block
            added += 1
            return set_setting(
                block,
                "INFOPLIST_KEY_LSApplicationCategoryType",
                '"public.app-category.entertainment"',
            )

        return re.sub(CONFIG_BLOCK, repl, text, flags=re.S), added

    src, n_cat = add_category(src)
    if n_cat == 0:
        fail(f"no build configs matched {APP_BUNDLE_ID} for the category")

    # --- 3. distribution signing, Release only -------------------------------
    def add_signing(text, bundle_id, profile):
        added = 0

        def repl(m):
            nonlocal added
            block = m.group(0)
            if f"PRODUCT_BUNDLE_IDENTIFIER = {bundle_id};" not in block:
                return block
            if "name = Release;" not in block:
                return block
            for key, value in (
                ("CODE_SIGN_STYLE", "Manual"),
                ("CODE_SIGN_IDENTITY", '"Apple Distribution"'),
                ("DEVELOPMENT_TEAM", TEAM_ID),
                ("PROVISIONING_PROFILE_SPECIFIER", f'"{profile}"'),
            ):
                block = set_setting(block, key, value)
            added += 1
            return block

        return re.sub(CONFIG_BLOCK, repl, text, flags=re.S), added

    src, s_app = add_signing(src, APP_BUNDLE_ID, APP_PROFILE)
    src, s_ext = add_signing(src, EXT_BUNDLE_ID, EXT_PROFILE)

    if s_app != 1:
        fail(f"expected one Release config for {APP_BUNDLE_ID}, patched {s_app}")
    if s_ext != 1:
        fail(f"expected one Release config for {EXT_BUNDLE_ID}, patched {s_ext}")

    # No duplicate signing keys may survive, in either direction.
    for block in re.findall(CONFIG_BLOCK, src, flags=re.S):
        if "name = Release;" not in block:
            continue
        for key in ("CODE_SIGN_STYLE", "PROVISIONING_PROFILE_SPECIFIER"):
            n = len(re.findall(rf"^\s*{key} = ", block, re.M))
            if n > 1:
                fail(f"{key} appears {n} times in one Release config; last would win")

    if src == original:
        fail("nothing changed; refusing to claim success")

    path.write_text(src)
    print(
        f"patched: deployment target -> {DEPLOYMENT_TARGET} ({found} settings), "
        f"manual distribution signing -> app + extension Release configs"
    )


if __name__ == "__main__":
    main()
