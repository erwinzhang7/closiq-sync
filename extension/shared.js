// Constants and pure helpers, loaded in every context (background, content, popup).

(() => {
  'use strict';

  // Kept as a single constant with a storage override so moving off workers.dev
  // later is a settings change rather than an App Store resubmission.
  const DEFAULT_ENDPOINT = 'https://closiqsync-rooms.erwinzhang.workers.dev';

  // Must match the server's alphabet exactly. Excludes every glyph that survives
  // being read aloud badly: 0/O, 1/I/L, 2/Z, 5/S, 8/B.
  const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
  const CODE_LENGTH = 6;
  const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

  const TUNING = {
    // --- drift controller ---------------------------------------------------
    // Below this we are, for human purposes, in sync. Exiting the correction
    // band lower than entering it is deliberate hysteresis; a single threshold
    // makes the rate flap around the boundary.
    DEADBAND_S: 0.06,
    NUDGE_ENTER_S: 0.12,
    // Above this, closing the gap by nudging would take longer than a viewer
    // will tolerate, so seek instead. Errors this large essentially only come
    // from a seek or a buffer stall, both of which want a hard correction.
    SEEK_S: 1.5,
    // Correction per second of error. At the 0.12s entry point this is a 1.8%
    // nudge; it saturates at MAX_NUDGE by ~0.33s.
    GAIN: 0.15,
    // 5% is inaudible with preservesPitch on and invisible to the eye. Going
    // higher makes speech sound hurried, which is worse than being 200ms apart.
    MAX_NUDGE: 0.05,
    // No correction for this long after we apply one, so the controller is not
    // reacting to its own still-settling seek.
    SETTLE_MS: 1200,
    TICK_MS: 250,
    // While everyone is stopped, a seek is invisible, so align far more tightly
    // than the playing deadband allows. Getting this right is what makes the
    // moment of resume look clean.
    PAUSED_ALIGN_S: 0.05,
    // Local state is pushed on every real event, plus this heartbeat so a peer
    // that missed a frame recovers without waiting for the next user action.
    HEARTBEAT_MS: 2000,

    // --- transport ----------------------------------------------------------
    PING_INTERVAL_MS: 15000,
    CLOCK_SAMPLES: 8,
    RECONNECT_BASE_MS: 500,
    RECONNECT_MAX_MS: 15000,
    // A peer that has said nothing for this long is treated as gone dark; we
    // stop projecting its position rather than extrapolating into fiction.
    PEER_STALE_MS: 12000,
  };

  const DEFAULTS = {
    endpoint: DEFAULT_ENDPOINT,
    room: null,
    autoRejoin: true,
  };

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const isValidCode = (s) => CODE_RE.test(normalizeCode(s));

  /**
   * A stable identity for "the thing being watched", so two peers can confirm
   * they are on the same video without either of them transmitting a URL.
   *
   * Only the parts that actually identify the media survive: origin, path, and
   * the handful of query keys that real players use as a video id. Tracking
   * junk (utm_*, YouTube's `t`, session ids) is dropped, so arriving from
   * different links still matches.
   */
  function mediaUrlKey(href) {
    let u;
    try {
      u = new URL(href);
    } catch {
      return String(href || '');
    }
    const KEEP = ['v', 'video_id', 'videoId', 'id', 'watch', 'clip'];
    const kept = [];
    for (const k of KEEP) {
      const val = u.searchParams.get(k);
      if (val) kept.push(`${k}=${val}`);
    }
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}${kept.length ? '?' + kept.join('&') : ''}`;
  }

  /**
   * Hash the media key before it leaves the machine. Peers only need to agree
   * they are on the same video, and equality of a digest proves that just as
   * well as equality of a URL, without the server ever seeing browsing history.
   */
  async function mediaFingerprint(href) {
    const key = mediaUrlKey(href);
    const bytes = new TextEncoder().encode(`closiqsync:v1:${key}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest).slice(0, 8)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  globalThis.ClosiqSyncShared = {
    DEFAULT_ENDPOINT,
    CODE_ALPHABET,
    CODE_LENGTH,
    CODE_RE,
    TUNING,
    DEFAULTS,
    clamp,
    normalizeCode,
    isValidCode,
    mediaUrlKey,
    mediaFingerprint,
  };
})();
