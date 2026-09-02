/**
 * Headless two-peer simulation of the sync engine.
 *
 * Runs sync.js in two separate VM contexts so each peer gets its OWN Date.now(),
 * with a deliberate clock skew between them and against the relay. That is the
 * whole point: if the engine ever compares one peer's wall clock to another's,
 * these tests fail. A single shared clock would hide exactly the bug the NTP
 * handshake exists to prevent.
 *
 *   node extension/test/sim.mjs
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
// This file lives outside extension/ on purpose: anything under extension/ is
// copied verbatim into the shipping appex, and test code has no business in a
// submitted binary.
const read = (f) => fs.readFileSync(path.join(dir, '..', 'extension', f), 'utf8');
const SHARED = read('shared.js');
const SYNC = read('sync.js');

// Read from the source rather than duplicated, so the harness cannot silently
// drift from the protocol it is meant to be exercising.
const PROTOCOL_VERSION = Number(/PROTOCOL_VERSION = (\d+)/.exec(SHARED)[1]);

let simNow = 0; // the one true time; nobody in the system can see it
const LATENCY_MS = 35; // one way, peer <-> relay
const SERVER_SKEW = 0; // relay clock == sim clock by definition

let failures = 0;
const check = (cond, label, extra = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${extra ? ` -- ${extra}` : ''}`);
  }
};

// --------------------------------------------------------------- fake video

function makeVideo({ pos = 0, paused = true } = {}) {
  return {
    pos,
    paused,
    rate: 1,
    buffering: false,
    duration: 7200,
    rateWrites: 0,
    seeks: 0,

    step(dt) {
      if (!this.paused && !this.buffering) this.pos += (dt / 1000) * this.rate;
    },

    // --- the ClosiqSyncMedia surface the engine depends on ---
    snapshot() {
      return {
        pos: this.pos,
        paused: this.paused,
        rate: this.rate,
        buffering: this.buffering,
        duration: this.duration,
        ready: 4,
      };
    },
    applyRate(r) {
      if (Math.abs(this.rate - r) < 1e-6) return true;
      this.rate = r;
      this.rateWrites++;
      return true;
    },
    applySeek(p) {
      if (Math.abs(this.pos - p) < 0.01) return true;
      this.pos = p;
      this.seeks++;
      return true;
    },
    applyPaused(b) {
      this.paused = b;
      return true;
    },
    isBuffering() {
      return this.buffering;
    },
  };
}

// ------------------------------------------------------------------- relay

const wire = []; // {at, to, msg} -- `to` is a peer id, or RELAY for the uplink

const RELAY = '__relay';

function makeRelay(peers) {
  return {
    // Outbound from a peer. Crucially this takes LATENCY_MS to REACH the relay
    // as well as to come back: a harness that delivered uplink instantly would
    // halve every measured round trip and hand the clock code a free 17.5ms of
    // accuracy it does not have in reality.
    deliver(fromId, msg) {
      wire.push({ at: simNow + LATENCY_MS, to: RELAY, from: fromId, msg });
    },

    handle(fromId, msg) {
      const now = simNow;
      if (msg.t === 'ping') {
        // The relay stamps with ITS clock, which is what both peers calibrate to.
        wire.push({
          at: now + LATENCY_MS,
          to: fromId,
          msg: { t: 'pong', t0: msg.t0, t1: now + SERVER_SKEW },
        });
        return;
      }
      if (msg.t === 'hello') {
        wire.push({
          at: now + LATENCY_MS,
          to: fromId,
          msg: {
            t: 'welcome',
            id: fromId,
            peers: peers.filter((p) => p !== fromId),
            now,
            minProtocol: PROTOCOL_VERSION,
          },
        });
        for (const other of peers) {
          if (other === fromId) continue;
          wire.push({ at: now + LATENCY_MS, to: other, msg: { t: 'peer-join', id: fromId } });
        }
        return;
      }
      if (msg.t === 'state') {
        for (const other of peers) {
          if (other === fromId) continue;
          wire.push({
            at: now + LATENCY_MS,
            to: other,
            // The real relay stamps `v` from the sender's hello, not from the
            // frame, so peers cannot claim a different version per message.
            msg: { ...msg, id: fromId, v: PROTOCOL_VERSION, srv: now + SERVER_SKEW },
          });
        }
      }
    },
  };
}

// -------------------------------------------------------------------- peer

function makePeer(id, { skew, video }) {
  const ctx = vm.createContext({
    console,
    // Each peer's own wall clock, deliberately wrong by `skew` ms.
    Date: { now: () => simNow + skew },
    Math,
    Number,
    JSON,
    isNaN,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(SHARED, ctx);
  vm.runInContext(SYNC, ctx);

  const outbox = [];
  let status = null;

  const engine = ctx.ClosiqSyncEngine.create({
    media: video,
    send: (msg) => outbox.push(msg),
    onStatus: (s) => (status = s),
  });

  return {
    id,
    engine,
    video,
    outbox,
    get status() {
      return status;
    },
    tuning: ctx.ClosiqSyncShared.TUNING,
  };
}

// --------------------------------------------------------------- the harness

function run(label, { seconds, peers, relay, at = {} }) {
  const DT = 25;
  const end = simNow + seconds * 1000;
  let nextTick = simNow;

  while (simNow < end) {
    simNow += DT;

    const hook = at[Math.round((simNow - (end - seconds * 1000)) / 1000)];
    if (hook && !hook.__done) {
      hook.__done = true;
      hook(peers);
    }

    for (const p of peers) p.video.step(DT);

    // Flush anything that has arrived, in send order.
    for (let i = 0; i < wire.length; ) {
      if (wire[i].at > simNow) {
        i++;
        continue;
      }
      const { to, from, msg } = wire.splice(i, 1)[0];
      if (to === RELAY) {
        relay.handle(from, msg);
      } else {
        const peer = peers.find((p) => p.id === to);
        if (peer) peer.engine.handleMessage(msg);
      }
    }

    if (simNow >= nextTick) {
      nextTick += 250;
      for (const p of peers) p.engine.tick();
    }

    // Drain every step, not every tick. The real transport is a runtime port
    // that forwards immediately; holding messages until the next 250ms tick
    // would add queueing delay to the ping round trip and corrupt the clock
    // measurement with an artefact the production code does not have.
    for (const p of peers) {
      while (p.outbox.length) relay.deliver(p.id, p.outbox.shift());
    }
  }
}

// ============================================================== scenario 1
console.log('\n1. Two peers with skewed clocks converge, slowdown-only');
{
  simNow = 1_000_000;
  wire.length = 0;
  const va = makeVideo({ pos: 0, paused: false });
  const vb = makeVideo({ pos: 0, paused: false });
  // Peer B's wall clock is 4.2 seconds off. If the engine ever trusted it, the
  // pair would settle 4.2s apart and every check below would fail.
  const a = makePeer('a', { skew: -1300, video: va });
  const b = makePeer('b', { skew: 4200, video: vb });
  const relay = makeRelay(['a', 'b']);

  for (const p of [a, b]) {
    p.engine.setFingerprint('samevideo');
    p.engine.state.intentPaused = false;
    p.outbox.length = 0;
    relay.deliver(p.id, { t: 'hello', id: p.id });
  }

  run('settle', { seconds: 6, peers: [a, b], relay });
  const afterJoin = Math.abs(va.pos - vb.pos);
  check(afterJoin < 0.25, 'initial alignment brings them together', `${afterJoin.toFixed(3)}s apart`);

  // Now inject real drift: B jumps 0.45s ahead, as a stutter would leave it.
  vb.pos += 0.45;
  const rateWritesBefore = vb.rateWrites;
  const seeksBefore = va.seeks + vb.seeks;

  run('correct', { seconds: 40, peers: [a, b], relay });

  const gap = Math.abs(va.pos - vb.pos);
  check(gap < 0.06, 'drift corrected to inside the deadband', `${(gap * 1000).toFixed(0)}ms apart`);
  check(
    va.seeks + vb.seeks === seeksBefore,
    'corrected without a single seek',
    `${va.seeks + vb.seeks - seeksBefore} seeks`
  );
  check(
    vb.rateWrites > rateWritesBefore,
    'the ahead peer actually nudged its rate',
    `${vb.rateWrites - rateWritesBefore} writes`
  );
  check(va.rate <= 1.0001 && vb.rate <= 1.0001, 'never speeds up past 1.0x', `a=${va.rate} b=${vb.rate}`);
  check(va.rate >= 0.95 && vb.rate >= 0.95, 'never slows below 0.95x', `a=${va.rate} b=${vb.rate}`);

  // Oscillation check: once settled, the rate should stop moving.
  const settledWrites = vb.rateWrites;
  run('hold', { seconds: 20, peers: [a, b], relay });
  const churn = vb.rateWrites - settledWrites;
  check(churn <= 3, 'no oscillation once settled', `${churn} rate writes in 20s`);
  const finalGap = Math.abs(va.pos - vb.pos);
  check(finalGap < 0.06, 'still together after settling', `${(finalGap * 1000).toFixed(0)}ms`);
}

// ============================================================== scenario 2
console.log('\n2. Pause, play and seek propagate');
{
  simNow = 2_000_000;
  wire.length = 0;
  const va = makeVideo({ pos: 100, paused: false });
  const vb = makeVideo({ pos: 100, paused: false });
  const a = makePeer('a', { skew: 900, video: va });
  const b = makePeer('b', { skew: -2600, video: vb });
  const relay = makeRelay(['a', 'b']);
  for (const p of [a, b]) {
    p.engine.setFingerprint('samevideo');
    p.engine.state.intentPaused = false;
    p.outbox.length = 0;
    relay.deliver(p.id, { t: 'hello', id: p.id });
  }
  run('settle', { seconds: 5, peers: [a, b], relay });

  // A pauses.
  va.paused = true;
  a.engine.localAction('pause');
  while (a.outbox.length) relay.deliver('a', a.outbox.shift());
  run('after pause', { seconds: 3, peers: [a, b], relay });
  check(vb.paused, 'B pauses when A pauses');
  const bPos = vb.pos;
  run('stay paused', { seconds: 3, peers: [a, b], relay });
  check(Math.abs(vb.pos - bPos) < 0.05, 'B stays put while paused');

  // A plays again.
  va.paused = false;
  a.engine.localAction('play');
  while (a.outbox.length) relay.deliver('a', a.outbox.shift());
  run('after play', { seconds: 3, peers: [a, b], relay });
  check(!vb.paused, 'B resumes when A plays');

  // A seeks far away. This is intent, so it must be matched exactly, not nudged.
  va.pos = 3600;
  a.engine.localAction('seek');
  while (a.outbox.length) relay.deliver('a', a.outbox.shift());
  run('after seek', { seconds: 4, peers: [a, b], relay });
  check(Math.abs(vb.pos - va.pos) < 0.3, 'B follows a seek', `${(vb.pos - va.pos).toFixed(2)}s off`);
}

// ============================================================== scenario 3
console.log('\n3. Follow-the-laggard: a buffer stall holds the other peer');
{
  simNow = 3_000_000;
  wire.length = 0;
  const va = makeVideo({ pos: 500, paused: false });
  const vb = makeVideo({ pos: 500, paused: false });
  const a = makePeer('a', { skew: 0, video: va });
  const b = makePeer('b', { skew: 1500, video: vb });
  const relay = makeRelay(['a', 'b']);
  for (const p of [a, b]) {
    p.engine.setFingerprint('samevideo');
    p.engine.state.intentPaused = false;
    p.outbox.length = 0;
    relay.deliver(p.id, { t: 'hello', id: p.id });
  }
  run('settle', { seconds: 5, peers: [a, b], relay });

  // B stalls.
  vb.buffering = true;
  b.engine.push(null);
  while (b.outbox.length) relay.deliver('b', b.outbox.shift());
  run('during stall', { seconds: 4, peers: [a, b], relay });
  check(va.paused, 'A pauses while B buffers');
  check(!a.engine.state.intentPaused, 'A treats it as a hold, not a user pause');

  // B recovers.
  vb.buffering = false;
  b.engine.push(null);
  while (b.outbox.length) relay.deliver('b', b.outbox.shift());
  run('after stall', { seconds: 4, peers: [a, b], relay });
  check(!va.paused, 'A auto-resumes once B recovers');
  const gap = Math.abs(va.pos - vb.pos);
  check(gap < 0.35, 'still aligned after the stall', `${(gap * 1000).toFixed(0)}ms`);
}

// ============================================================== scenario 4
console.log('\n4. A human pause during a stall is not auto-undone');
{
  simNow = 4_000_000;
  wire.length = 0;
  const va = makeVideo({ pos: 10, paused: false });
  const vb = makeVideo({ pos: 10, paused: false });
  const a = makePeer('a', { skew: 0, video: va });
  const b = makePeer('b', { skew: 0, video: vb });
  const relay = makeRelay(['a', 'b']);
  for (const p of [a, b]) {
    p.engine.setFingerprint('samevideo');
    p.engine.state.intentPaused = false;
    p.outbox.length = 0;
    relay.deliver(p.id, { t: 'hello', id: p.id });
  }
  run('settle', { seconds: 4, peers: [a, b], relay });

  vb.buffering = true;
  b.engine.push(null);
  while (b.outbox.length) relay.deliver('b', b.outbox.shift());
  run('stall', { seconds: 2, peers: [a, b], relay });

  // While held for the buffer, the human at A deliberately hits pause.
  va.paused = true;
  a.engine.localAction('pause');
  while (a.outbox.length) relay.deliver('a', a.outbox.shift());

  vb.buffering = false;
  b.engine.push(null);
  while (b.outbox.length) relay.deliver('b', b.outbox.shift());
  run('recover', { seconds: 5, peers: [a, b], relay });

  check(va.paused, 'A stays paused because a human asked');
  check(vb.paused, 'B respects it too');
}

// ============================================================== scenario 5
console.log('\n5. Different videos are never acted on');
{
  simNow = 5_000_000;
  wire.length = 0;
  const va = makeVideo({ pos: 30, paused: false });
  const vb = makeVideo({ pos: 900, paused: false });
  const a = makePeer('a', { skew: 0, video: va });
  const b = makePeer('b', { skew: 0, video: vb });
  const relay = makeRelay(['a', 'b']);
  a.engine.setFingerprint('movie-one');
  b.engine.setFingerprint('movie-two');
  for (const p of [a, b]) {
    p.engine.state.intentPaused = false;
    p.outbox.length = 0;
    relay.deliver(p.id, { t: 'hello', id: p.id });
  }
  const seeksBefore = va.seeks + vb.seeks;
  run('apart', { seconds: 8, peers: [a, b], relay });

  check(va.seeks + vb.seeks === seeksBefore, 'nobody was dragged to the other video');
  check(Math.abs(va.pos - 38) < 0.5, 'A kept playing its own video normally');
  check(a.status && a.status.mismatched, 'A reports the mismatch to the UI');
}

// ============================================================== scenario 6
console.log('\n6. A peer on a different protocol version is never acted on');
{
  simNow = 6_000_000;
  wire.length = 0;
  const va = makeVideo({ pos: 100, paused: false });
  const a = makePeer('a', { skew: 0, video: va });
  const relay = makeRelay(['a']);
  a.engine.setFingerprint('samevideo');
  a.engine.state.intentPaused = false;
  a.outbox.length = 0;
  relay.deliver('a', { t: 'hello', id: 'a' });
  run('settle', { seconds: 3, peers: [a], relay });

  const seeksBefore = va.seeks;
  const posBefore = va.pos;

  // A future client, same video, wildly different position. If version were
  // ignored this would drag A four minutes down the timeline.
  for (let i = 0; i < 12; i++) {
    a.engine.handleMessage({
      t: 'state',
      id: 'future',
      v: PROTOCOL_VERSION + 1,
      srv: simNow,
      pos: 340,
      rate: 1,
      paused: false,
      buffering: false,
      media: 'samevideo',
      seq: i,
    });
    run('tick', { seconds: 1, peers: [a], relay });
  }

  check(va.seeks === seeksBefore, 'no seek toward the incompatible peer');
  check(
    Math.abs(va.pos - (posBefore + 12)) < 1.0,
    'A kept playing its own timeline',
    `${va.pos.toFixed(1)} vs ~${(posBefore + 12).toFixed(1)}`
  );
  check(!va.paused, 'A was not held by a peer it cannot understand');
  check(a.status && a.status.peerOutdated, 'A reports the version mismatch to the UI');
  check(a.status && a.status.matchedCount === 0, 'the incompatible peer is not counted as matched');
}

console.log(
  failures ? `\n${failures} check(s) FAILED\n` : '\nall simulation checks passed\n'
);
process.exit(failures ? 1 : 0);
