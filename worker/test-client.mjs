/**
 * Two-peer protocol smoke test against a running room server.
 *   node test-client.mjs ws://localhost:8787
 * Exercises: hello/welcome, peer-join, ping/pong clock offset, state relay,
 * sender-exclusion, and peer-leave.
 */
const base = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
const wsBase = base.replace(/^http/, 'ws');

const log = (...a) => console.log(...a);
const fail = (m) => {
  console.error('FAIL:', m);
  process.exitCode = 1;
};

const res = await fetch(`${base}/new`);
const { code } = await res.json();
if (!/^[ACDEFGHJKMNPQRTUVWXY34679]{6}$/.test(code || '')) fail(`bad code: ${code}`);
log('room code:', code);

function connect(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/room/${code}`);
    const inbox = [];
    const waiters = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      const w = waiters.findIndex((x) => x.pred(m));
      if (w >= 0) waiters.splice(w, 1)[0].resolve(m);
      else inbox.push(m);
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () =>
      resolve({
        ws,
        id,
        send: (o) => ws.send(JSON.stringify(o)),
        /** Resolve with the first message matching `pred`, buffered or future. */
        expect(pred, ms = 2000) {
          const hit = inbox.findIndex(pred);
          if (hit >= 0) return Promise.resolve(inbox.splice(hit, 1)[0]);
          return new Promise((resolve, rej) => {
            const t = setTimeout(() => rej(new Error(`timeout waiting: ${pred}`)), ms);
            waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
          });
        },
        idle: () => inbox.slice(),
      })
    );
  });
}

const a = await connect('peer-a');
const b = await connect('peer-b');

a.send({ t: 'hello', id: 'peer-a' });
const welcomeA = await a.expect((m) => m.t === 'welcome');
log('A welcome, peers:', welcomeA.peers);
if (welcomeA.peers.length !== 0) fail('A should see no named peers yet');

b.send({ t: 'hello', id: 'peer-b' });
const welcomeB = await b.expect((m) => m.t === 'welcome');
// peers is [{id, v}] since protocol versioning; a bare id list would not let a
// joiner tell a compatible peer from one it must refuse to be driven by.
const peerIds = (welcomeB.peers || []).map((p) => (typeof p === 'string' ? p : p.id));
if (!peerIds.includes('peer-a')) fail(`B should see peer-a, got ${JSON.stringify(welcomeB.peers)}`);
if (typeof welcomeB.minProtocol !== 'number') fail('welcome must carry minProtocol');
const va = (welcomeB.peers || [])[0];
if (!va || typeof va.v !== 'number') fail(`peer entries must carry v, got ${JSON.stringify(va)}`);
const join = await a.expect((m) => m.t === 'peer-join');
if (join.id !== 'peer-b') fail('A should be told peer-b joined');
log('join propagation ok');

// --- clock offset --------------------------------------------------------
const samples = [];
for (let i = 0; i < 8; i++) {
  const t0 = Date.now();
  a.send({ t: 'ping', t0 });
  const pong = await a.expect((m) => m.t === 'pong' && m.t0 === t0);
  const t2 = Date.now();
  samples.push({ rtt: t2 - t0, offset: pong.t1 - (t0 + t2) / 2 });
}
const best = samples.reduce((x, y) => (y.rtt < x.rtt ? y : x));
log(`clock: offset=${best.offset.toFixed(1)}ms rtt=${best.rtt}ms (of ${samples.length} samples)`);

// --- state relay ---------------------------------------------------------
a.send({ t: 'state', pos: 42.5, rate: 1, paused: false, media: 'abc123', seq: 1, cause: 'seek' });
const relayed = await b.expect((m) => m.t === 'state');
if (relayed.id !== 'peer-a') fail('relayed state should carry sender id');
if (relayed.pos !== 42.5) fail(`pos mangled: ${relayed.pos}`);
if (typeof relayed.srv !== 'number') fail('relay must be server-stamped');
if (relayed.cause !== 'seek') fail('cause dropped');
log('state relay ok, srv skew from local:', (relayed.srv - Date.now()).toFixed(0), 'ms');

if (a.idle().some((m) => m.t === 'state')) fail('sender must not receive its own state');
log('sender exclusion ok');

// --- rejections ----------------------------------------------------------
const bad = await fetch(`${base}/room/lowercase!`);
if (bad.status !== 400) fail(`bad code should 400, got ${bad.status}`);

// An anonymous socket (no hello) must not be able to relay.
const c = await connect('peer-c');
c.send({ t: 'state', pos: 999, paused: false });
await new Promise((r) => setTimeout(r, 300));
if (b.idle().some((m) => m.t === 'state' && m.pos === 999)) fail('anonymous state was relayed');
log('anonymous rejection ok');
c.ws.close();

// --- departure -----------------------------------------------------------
b.ws.close();
const leave = await a.expect((m) => m.t === 'peer-leave' && m.id === 'peer-b', 3000);
log('leave propagation ok:', leave.id);

a.ws.close();
log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nall checks passed');
