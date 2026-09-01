// The sync engine. Transport-agnostic: it is handed a `send` function and fed
// inbound messages, so it can be unit-tested with no browser and no socket.
//
// THE TIMEBASE
// Neither peer's wall clock is trustworthy; this Mac measured 111ms of offset
// against Cloudflare's edge, which would be 111ms of permanent desync if
// ignored. So nobody's local clock is ever compared to anybody else's. Each peer
// runs an NTP-style handshake against the Durable Object and every position is
// expressed in DO time. Two peers who each know their offset to the DO thereby
// know their offset to each other, without ever talking clocks directly.
//
// We keep the LOWEST-RTT sample rather than the median. A round trip can only be
// inflated by queueing, never deflated, so the fastest sample of a batch is the
// least contaminated one. This is what NTP itself does.
//
// THE CONTROL LAW
// The reference is the SLOWEST peer, not a designated host. That makes the
// controller slowdown-only: whoever is ahead eases off, and the laggard is never
// asked to skip. The pleasant consequence is that no viewer is ever made to miss
// content in order to stay in sync, which a speed-up-the-laggard design cannot
// promise.
//
//   |err| < DEADBAND          nothing (hysteresis: exits lower than it enters)
//   DEADBAND..NUDGE_ENTER     nothing, but stay in whatever state we were in
//   NUDGE_ENTER..AHEAD_HOLD   proportional slowdown, capped at 5%
//   ahead by > AHEAD_HOLD     hold: pause and let them catch up
//   behind by > BEHIND_SEEK   emergency seek; only reachable if a peer is wedged
//
// An explicit peer seek bypasses all of it, because that is intent, not drift.

