// Wiring: connects the media layer to the sync engine to the background socket,
// and draws the on-page HUD.
//
// This file runs in EVERY frame (embedded players are iframes), but only the
// frame the background elects actually drives. The rest sit idle holding a port
// so they can be promoted if the driver goes away.

(() => {
  'use strict';

  // The popup re-injects into tabs that predate the permission grant, and Safari
  // will happily end up with two copies of every listener without this.
  if (globalThis.__closiqsyncLoaded) return;
  globalThis.__closiqsyncLoaded = true;

  const { TUNING, mediaFingerprint } = globalThis.ClosiqSyncShared;
  const media = globalThis.ClosiqSyncMedia;

  let port = null;
  let engine = null;
  let active = false;
  let room = null;
  let tickTimer = 0;
  let claimed = null;
  let lastHref = location.href;
  let fingerprint = null;
  let lastHudKey = '';

  // ------------------------------------------------------------------ the port

  function openPort() {
    try {
      port = api.runtime.connect({ name: 'closiqsync' });
    } catch {
      // Background not reachable (extension updating); try again shortly.
      return setTimeout(openPort, 1000);
    }

    port.onMessage.addListener((msg) => {
      switch (msg.t) {
        case 'role':
          room = msg.room || null;
          setActive(!!msg.active);
          break;
        case 'net':
          if (engine) engine.handleMessage(msg.msg);
          break;
        case 'reset':
          if (engine) engine.reset();
          hud(null);
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      port = null;
      setActive(false);
      // A suspended background page drops every port. Reconnecting is also what
      // revives it, and the `claim` that follows hands it back the room.
      setTimeout(openPort, 500);
    });

    claimed = null;
    sendClaim();
  }

  function sendClaim() {
    const has = media.hasVideo();
    if (has === claimed) return;
    claimed = has;
    try {
      port && port.postMessage({ t: 'claim', hasVideo: has });
    } catch {
      /* ignore */
    }
  }

  // ----------------------------------------------------------------- the engine

  function ensureEngine() {
    if (engine) return engine;
    engine = globalThis.ClosiqSyncEngine.create({
      media,
      send(msg) {
        try {
          port && port.postMessage({ t: 'net', msg });
        } catch {
          /* ignore */
        }
      },
      onStatus(status) {
        try {
          port && port.postMessage({ t: 'status', status });
        } catch {
          /* ignore */
        }
        paint(status);
      },
    });
    return engine;
  }

  function setActive(next) {
    if (active === next) return;
    active = next;
    clearInterval(tickTimer);

    if (!active) {
      if (engine) engine.reset();
      hud(null);
      return;
    }

    ensureEngine();
    refreshFingerprint();
    tickTimer = setInterval(() => {
      try {
        engine.tick();
      } catch (e) {
        console.warn('[ClosiqSync] tick failed', e);
      }
    }, TUNING.TICK_MS);
  }

  async function refreshFingerprint() {
    try {
      const fp = await mediaFingerprint(topHref());
      fingerprint = fp;
      if (engine) engine.setFingerprint(fp);
    } catch {
      /* ignore */
    }
  }

  // Identify by the TOP-level page even from inside a cross-origin iframe, so an
  // embed on someblog.com is identified as someblog.com rather than the embed
  // provider. ancestorOrigins is WebKit-native and readable across origins;
  // window.top.location is not.
  function topHref() {
    const ao = location.ancestorOrigins;
    if (ao && ao.length) {
      try {
        // Only the origin is legible cross-origin; combine it with our own path
        // so distinct videos on the same host still differ.
        return new URL(location.pathname + location.search, ao[ao.length - 1]).href;
      } catch {
        /* fall through */
      }
    }
    return location.href;
  }

  // ------------------------------------------------------------- media wiring

  media.start({
    onUserAction(kind) {
      if (active && engine) engine.localAction(kind);
    },
    onBufferChange() {
      if (active && engine) engine.push(null);
    },
    onPresence(info) {
      sendClaim();
      if (info && info.reloaded) refreshFingerprint();
      if (info && info.blocked) hud('Click play once to let Safari start the video');
    },
  });

  // Videos appear late and disappear on navigation; a slow poll is cheaper and
  // far less noisy here than a document-wide subtree observer, which on YouTube
  // fires thousands of times a minute.
  setInterval(() => {
    sendClaim();
    if (location.href !== lastHref) {
      lastHref = location.href;
      refreshFingerprint();
    }
  }, 1000);

  // ---------------------------------------------------------------------- HUD
  //
  // Closed shadow root on documentElement, not body: body is routinely
  // transformed or `contain`ed by streaming sites, which would make a
  // fixed-position child position and clip against it instead of the viewport.
  // `all: initial` on host and content because inherited properties cross the
  // shadow boundary, which is the one thing shadow DOM does not isolate for you.

  let hudHost = null;
  let hudNode = null;
  let hudTimer = 0;

  function buildHud() {
    if (hudHost) return;
    hudHost = document.createElement('div');
    hudHost.style.cssText = [
      'all: initial',
      'position: fixed',
      'top: 16px',
      'left: 50%',
      'transform: translateX(-50%)',
      'z-index: 2147483647',
      'pointer-events: none',
    ].join(';');
    const root = hudHost.attachShadow({ mode: 'closed' });
    hudNode = document.createElement('div');
    hudNode.style.cssText = [
      'all: initial',
      'font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
      'color: #fff',
      'background: rgba(20,20,22,0.86)',
      '-webkit-backdrop-filter: blur(12px)',
      'backdrop-filter: blur(12px)',
      'padding: 8px 14px',
      'border-radius: 999px',
      'box-shadow: 0 4px 20px rgba(0,0,0,0.35)',
      'white-space: nowrap',
      'opacity: 0',
      'transition: opacity 160ms ease',
    ].join(';');
    root.appendChild(hudNode);
    (document.documentElement || document.body).appendChild(hudHost);
  }

  // Site fullscreen reparents the player, and a HUD attached to documentElement
  // would be behind it. Follow the fullscreen element when there is one.
  function syncHudParent() {
    if (!hudHost) return;
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    const want = fs || document.documentElement || document.body;
    if (hudHost.parentNode !== want) want.appendChild(hudHost);
  }

  function hud(text, { sticky = false } = {}) {
    if (!text) {
      if (hudNode) hudNode.style.opacity = '0';
      clearTimeout(hudTimer);
      return;
    }
    buildHud();
    syncHudParent();
    hudNode.textContent = text;
    hudNode.style.opacity = '1';
    clearTimeout(hudTimer);
    if (!sticky) hudTimer = setTimeout(() => (hudNode.style.opacity = '0'), 2200);
  }

  /** Map engine status onto at most one line of on-screen text. */
  function paint(s) {
    if (!s || !s.connected) return hud(null);

    let key = '';
    let text = '';
    let sticky = false;

    if (s.matchedCount === 0 && s.mismatched) {
      key = 'mismatch';
      text = 'Your partner is watching something else';
      sticky = true;
    } else if (s.matchedCount === 0) {
      key = 'waiting-peer';
      text = 'Waiting for someone to join';
      sticky = true;
    } else if (s.waiting) {
      key = 'buffering';
      text = 'Waiting for your partner to buffer';
      sticky = true;
    } else if (s.holding) {
      key = 'holding';
      text = 'Holding for your partner to catch up';
      sticky = true;
    } else if (s.nudge < 0) {
      key = 'nudge';
      text = `Easing off ${Math.round(-s.nudge * 100)}% to match`;
    } else {
      key = 'synced';
      text = 'In sync';
    }

    // Only speak when something actually changed, or a transient toast would
    // re-fire every 250ms tick and never fade.
    if (key === lastHudKey) {
      if (sticky) hud(text, { sticky: true });
      return;
    }
    const wasSomething = lastHudKey && lastHudKey !== 'synced';
    lastHudKey = key;
    if (key === 'synced' && !wasSomething) return hud(null);
    hud(text, { sticky });
  }

  openPort();
})();
