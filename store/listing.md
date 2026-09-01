# App Store Connect listing — ClosiqSync

Everything to paste into App Store Connect. Field lengths are checked by
`scripts/check-listing.py`.

- **Bundle ID** `com.closiq.ClosiqSync`
- **SKU** `CLOSIQSYNC001`
- **Primary category** Entertainment · **Secondary** Social Networking
- **Age rating** 4+
- **Copyright** 2026 Closiq Inc.
- **Support URL** https://closiqsync.closiq.app/support
- **Marketing URL** https://closiqsync.closiq.app
- **Privacy Policy URL** https://closiqsync.closiq.app/privacy

---

## Name

```
Closiq Sync
```

## Subtitle

```
Watch videos in step
```

## Promotional text

```
Share a six-character code and watch anything together. If one of you drifts ahead, ClosiqSync eases them back in line so gently you will not notice.
```

## Keywords

```
watch,party,together,sync,video,movie,night,remote,distance,couple,friends,stream
```

## Description

```
ClosiqSync keeps two people's video playback in step, on any site with a video.

Start a session, send the six-character code to whoever you are watching with, and you are lined up. Play, pause and skip work from either side.

IT NUDGES INSTEAD OF JUMPING

Two computers never play at exactly the same speed, so a gap opens up over a long film. Most tools fix that by jumping the video, which is jarring for whoever gets moved.

ClosiqSync does something quieter. Whoever is ahead eases off by up to five percent, with pitch correction so nothing sounds odd, until the gap closes on its own. You will not notice it happening.

Because it only ever slows the person in front, nobody is skipped past anything.

NOBODY GETS LEFT BEHIND

If one of you stops to buffer, the other pauses and waits, then you both carry on together. A pause you make yourself is never undone automatically.

If you drift onto different videos, ClosiqSync notices and stops rather than dragging anyone somewhere they did not ask to go.

IT DOES NOT KNOW WHAT YOU WATCH

ClosiqSync needs to send a playback position to the other person, and that is all it sends. The address of the page you are on never leaves your Mac. To check you are both on the same video it compares a one-way scrambled fingerprint instead, which cannot be turned back into a web address.

No accounts. No sign-up. No analytics. Rooms are forgotten when you are done.

REQUIREMENTS

Both people need ClosiqSync, and both need to be watching the same video. Works with standard web video in Safari.
```

## What's New (1.0)

```
First release.
```

---

## App Privacy — recommended answers

**Recommendation: "Data Not Collected".**

The reasoning, so it can be defended if queried. Apple treats data as *collected*
when it is transmitted off device **and** retained or used beyond servicing the
immediate request. ClosiqSync transmits a room code, playback position and a
truncated hash, all relayed between participants and none of it written to
storage. The Durable Object retains only current connection membership, and
deletes that twelve hours after the room goes quiet. Nothing is linked to a
person, nothing identifies a device, nothing is used for tracking or
advertising, and there are no accounts.

The one thing to be aware of: the relay runs on Cloudflare, so the connecting IP
is visible to Cloudflare in order to route traffic, as it is for any request to
any website. That is infrastructure, not collection by the app, and the privacy
policy says so explicitly rather than staying quiet about it.

If a stricter reading is ever preferred, the honest alternative is a single
entry: **Other Usage Data**, *not linked to the user*, *not used for tracking*,
purpose "App Functionality". Do not declare Browsing History, which would be
wrong: no URL is ever transmitted.

---

## App Review notes

Paste this into the "Notes" field.

```
WHAT THIS APP DOES

ClosiqSync is a Safari extension that keeps two people's video playback
synchronised. One person starts a session and gets a six-character room code;
the other enters that code. Both then see the same playback position.

SETUP (one time)

1. Open ClosiqSync.app and click "Open Safari Settings -> Extensions".
2. Enable "ClosiqSync".
3. Click the ClosiqSync button in the Safari toolbar and choose
   "Always Allow on Every Website".
4. Reload any tab that was already open. Safari does not inject content
   scripts into tabs that predate the permission grant, so a pre-existing
   tab will do nothing until reloaded.

TESTING THE CORE FEATURE

Synchronisation is between two participants, so it needs two Macs, each with
ClosiqSync installed and enabled:

1. On Mac A, open any page with a video (any site with a standard HTML5
   video element works; a plain .mp4 in a tab is sufficient).
2. Click the ClosiqSync toolbar button, then "Start a session". A six
   character code appears.
3. On Mac B, open the same URL, click the toolbar button, type the code and
   press Join.
4. Press pause on either Mac. The other pauses. Press play, or drag the
   scrubber; the other follows.
5. The popup on each Mac shows the connection state and how far apart the
   two positions currently are.

If two Macs are not available for review, we are glad to supply a screen
recording of the above on request, or to walk through it on a call.

WHY THE EXTENSION REQUESTS ACCESS TO ALL WEBSITES

Video can be on any site, and the extension cannot know in advance which one
will be used, so there is no narrower set of hosts we could declare. On a
page it interacts only with the video element's playback state: current
time, paused state and playback rate. It does not read page content, form
fields or anything typed.

NO ACCOUNT IS REQUIRED

There is no sign-up and no login, so no demo credentials are needed. Room
codes are generated on demand and are not tied to any identity.

WHAT IS TRANSMITTED

A room code, playback position, paused state, playback rate, a buffering
flag, and a truncated SHA-256 hash of the normalised page URL used solely to
confirm both participants are on the same video. The URL itself is never
transmitted. The relay stores nothing beyond current room membership and
discards a room twelve hours after it goes idle.
```

---

## Screenshots

`store/screenshots/*.png`, 2880x1800, generated by
`scripts/make-screenshots.py`. They are drawn rather than captured so that no
third party's interface appears in the listing, which is a routine rejection
reason.

Upload once the version exists:

```sh
asc screenshots com.closiq.ClosiqSync store/screenshots APP_DESKTOP en-US
```

## Shipping a build

```sh
./archive.sh              # build and export build/export/ClosiqSync.pkg
UPLOAD=1 ./archive.sh     # and upload to App Store Connect
```

The app record must be created first in the App Store Connect web UI. The API
does not permit it: `POST /v1/apps` returns "The resource 'apps' does not allow
'CREATE'".