(() => {
  'use strict';

  const { TUNING, clamp } = globalThis.WatchalongShared;

  const AHEAD_HOLD_S = TUNING.SEEK_S;
  const BEHIND_SEEK_S = 10;

  function create({ send, onStatus, media }) {
    const state = {
      selfId: null,
      room: null,
      // clock
      offset: 0, // add to local Date.now() to get DO time
      rtt: null,
      samples: [],
      pending: new Map(), // t0 -> local send time
      // peers
      peers: new Map(),
      // shared intent, last writer wins
      intentPaused: true,
      baseRate: 1,
      // local
      nudge: 0, // current fractional rate correction, <= 0
      holding: false, // paused by us because we were too far ahead
      aligned: false, // has this session done its one-time hard alignment
      lastApply: 0,
      lastPush: 0,
      lastPing: 0,
      pingCount: 0,
      // DO time of our last local seek; peer reports older than this are stale.
      seekedAt: 0,
      seq: 0,
      fingerprint: null,
      connected: false,
    };

    const nowLocal = () => Date.now();
    const nowServer = () => Date.now() + state.offset;

    // ------------------------------------------------------------------ clock

    function sendPing() {
      const t0 = nowLocal();
      state.pending.set(t0, t0);
      state.lastPing = t0;
      state.pingCount += 1;
      send({ t: 'ping', t0 });
    }

    /**
     * Keep re-measuring the clock for as long as the session lasts.
     *
     * Calibrating once at connect and trusting it forever is a trap: those
     * samples are taken during connection setup, which is the most congested
     * moment of the whole session, and a single bad batch then biases every
     * position comparison until the tab closes. Measured here, three
     * setup-time samples locked in 75ms of error, which is more than the
     * entire deadband. Re-pinging lets a better sample win later, and also
     * catches genuine clock drift over a feature-length film.
     */
    function maybePing() {
      const since = nowLocal() - state.lastPing;
      // Dense early so a usable offset exists within seconds, sparse after.
      const interval = state.pingCount < 6 ? 2000 : TUNING.PING_INTERVAL_MS;
      if (since >= interval) sendPing();
    }

    /**
     * We cannot synchronise tighter than we can measure. A round trip of R
     * bounds the offset error at roughly R/2, so on a slow link the deadband
     * relaxes to match rather than sending the controller hunting for a target
     * it has no ability to see.
     */
    function effectiveDeadband() {
      const uncertainty = state.rtt === null ? 0 : state.rtt / 2000;
      return Math.max(TUNING.DEADBAND_S, uncertainty);
    }

    function onPong(msg) {
      const t0 = state.pending.get(msg.t0);
      if (t0 === undefined) return;
      state.pending.delete(msg.t0);
      const t2 = nowLocal();
      const rtt = t2 - t0;
      // offset = server time minus the midpoint of our send/receive pair
      const offset = msg.t1 - (t0 + t2) / 2;
      state.samples.push({ rtt, offset });
      if (state.samples.length > TUNING.CLOCK_SAMPLES) state.samples.shift();
      const best = state.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      state.offset = best.offset;
      state.rtt = best.rtt;
    }

    // ------------------------------------------------------------- projection

    /**
     * Whether the shared timebase exists yet.
     *
     * Until a single pong has landed, `offset` is 0, which silently means "this
     * peer's wall clock IS server time". For a machine whose clock is off by
     * seconds that is not a small error, it is a seconds-long seek to the wrong
     * place, performed confidently. Every position comparison is gated on this.
     */
    const hasClock = () => state.samples.length > 0;

    /** Where a peer is *now*, in its own media timeline, in DO time. */
    function project(p) {
      if (!p) return null;
      // A buffering peer is as stationary as a paused one. Extrapolating it
      // forward invents progress it is not making, and the phantom position
      // runs further away for as long as the stall lasts.
      if (p.paused || p.buffering) return p.pos;
      const elapsed = (nowServer() - p.srv) / 1000;
      if (elapsed < 0) return p.pos; // clock still settling
      return p.pos + elapsed * (p.rate || 1);
    }

    function livePeers() {
      const cutoff = nowLocal() - TUNING.PEER_STALE_MS;
      const out = [];
      for (const [id, p] of state.peers) {
        if (p.seenAt < cutoff) continue;
        out.push({ id, ...p });
      }
      return out;
    }

    /** Peers that are on the same video as us. */
    function matchedPeers() {
      if (!state.fingerprint) return [];
      return livePeers().filter((p) => p.media && p.media === state.fingerprint);
    }

    // ------------------------------------------------------------------ output

    function push(cause) {
      const snap = media.snapshot();
      if (!snap || !state.connected) return;
      state.lastPush = nowLocal();
      state.seq += 1;
      send({
        t: 'state',
        pos: snap.pos,
        // Report the AGREED rate, not the nudged one. A peer must not treat our
        // drift correction as a rate change to imitate, or two controllers chase
        // each other's corrections and the pair oscillates.
        rate: state.baseRate,
        paused: state.intentPaused,
        buffering: snap.buffering,
        media: state.fingerprint,
        seq: state.seq,
        cause: cause || null,
      });
    }

    // ------------------------------------------------------------------ inputs

    function handleMessage(msg) {
      switch (msg.t) {
        case 'welcome':
          state.selfId = msg.id;
          state.connected = true;
          state.samples = [];
          for (let i = 0; i < 3; i++) sendPing();
          push('hello');
          report();
          return;

        case 'pong':
          onPong(msg);
          report();
          return;

        case 'peer-join':
          // A newcomer has no idea where we are; tell it immediately rather than
          // making it wait for the heartbeat.
          push('hello');
          report();
          return;

        case 'peer-leave':
          state.peers.delete(msg.id);
          if (!state.peers.size) {
            state.aligned = false;
            releaseHold();
          }
          report();
          return;

        case 'state':
          onPeerState(msg);
          return;
      }
    }

    function onPeerState(msg) {
      const prev = state.peers.get(msg.id);
      state.peers.set(msg.id, {
        pos: msg.pos,
        rate: msg.rate || 1,
        paused: !!msg.paused,
        buffering: !!msg.buffering,
        media: msg.media || null,
        srv: msg.srv,
        seenAt: nowLocal(),
      });

      if (!state.fingerprint || msg.media !== state.fingerprint) {
        report();
        return; // different video: never act on it
      }

      // Explicit intent from the peer, last writer wins.
      if (msg.cause === 'play' || msg.cause === 'pause') {
        state.intentPaused = msg.cause === 'pause';
        if (!state.intentPaused) releaseHold();
      }
      if (msg.cause === 'rate' && msg.rate > 0.05) {
        state.baseRate = msg.rate;
        state.nudge = 0;
      }

      // A seek is intent, not drift; match it exactly and immediately. Both this
      // and the first-contact alignment need the clock, so they wait for it;
      // tick() picks up an alignment that was deferred here.
      if (hasClock() && (msg.cause === 'seek' || !state.aligned)) {
        const target = project(state.peers.get(msg.id));
        if (Number.isFinite(target)) {
          media.applySeek(target);
          state.aligned = true;
          state.lastApply = nowLocal();
          releaseHold();
        }
      }

      applyIntent();
      report();
      if (!prev) push('hello'); // first sight of this peer, make sure it sees us
    }

    /** A genuine local user action on the video element. */
    function localAction(kind) {
      const snap = media.snapshot();
      if (!snap) return;

      if (kind === 'play') {
        state.intentPaused = false;
        releaseHold();
        push('play');
      } else if (kind === 'pause') {
        // A human pause during a buffer hold must stick, so it overwrites the
        // shared intent rather than being treated as the hold.
        state.intentPaused = true;
        state.holding = false;
        push('pause');
      } else if (kind === 'seek') {
        state.aligned = true;
        releaseHold();
        // Everything a peer has told us so far describes where it was before
        // this jump. Stop believing any of it until it has had a round trip.
        state.seekedAt = nowServer();
        push('seek');
      } else if (kind === 'rate') {
        // Back out our own active correction so a 5% nudge does not slowly
        // ratchet the agreed rate downward every time the user touches speed.
        const observed = snap.rate;
        state.baseRate = clamp(observed / (1 + state.nudge), 0.0625, 16);
        state.nudge = 0;
        push('rate');
      }
      report();
    }

    function setFingerprint(fp) {
      if (state.fingerprint === fp) return;
      state.fingerprint = fp;
      state.aligned = false; // new media, re-align from scratch
      state.nudge = 0;
      state.seekedAt = 0;
      releaseHold();
      push('media');
      report();
    }

    // ------------------------------------------------------------- the control

    function releaseHold() {
      state.holding = false;
    }

    /** Anyone stalled means everyone waits. */
    function bufferHold() {
      if (media.isBuffering()) return true;
      return matchedPeers().some((p) => p.buffering && !p.paused);
    }

    function applyIntent() {
      const shouldPause = state.intentPaused || bufferHold() || state.holding;
      media.applyPaused(shouldPause);
      return shouldPause;
    }

    function tick() {
      if (!state.connected) return;

      maybePing();

      const snap = media.snapshot();
      if (!snap) return;

      if (nowLocal() - state.lastPush >= TUNING.HEARTBEAT_MS) push(null);

      const peers = matchedPeers();
      if (!peers.length) {
        // Alone, or everyone is on a different video: stop correcting and hand
        // the video back to the user at the agreed rate.
        if (state.nudge !== 0) {
          state.nudge = 0;
          media.applyRate(state.baseRate);
        }
        releaseHold();
        report();
        return;
      }

      // No shared timebase yet means no opinion about position. Sit still rather
      // than act on a comparison we know to be meaningless.
      if (!hasClock()) {
        applyIntent();
        report();
        return;
      }

      // First contact, or an alignment deferred while the clock was settling.
      if (!state.aligned) {
        const ref0 = referencePosition(peers);
        if (ref0 !== null) {
          media.applySeek(ref0);
          state.aligned = true;
          state.lastApply = nowLocal();
          releaseHold();
        }
        applyIntent();
        report();
        return;
      }

      const paused = applyIntent();

      if (paused) {
        const ref = referencePosition(peers);
        // Line up precisely, but only when the reference is actually stationary.
        // A paused viewer sees no motion, so a seek here is invisible and free,
        // which makes it the best moment in the whole session to be exact. If
        // the peer is still playing we are merely holding for them, and chasing
        // a moving target with a seek every tick would just churn the buffer.
        const peersMoving = peers.some((p) => !p.paused && !p.buffering);
        if (!peersMoving && ref !== null && Math.abs(ref - snap.pos) > TUNING.PAUSED_ALIGN_S) {
          media.applySeek(ref);
          state.lastApply = nowLocal();
        }
        // If we were only holding because we ran ahead, release once they arrive.
        if (state.holding && ref !== null && snap.pos - ref <= effectiveDeadband()) {
          releaseHold();
        }
        if (state.nudge !== 0) {
          state.nudge = 0;
          media.applyRate(state.baseRate);
        }
        report();
        return;
      }

      // Do not react to our own still-settling correction.
      if (nowLocal() - state.lastApply < TUNING.SETTLE_MS) return;

      const ref = referencePosition(peers);
      if (ref === null) return;

      const err = ref - snap.pos; // negative: we are ahead of the slowest peer

      if (err < -AHEAD_HOLD_S) {
        // Far ahead. Hold rather than seek backwards; replaying footage the
        // viewer just watched is more jarring than a brief pause.
        state.holding = true;
        state.nudge = 0;
        media.applyRate(state.baseRate);
        applyIntent();
        state.lastApply = nowLocal();
        report();
        return;
      }

      if (err > BEHIND_SEEK_S) {
        // Only reachable if a peer is wedged well beyond a normal stall.
        media.applySeek(ref);
        state.lastApply = nowLocal();
        report();
        return;
      }

      updateNudge(err, snap);
      report();
    }

    /**
     * The slowest matched peer's projected position, or null.
     *
     * Reports predating our own last seek are discarded. After a big jump the
     * peer is still at the old position for one round trip, and treating that
     * as truth makes us conclude we are minutes ahead and slam on the hold.
     * A report is only evidence if it could have been made after seeing us move.
     */
    function referencePosition(peers) {
      let min = null;
      for (const p of peers) {
        if (state.seekedAt && p.srv < state.seekedAt) continue;
        const proj = project(p);
        if (!Number.isFinite(proj)) continue;
        if (min === null || proj < min) min = proj;
      }
      return min;
    }

    function updateNudge(err, snap) {
      const ahead = -err; // positive when we are ahead
      const dead = effectiveDeadband();
      // The entry threshold tracks the deadband so the hysteresis gap survives
      // on a slow link; a fixed 0.12 would sit *below* the deadband once RTT
      // passes 240ms, collapsing the hysteresis and making the rate flap.
      const enter = Math.max(TUNING.NUDGE_ENTER_S, dead * 2);
      let next;

      if (ahead <= dead) {
        next = 0; // hysteresis: we only leave the band well inside it
      } else if (ahead < enter) {
        next = state.nudge; // between the thresholds, hold current correction
      } else {
        next = -clamp(ahead * TUNING.GAIN, 0, TUNING.MAX_NUDGE);
      }

      if (Math.abs(next - state.nudge) < 1e-4) return;
      state.nudge = next;
      const target = state.baseRate * (1 + state.nudge);
      // Guard against a snapshot taken mid-write racing the applied value.
      if (Math.abs(snap.rate - target) > 1e-3) media.applyRate(target);
    }

    // ------------------------------------------------------------------ status

    function report() {
      if (!onStatus) return;
      const peers = matchedPeers();
      const ref = peers.length ? referencePosition(peers) : null;
      const snap = media.snapshot();
      onStatus({
        connected: state.connected,
        room: state.room,
        peerCount: livePeers().length,
        matchedCount: peers.length,
        mismatched: livePeers().length > peers.length,
        rtt: state.rtt,
        offset: Math.round(state.offset),
        drift: ref !== null && snap ? +(snap.pos - ref).toFixed(3) : null,
        nudge: state.nudge,
        holding: state.holding,
        waiting: bufferHold(),
        paused: state.intentPaused,
        baseRate: state.baseRate,
        aligned: state.aligned,
      });
    }

    function reset() {
      state.connected = false;
      state.peers.clear();
      state.samples = [];
      state.pending.clear();
      state.aligned = false;
      state.nudge = 0;
      state.seekedAt = 0;
      releaseHold();
      report();
    }

    return {
      state,
      handleMessage,
      localAction,
      setFingerprint,
      tick,
      sendPing,
      push,
      reset,
      report,
      // exposed for tests
      project,
      referencePosition,
      matchedPeers,
    };
  }

  globalThis.WatchalongSync = { create };
})();
