# Video scripts — Closiq Sync

Two different videos, different audiences and different rules.

| | App Preview | App Review demo |
|---|---|---|
| Who sees it | Everyone, on the product page | Only the reviewer |
| Required | No | No, but this app is hard to review without it |
| Format | **1920×1080**, 15–30s, H.264, ≤30fps, ≤500MB | Anything reasonable; 1080p H.264 |
| Where it goes | Version page → App Previews and Screenshots | App Review Information → Attachment |
| Limit | 3 per localization | 1 |

Sources: Apple's App Preview specifications and App Store Review Guidelines 2.1(a)
and 2.3.

## Rules that constrain the shoot

From Apple's App Preview guidance, these are the ones that actually bite:

- **App footage only.** No hands, no fingers on screen, no shots of a Mac as an
  object, no over-the-shoulder angles. Screen capture only.
- **Only content you have rights to.** This is why the demo clip exists: record
  against `closiqsync.closiq.app/demo`, never Netflix or YouTube. A streaming
  service's interface in your preview is someone else's copyrighted UI.
- **Previews autoplay muted**, so anything important must be on screen as text.
  Keep each caption up long enough to read, roughly 2 seconds minimum.
- **Do not imply features that do not exist.** Everything below is real
  behaviour.
- **Pick a poster frame** deliberately; it is what shows when autoplay is off.

## Recording setup

Open <https://closiqsync.closiq.app/demo> on both Macs. The clip burns a running
timer into the picture, so when the two are in step they visibly show the same
number. That is the whole demo: the number, on both screens, matching.

Getting two Macs into one frame, easiest first:

1. **Two Macs, recorded separately, composited side by side.** Cleanest result.
   Each capture at 1920×1080, scaled to 960 wide in the edit.
2. **Your Mac plus a mini over Screen Sharing** (`mini-vnc experiments`), so the
   remote Safari is a window on your own screen and it is one single recording,
   no editing. Worth knowing: Screen Sharing adds latency to the *picture*, not
   to the sync, so the remote side may look a beat behind on video even though
   the timers agree. If that bothers you, use option 1.

Capture with ⇧⌘5 → Record Selected Portion, sized to 1920×1080. Before you start:
close unrelated tabs, and check that nothing personal is in the frame — the
window title, the bookmarks bar and the menu bar all end up on the product page.

---

## App Preview — 30 seconds

Left = Mac A, right = Mac B. Timings are cumulative.

| Time | On screen | Caption |
|---|---|---|
| 0:00–0:03 | A: the clip playing. Click the toolbar button; the popup opens. | **Watch anything, together** |
| 0:03–0:07 | A: click **Start a session**. The six-character code appears. | **Start a session** |
| 0:07–0:11 | B: type the code, press Join. Both popups go green, "In sync". | **They enter the code** |
| 0:11–0:16 | A: press pause. B stops on the same frame. Hold so both timers are legible and identical. | **Pause on one, both stop** |
| 0:16–0:21 | B: drag the scrubber to a different point. A jumps to match. | **Skip from either side** |
| 0:21–0:26 | Cut to the HUD reading "Easing off 3% to match", then the two timers converging. | **Small gaps close on their own** |
| 0:26–0:30 | Both popups green, both timers identical. Fade the app icon in. | **Closiq Sync** |

**Poster frame:** 0:13 or so, paused, both timers showing the same number and
both popups green. It states the whole proposition in one still.

If you would rather shoot one screen only, drop the 0:16–0:21 row, record on A
throughout, and let the caption carry what B is doing ("your partner skips
ahead"). It is weaker, but it is a legitimate single-take shoot.

---

## App Review demo — 60 to 90 seconds

No format rules, so optimise for a reviewer who has one Mac and needs to believe
the feature works. Narrate or caption each step; do not assume anything is
obvious.

1. **(0:00) Both Macs, side by side, each showing the demo page.** Say out loud
   that this is two separate Macs, both with Closiq Sync installed.
2. **(0:08) Show the extension is enabled** on both: Safari Settings →
   Extensions, Closiq Sync ticked. This pre-empts "we could not reproduce".
3. **(0:20) Start a session on A.** Show the code clearly and long enough to read.
4. **(0:28) Join from B** by typing that code. Both popups go green.
5. **(0:38) Pause on A.** B stops. Point at the two timers showing the same value.
6. **(0:48) Play on B.** A resumes.
7. **(0:56) Scrub A to roughly 2:00.** B follows within a second.
8. **(1:06) Show the popup detail line** on both, the "N ms apart" readout.
9. **(1:15) Close by restating** that no account, login or demo credentials are
   involved, and that the only thing crossing the network is a room code and a
   playback position.

Attach the file under **App Review Information → Attachment** on the version
page. The review notes in `store/listing.md` already tell the reviewer it is
there, so if you do not attach it, fix that text.

---

## Uploading

App previews cannot be uploaded through the App Store Connect API, so this one is
manual: the version page, the same box the screenshots are in, **Choose File**.
Drop the preview there and set the poster frame when it prompts.
