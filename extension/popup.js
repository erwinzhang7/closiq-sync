(() => {
  'use strict';

  const { DEFAULTS, normalizeCode, isValidCode } = globalThis.InsyncShared;
  const $ = (id) => document.getElementById(id);

  const el = {
    idle: $('view-idle'),
    room: $('view-room'),
    create: $('create'),
    joinForm: $('join-form'),
    code: $('code'),
    join: $('join'),
    idleError: $('idle-error'),
    codeDisplay: $('code-display'),
    copied: $('copied'),
    dot: $('dot'),
    status: $('status'),
    detail: $('detail'),
    detailRow: $('detail-row'),
    leave: $('leave'),
    advancedToggle: $('advanced-toggle'),
    advanced: $('advanced'),
    endpoint: $('endpoint'),
  };

  const ask = (msg) => api.runtime.sendMessage(msg).catch(() => null);

  function showError(text) {
    el.idleError.textContent = text || '';
    el.idleError.hidden = !text;
  }

  // ------------------------------------------------------------------ render

  function render(s) {
    if (!s) return;
    const inRoom = !!s.room;
    el.idle.hidden = inRoom;
    el.room.hidden = !inRoom;
    el.endpoint.value = s.endpoint || DEFAULTS.endpoint;

    if (!inRoom) return;
    el.codeDisplay.textContent = s.room;

    const sync = s.sync;
    let tone = 'warn';
    let text;

    if (s.socket === 'retrying') {
      tone = 'bad';
      text = 'Reconnecting…';
    } else if (s.socket !== 'open') {
      text = 'Connecting…';
    } else if (!s.hasDriver) {
      // The socket is fine; there is simply no video anywhere to drive.
      text = 'Open a video to start syncing';
    } else if (!sync) {
      text = 'Connecting…';
    } else if (sync.matchedCount === 0 && sync.mismatched) {
      tone = 'warn';
      text = 'Watching something different';
    } else if (sync.matchedCount === 0) {
      text = 'Waiting for someone to join';
    } else if (sync.waiting) {
      text = 'Waiting on a buffer';
    } else if (sync.holding) {
      text = 'Holding for your partner';
    } else {
      tone = 'ok';
      text =
        sync.nudge < 0
          ? `In sync, easing off ${Math.round(-sync.nudge * 100)}%`
          : 'In sync';
    }

    el.dot.className = `dot ${tone}`;
    el.status.textContent = text;

    // Numbers only once they mean something; an empty row is worse than none.
    const bits = [];
    if (sync && sync.drift !== null && sync.matchedCount > 0) {
      const ms = Math.round(sync.drift * 1000);
      bits.push(`${ms >= 0 ? '+' : ''}${ms} ms apart`);
    }
    if (sync && sync.rtt !== null && sync.rtt !== undefined) bits.push(`${sync.rtt} ms ping`);
    el.detail.textContent = bits.join(' · ');
    el.detailRow.hidden = bits.length === 0;
  }

  async function refresh() {
    render(await ask({ t: 'get-state' }));
  }

  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.t === 'insync-state') render(msg.state);
  });

  // ------------------------------------------------------------------ actions

  el.create.addEventListener('click', async () => {
    showError('');
    el.create.disabled = true;
    el.create.textContent = 'Starting…';
    const res = await ask({ t: 'create-room' });
    el.create.disabled = false;
    el.create.textContent = 'Start a session';
    if (!res || !res.ok) return showError((res && res.error) || 'Could not reach the server.');
    await refresh();
  });

  el.joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const code = normalizeCode(el.code.value);
    if (!isValidCode(code)) return showError('That is not a valid room code.');
    const res = await ask({ t: 'join-room', code });
    if (!res || !res.ok) return showError((res && res.error) || 'Could not join.');
    await refresh();
  });

  // Normalising as the user types keeps the field honest about the alphabet
  // instead of failing only on submit.
  el.code.addEventListener('input', () => {
    const cleaned = normalizeCode(el.code.value).slice(0, 6);
    if (cleaned !== el.code.value) el.code.value = cleaned;
    showError('');
  });

  el.codeDisplay.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.codeDisplay.textContent.trim());
      el.copied.hidden = false;
      setTimeout(() => (el.copied.hidden = true), 1400);
    } catch {
      /* clipboard denied; the code is on screen anyway */
    }
  });

  el.leave.addEventListener('click', async () => {
    await ask({ t: 'leave-room' });
    await refresh();
  });

  el.advancedToggle.addEventListener('click', () => {
    el.advanced.hidden = !el.advanced.hidden;
  });

  el.advanced.addEventListener('submit', async (e) => {
    e.preventDefault();
    await ask({ t: 'set-endpoint', endpoint: el.endpoint.value });
    el.advanced.hidden = true;
    await refresh();
  });

  refresh();
  // The background pushes updates, but a popup opened mid-reconnect would
  // otherwise sit on a stale frame until the next event.
  setInterval(refresh, 1000);
})();
