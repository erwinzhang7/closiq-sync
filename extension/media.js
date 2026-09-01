// The media layer: find the video, read it, and write to it without the write
// coming back as a user action.
//
// Discovery is lifted from Speedup and works the same way: capture-phase media
// listeners on `document`. Media events do not bubble, but capture descends from
// the root, so one listener sees every current video, every future video, and
// videos inside open shadow roots (media events are composed, so
// composedPath()[0] is the real element). A subtree MutationObserver would fire
// thousands of times a minute on YouTube for the same information.
//
// The part that is new here, and the part that decides whether a sync app works
// at all, is echo suppression across THREE properties instead of one.
//
// The failure mode: you seek, I receive it and write currentTime, my write fires
// `seeked`, I report that to you as a fresh user seek, you write it back, and the
// two of us ring forever. Speedup already had to solve this for playbackRate. The
// same shape of fix generalises, but each property needs a different notion of
// "this event is mine", because they settle on very different timescales:
//
//   paused   fires within a tick, so a short TTL is enough.
//   rate     same, and a same-value assignment fires nothing at all.
//   position may not settle for seconds on a cold network stream, so a TTL alone
//            is unusable. It matches on proximity to the requested target, with a
//            generous TTL only as a backstop against a seek that never lands.

(() => {
  'use strict';

  const { clamp } = globalThis.ClosiqSyncShared;

  const EPS = 1e-3;
  const PAUSE_ECHO_MS = 900;
  const RATE_ECHO_MS = 900;
  const SEEK_ECHO_MS = 8000; // backstop only; matching is by proximity
  const SEEK_MATCH_S = 0.75; // a landed seek this close to target is ours
  const MIN_W = 200;
  const MIN_H = 150;

  const now = () => performance.now();

  const media = new Set();
  const pauseEcho = new WeakMap(); // v -> [{paused, at}]
  const rateEcho = new WeakMap(); // v -> [{rate, at}]
  const seekEcho = new WeakMap(); // v -> {target, at}

  let handlers = { onUserAction() {}, onBufferChange() {}, onPresence() {} };
  let started = false;
  let buffering = false;

  // ------------------------------------------------------------------ registry

  function track(v) {
    if (!media.has(v)) media.add(v);
  }

  function liveMedia() {
    for (const v of media) if (!v.isConnected) media.delete(v);
    return [...media];
  }

  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

  // Gate on a real, watchable video. Without this an invisible 1px autoplay ad
  // video on a news site would present itself as the thing to synchronise.
  function qualifies(v) {
    if (!v || !v.isConnected || v.readyState < 1) return false;
    if (fsElement() === v) return true;
    const r = v.getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H) return false;
    return v.duration > 5 || !v.paused;
  }

  function primary() {
    const all = liveMedia().filter(qualifies);
    if (!all.length) return null;
    const fs = fsElement();
    const inFs = all.find((v) => v === fs || (fs && fs.contains(v)));
    if (inFs) return inFs;
    const area = (v) => {
      const r = v.getBoundingClientRect();
      return r.width * r.height;
    };
    const playing = all.filter((v) => !v.paused && !v.ended);
    return (playing.length ? playing : all).sort((a, b) => area(b) - area(a))[0];
  }

  const hasVideo = () => liveMedia().some(qualifies);

  // ------------------------------------------------------------------- echoes

  function pushToken(map, v, token) {
    const list = map.get(v) || [];
    list.push({ ...token, at: now() });
    map.set(v, list);
  }

  function takeToken(map, v, ttl, match) {
    const list = map.get(v);
    if (!list || !list.length) return false;
    const t = now();
    while (list.length && t - list[0].at > ttl) list.shift();
    const i = list.findIndex(match);
    if (i === -1) return false;
    list.splice(i, 1);
    return true;
  }

  const isPauseEcho = (v, paused) =>
    takeToken(pauseEcho, v, PAUSE_ECHO_MS, (tok) => tok.paused === paused);

  const isRateEcho = (v, rate) =>
    takeToken(rateEcho, v, RATE_ECHO_MS, (tok) => Math.abs(tok.rate - rate) < EPS);

  // Position cannot use a plain TTL: on a cold stream `seeked` can arrive
  // seconds after the assignment, long after any sane TTL would have expired,
  // and the resulting phantom "user seek" is exactly the loop we are avoiding.
  // Proximity to the requested target is the reliable signal.
  function isSeekEcho(v, pos) {
    const tok = seekEcho.get(v);
    if (!tok) return false;
    if (now() - tok.at > SEEK_ECHO_MS) {
      seekEcho.delete(v);
      return false;
    }
    if (Math.abs(pos - tok.target) > SEEK_MATCH_S) return false;
    seekEcho.delete(v);
    return true;
  }

  // -------------------------------------------------------------------- writes

  function applyPitch(v) {
    // Safari 26.6 has `preservesPitch`; the webkit-prefixed alias is GONE, and
    // writing it would silently create a meaningless expando. Feature-detect the
    // real one only. Without this a 5% nudge shifts pitch audibly on speech.
    if ('preservesPitch' in v) {
      try {
        v.preservesPitch = true;
      } catch {
        /* ignore */
      }
    }
  }

  function applyRate(rate, v = primary()) {
    if (!v || !v.isConnected) return false;
    applyPitch(v);
    // Per spec a same-value assignment fires no ratechange at all, so the value
    // guard alone terminates the loop; the token is belt and braces.
    if (Math.abs(v.playbackRate - rate) < EPS) return true;
    pushToken(rateEcho, v, { rate });
    // defaultPlaybackRate fires its OWN ratechange, so it needs its own token.
    if (Math.abs(v.defaultPlaybackRate - rate) >= EPS) {
      pushToken(rateEcho, v, { rate });
      try {
        v.defaultPlaybackRate = rate;
      } catch {
        /* ignore */
      }
    }
    try {
      v.playbackRate = rate;
    } catch {
      return false;
    }
    return true;
  }

  function applySeek(pos, v = primary()) {
    if (!v || !v.isConnected || !Number.isFinite(pos)) return false;
    const target = clamp(pos, 0, Number.isFinite(v.duration) ? v.duration : pos);
    if (Math.abs(v.currentTime - target) < 0.01) return true;
    seekEcho.set(v, { target, at: now() });
    try {
      v.currentTime = target;
    } catch {
      seekEcho.delete(v);
      return false;
    }
    return true;
  }

  function applyPaused(paused, v = primary()) {
    if (!v || !v.isConnected) return false;
    if (v.paused === paused) return true;
    pushToken(pauseEcho, v, { paused });
    try {
      if (paused) {
        v.pause();
      } else {
        const p = v.play();
        // Autoplay policy can reject this. That is not an error we can fix, but
        // the caller needs to know the write did not take, or it will believe
        // the peer is playing when the tab is silently still paused.
        if (p && typeof p.catch === 'function') {
          p.catch(() => handlers.onPresence({ blocked: true }));
        }
      }
    } catch {
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------- events

  const LIFECYCLE = [
    'emptied',
    'loadstart',
    'durationchange',
    'loadedmetadata',
    'loadeddata',
    'canplay',
    'canplaythrough',
    'seeked',
    'play',
    'pause',
    'playing',
    'waiting',
    'stalled',
    'ratechange',
    'ended',
  ];

  function setBuffering(next) {
    if (buffering === next) return;
    buffering = next;
    handlers.onBufferChange(buffering);
  }

  function onMediaEvent(e) {
    const v = e.composedPath ? e.composedPath()[0] : e.target;
    if (!(v instanceof HTMLMediaElement)) return;
    track(v);
    if (!started) return;

    // Only the element we are actually syncing gets to drive state. A preroll ad
    // in a sibling element firing `play` must not be reported as the user
    // pressing play on the feature.
    if (v !== primary()) {
      if (e.type === 'loadedmetadata' || e.type === 'canplay') handlers.onPresence({});
      return;
    }

    switch (e.type) {
      case 'waiting':
      case 'stalled':
        setBuffering(true);
        return;

      case 'playing':
      case 'canplaythrough':
        setBuffering(false);
        return;

      case 'play':
        if (isPauseEcho(v, false)) return;
        handlers.onUserAction('play');
        return;

      case 'pause':
        if (isPauseEcho(v, true)) return;
        handlers.onUserAction('pause');
        return;

      case 'seeked':
        setBuffering(false);
        if (isSeekEcho(v, v.currentTime)) return;
        handlers.onUserAction('seek');
        return;

      case 'ratechange': {
        const rate = v.playbackRate;
        if (isRateEcho(v, rate)) return;
        // Junk rates are buffering garbage some players emit; never adopt them.
        if (rate <= 0.05) return;
        handlers.onUserAction('rate');
        return;
      }

      case 'ended':
        handlers.onUserAction('pause');
        return;

      case 'emptied':
      case 'loadstart':
        // A new resource in the same element (YouTube reuses the SAME <video>
        // across SPA navigation) invalidates every outstanding echo token; they
        // refer to media that no longer exists.
        pauseEcho.delete(v);
        rateEcho.delete(v);
        seekEcho.delete(v);
        setBuffering(false);
        handlers.onPresence({ reloaded: true });
        return;

      case 'loadedmetadata':
      case 'canplay':
        handlers.onPresence({});
        return;
    }
  }

  // ------------------------------------------------------------------ snapshot

  function snapshot() {
    const v = primary();
    if (!v) return null;
    return {
      pos: v.currentTime,
      paused: v.paused || v.ended,
      rate: v.playbackRate,
      buffering: buffering || v.readyState < 3,
      duration: Number.isFinite(v.duration) ? v.duration : null,
      ready: v.readyState,
    };
  }

  function start(h) {
    handlers = { ...handlers, ...h };
    if (started) return;
    started = true;
    for (const type of LIFECYCLE) {
      document.addEventListener(type, onMediaEvent, { capture: true, passive: true });
    }
  }

  globalThis.ClosiqSyncMedia = {
    start,
    primary,
    hasVideo,
    snapshot,
    applyRate,
    applySeek,
    applyPaused,
    applyPitch,
    isBuffering: () => buffering,
  };
})();
