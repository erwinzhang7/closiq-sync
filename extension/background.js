// Socket owner and frame arbiter.
//
// WHY THE SOCKET LIVES HERE
// A WebSocket opened from a content script is subject to the page's own CSP
// `connect-src`, and plenty of streaming sites ship a restrictive one. It also
// dies on every SPA navigation. The background page has neither problem.
//
// WHY THIS DOES NOT DEPEND ON THE BACKGROUND PAGE STAYING ALIVE
// Safari suspends non-persistent background pages, and the usual answer is a
// keepalive port. We hold one, but we do not RELY on it: the room is persisted
// to storage, and a revived background page reconnects and re-announces from
// scratch the moment a content script talks to it. Teardown therefore costs a
// reconnect, not a broken session. Building it the other way around would mean
// the whole app rests on an undocumented lifetime guarantee.
//
// FRAME ARBITRATION
// The content script runs in every frame, because embedded players are iframes.
// Exactly one frame may drive the session, or two engines fight over one room.
// Frames announce whether they hold a real video; the first qualifying claimant
// wins and the rest stand down until it goes away.

(() => {
  'use strict';

  const { DEFAULTS, TUNING, isValidCode, normalizeCode } = globalThis.ClosiqSyncShared;

  let cfg = { ...DEFAULTS };
  let ws = null;
  let socketState = 'idle'; // idle | connecting | open | retrying
  let retryAt = 0;
  let retryDelay = TUNING.RECONNECT_BASE_MS;
  let retryTimer = 0;
  let lastError = null;

  const ports = new Set(); // every connected content frame
  let activePort = null; // the one frame allowed to drive
  let lastStatus = null;

  // A per-connection identity. Random rather than persisted: it identifies a
  // session, not a person, and nothing should survive a rejoin.
  let clientId = null;

  const newClientId = () =>
    [...crypto.getRandomValues(new Uint8Array(8))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  // ------------------------------------------------------------------ storage

  async function loadCfg() {
    try {
      const got = await api.storage.local.get(Object.keys(DEFAULTS));
      cfg = { ...DEFAULTS, ...got };
    } catch {
      cfg = { ...DEFAULTS };
    }
    return cfg;
  }

  async function saveCfg(patch) {
    cfg = { ...cfg, ...patch };
    try {
      await api.storage.local.set(patch);
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------- socket

  function socketUrl(room) {
    const base = (cfg.endpoint || DEFAULTS.endpoint).replace(/\/$/, '');
    return `${base.replace(/^http/, 'ws')}/room/${room}`;
  }

  function connect() {
    if (!cfg.room) return;
    if (ws && (socketState === 'open' || socketState === 'connecting')) return;

    clearTimeout(retryTimer);
    socketState = 'connecting';
    lastError = null;
    clientId = clientId || newClientId();
    broadcastStatus();

    let sock;
    try {
      sock = new WebSocket(socketUrl(cfg.room));
    } catch (e) {
      lastError = String(e && e.message ? e.message : e);
      return scheduleRetry();
    }
    ws = sock;

    sock.addEventListener('open', () => {
      if (ws !== sock) return;
      socketState = 'open';
      retryDelay = TUNING.RECONNECT_BASE_MS;
      sendRaw({ t: 'hello', id: clientId });
      broadcastStatus();
    });

    sock.addEventListener('message', (e) => {
      if (ws !== sock) return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      // Straight through to the driving frame; the engine lives there because it
      // needs sub-frame timing against the video element.
      if (activePort) post(activePort, { t: 'net', msg });
    });

    sock.addEventListener('close', (e) => {
      if (ws !== sock) return;
      ws = null;
      if (e.code === 1008 || e.code === 1009) lastError = e.reason || 'rejected';
      if (activePort) post(activePort, { t: 'reset' });
      if (cfg.room) scheduleRetry();
      else {
        socketState = 'idle';
        broadcastStatus();
      }
    });

    sock.addEventListener('error', () => {
      if (ws !== sock) return;
      lastError = 'connection failed';
    });
  }

  function scheduleRetry() {
    socketState = 'retrying';
    retryAt = Date.now() + retryDelay;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, TUNING.RECONNECT_MAX_MS);
    broadcastStatus();
  }

  function disconnect() {
    clearTimeout(retryTimer);
    const sock = ws;
    ws = null;
    socketState = 'idle';
    retryDelay = TUNING.RECONNECT_BASE_MS;
    if (sock && sock.readyState === WebSocket.OPEN) {
      try {
        sock.send(JSON.stringify({ t: 'bye' }));
      } catch {
        /* ignore */
      }
    }
    try {
      sock && sock.close();
    } catch {
      /* ignore */
    }
    if (activePort) post(activePort, { t: 'reset' });
  }

  function sendRaw(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------- ports

  function post(port, msg) {
    try {
      port.postMessage(msg);
    } catch {
      /* the frame went away between the check and the send */
    }
  }

  function elect() {
    if (activePort && ports.has(activePort) && activePort.__closiqsync?.hasVideo) return;

    const previous = activePort;
    // Prefer a frame in the focused tab, then any frame holding a real video.
    const claimants = [...ports].filter((p) => p.__closiqsync?.hasVideo);
    claimants.sort((a, b) => (b.__closiqsync.claimedAt || 0) - (a.__closiqsync.claimedAt || 0));
    activePort = claimants[0] || null;

    if (previous && previous !== activePort && ports.has(previous)) {
      post(previous, { t: 'role', active: false });
    }
    if (activePort && activePort !== previous) {
      post(activePort, { t: 'role', active: true, room: cfg.room });
      // A newly promoted frame has no session state, so make the socket
      // re-announce us rather than waiting for a heartbeat from the far side.
      if (socketState === 'open') sendRaw({ t: 'hello', id: clientId });
    }
    broadcastStatus();
  }

  api.runtime.onConnect.addListener((port) => {
    if (port.name !== 'closiqsync') return;
    port.__closiqsync = { hasVideo: false, claimedAt: 0 };
    ports.add(port);

    port.onDisconnect.addListener(() => {
      ports.delete(port);
      if (activePort === port) activePort = null;
      elect();
      // Nobody left to drive: drop the socket rather than hold a room open for
      // a tab that has closed.
      if (!ports.size) disconnect();
    });

    port.onMessage.addListener(async (msg) => {
      switch (msg.t) {
        case 'claim':
          port.__closiqsync.hasVideo = !!msg.hasVideo;
          port.__closiqsync.claimedAt = Date.now();
          elect();
          // A revived background page learns the room from storage here, which
          // is what makes teardown survivable.
          if (cfg.room && socketState === 'idle') connect();
          post(port, { t: 'role', active: port === activePort, room: cfg.room });
          break;

        case 'net':
          if (port !== activePort) return;
          sendRaw(msg.msg);
          break;

        case 'status':
          if (port !== activePort) return;
          lastStatus = msg.status;
          broadcastStatus();
          break;
      }
    });
  });

  // -------------------------------------------------------------------- popup

  function publicState() {
    return {
      room: cfg.room,
      endpoint: cfg.endpoint,
      socket: socketState,
      error: lastError,
      retryIn: socketState === 'retrying' ? Math.max(0, retryAt - Date.now()) : 0,
      hasDriver: !!activePort,
      frames: ports.size,
      sync: lastStatus,
    };
  }

  function broadcastStatus() {
    // Popups come and go; a failed send just means nobody is looking.
    try {
      api.runtime.sendMessage({ t: 'closiqsync-state', state: publicState() }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.t) return;

    if (msg.t === 'get-state') {
      sendResponse(publicState());
      return true;
    }

    if (msg.t === 'create-room') {
      (async () => {
        try {
          const base = (cfg.endpoint || DEFAULTS.endpoint).replace(/\/$/, '');
          const res = await fetch(`${base}/new`, { cache: 'no-store' });
          if (!res.ok) throw new Error(`server said ${res.status}`);
          const { code } = await res.json();
          if (!isValidCode(code)) throw new Error('server returned a bad code');
          await join(code);
          sendResponse({ ok: true, code });
        } catch (e) {
          lastError = String(e && e.message ? e.message : e);
          broadcastStatus();
          sendResponse({ ok: false, error: lastError });
        }
      })();
      return true;
    }

    if (msg.t === 'join-room') {
      (async () => {
        const code = normalizeCode(msg.code);
        if (!isValidCode(code)) {
          sendResponse({ ok: false, error: 'That is not a valid room code.' });
          return;
        }
        await join(code);
        sendResponse({ ok: true, code });
      })();
      return true;
    }

    if (msg.t === 'leave-room') {
      (async () => {
        disconnect();
        clientId = null;
        lastStatus = null;
        await saveCfg({ room: null });
        broadcastStatus();
        sendResponse({ ok: true });
      })();
      return true;
    }

    if (msg.t === 'set-endpoint') {
      (async () => {
        const endpoint = String(msg.endpoint || '').trim() || DEFAULTS.endpoint;
        disconnect();
        await saveCfg({ endpoint });
        if (cfg.room) connect();
        sendResponse({ ok: true, endpoint });
      })();
      return true;
    }
  });

  async function join(code) {
    disconnect();
    clientId = newClientId();
    lastStatus = null;
    retryDelay = TUNING.RECONNECT_BASE_MS;
    await saveCfg({ room: code });
    connect();
  }

  // ----------------------------------------------------------------- lifecycle

  loadCfg().then(() => {
    // Do not dial on load. A revived background page has no idea whether any tab
    // still wants the room; the first `claim` from a content frame is the signal
    // that someone does.
    broadcastStatus();
  });
})();
