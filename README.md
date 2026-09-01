# ClosiqSync

Watch a video with someone else and actually stay in step. A Safari extension
plus a small Cloudflare room server. Works on anything with a `<video>` element.

Play, pause and seek propagate both ways. Small gaps are closed by easing the
*ahead* side off by a few percent rather than jumping the video, which is the
difference between "we're watching together" and "we're both being yanked
around". If one of you stalls to buffer, the other waits.

## How the sync actually works

**The timebase.** Neither peer's wall clock is trusted, and they are never
compared to each other. This Mac measured 111ms of offset against Cloudflare's
edge; two machines each wrong by a different amount would sit permanently
apart. Instead each peer runs an NTP-style handshake against the Durable Object
and expresses every position in DO time. Two peers who each know their offset to
the DO thereby know their offset to each other.

We keep the **lowest-RTT** sample of a batch rather than the median: a round
trip can only be inflated by queueing, never deflated, so the fastest sample is
the least contaminated. Pinging continues for the life of the session. Measuring
once at connect and trusting it forever is a trap, because those samples are
taken during connection setup, the most congested moment there is.

**The control law.** The reference position is the *slowest* peer, not a
designated host. That makes the controller slowdown-only, and it means nobody is
ever made to miss content in order to stay in sync.

| error | what happens |
| --- | --- |
| inside the deadband | nothing |
| deadband to 1.5s ahead | proportional slowdown, capped at 5%, `preservesPitch` on |
| more than 1.5s ahead | hold: pause and let them catch up, rather than seek backwards |
| far behind | seek, but only if a peer is wedged well past a normal stall |

The deadband is `max(60ms, rtt/2)`. You cannot synchronise tighter than you can
measure, so on a slow link it relaxes instead of hunting for a target it has no
ability to see.

An explicit seek by a peer bypasses all of the above. That is intent, not drift.

**Not fighting itself.** The hard part of a sync app is that your seek fires
`seeked` on my side, which I would report as a fresh user seek, which you would
apply, forever. Every programmatic write leaves an echo token that suppresses the
event it causes. Position cannot use a plain TTL the way `paused` and `rate` can,
because `seeked` may not arrive for seconds on a cold stream, so it matches on
proximity to the requested target instead.

## Layout

```
extension/
  manifest.json    MV3. background.scripts, not service_worker
  api.js           browser.* / chrome.* shim
  shared.js        tuning constants, room codes, URL fingerprinting
  media.js         video discovery, guarded writes, echo suppression
  sync.js          clock, drift controller, follow-the-laggard state machine
  content.js       wiring plus the on-page HUD
  background.js    owns the WebSocket, arbitrates which frame drives
  popup.*          create/join a room
app/               container-app overrides copied over the generated project
worker/            Cloudflare Worker + Durable Object room server
test/sim.mjs       headless two-peer simulation
build.sh           wraps extension/ in an Xcode project
sign-local.sh      build, sign and install for local development
```

The socket lives in the background page, not the content script: a content-script
WebSocket is subject to the page's own `connect-src` CSP, and plenty of streaming
sites ship a restrictive one. It also dies on every SPA navigation.

It does **not** depend on the background page staying alive. Safari suspends
non-persistent background pages; the room is persisted to storage and a revived
background page reconnects the moment a content script talks to it. Teardown
costs a reconnect, not a broken session.

## Privacy

A room code, a playback position, and a SHA-256 fingerprint of the normalised
video URL. The URL itself never leaves the machine: peers only need to agree they
are on the same video, and equality of a digest proves that just as well. No
accounts, and the room is forgotten 12 hours after it goes quiet.

## Developing

```sh
./sign-local.sh          # build, sign, install to /Applications
node test/sim.mjs        # two-peer simulation, no browser needed
cd worker && wrangler dev --local && node test-client.mjs http://localhost:8799
```

Then once, in Safari: Settings → Extensions → tick **ClosiqSync**, click the toolbar
button → **Always Allow on Every Website**, and reload any tabs that were already
open. Safari does not inject content scripts into tabs that predate the grant.

### Things that will cost you an afternoon otherwise

- **Re-running `sign-local.sh` changes the cdhash, so Safari disables the
  extension.** Re-tick it; the host-access grant survives.
- **Changing `manifest.json` needs a version bump and a full ⌘Q of Safari.**
  Safari caches extension code across reinstalls. Editing only JS is fine.
- **The bundle id's capital I is load-bearing.** The packager derives the app id
  from `--app-name` and the appex id from `--bundle-identifier`, and Xcode's
  embedded-binary prefix check is case-sensitive. `app.closiq.closiqsync` against an
  app named `ClosiqSync` fails the build.
- **`build/` is regenerated wholesale.** Anything you want to keep goes in
  `app/` or `extension/`; `build.sh` copies it over the generated output.
- **A blank container window proves nothing.** Screenshot APIs do not reliably
  capture WebKit's out-of-process surface and the accessibility tree does not
  expose web content to external clients. Build Debug and read the DOM probe:
  `/usr/bin/log show --last 5m --info --predicate 'subsystem == "app.closiq.ClosiqSync"'`.
  Note `log` is a zsh builtin, so the absolute path matters.

## Shipping

```sh
./scripts/check-listing.py     # field lengths against App Store Connect limits
./scripts/make-screenshots.py  # store/screenshots/*.png at 2880x1800
./archive.sh                   # signed build/export/ClosiqSync.pkg
UPLOAD=1 ./archive.sh          # and upload
```

Listing copy, privacy-label reasoning and App Review notes live in
`store/listing.md`. The app record itself must be created in the App Store
Connect web UI first: the API refuses `POST /v1/apps`.

`scripts/patch-project.py` fixes two things the packager gets wrong silently.
It sets the project deployment target to the SDK version, which the app target
inherits, so an unpatched build refuses to install on anything but the newest
macOS; and it leaves signing on Automatic, which cannot be combined with
explicit distribution profiles. Entitlements are deliberately left alone, since
the project already generates them from `ENABLE_APP_SANDBOX` and friends.
