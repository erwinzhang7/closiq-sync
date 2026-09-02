/**
 * One Durable Object per room code.
 *
 * The DO is deliberately dumb: it relays state between peers and stamps every
 * relayed message with its own clock. It never interprets playback positions.
 * That matters because it means the DO's clock is the ONLY shared timebase in
 * the system -- each peer measures its offset to the DO, and two peers who both
 * know their offset to the DO thereby know their offset to each other. No
 * peer-to-peer clock handshake is needed.
 *
 * Uses the WebSocket Hibernation API so an idle room costs nothing: the object
 * is evicted from memory between messages and per-socket metadata rides along
 * in the socket's attachment.
 */

const MAX_PEERS = 8;
const MAX_MESSAGE_BYTES = 4096;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // rooms self-destruct after 12h idle

// The oldest client wire format this relay still accepts. Raising it retires
// old clients without them needing to have shipped any update logic of their
// own, which is the only lever that works on installs already in the wild.
const MIN_PROTOCOL = 1;

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    // getWebSockets() survives hibernation, so this is an accurate live count.
    if (this.state.getWebSockets().length >= MAX_PEERS) {
      return new Response('room full', { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);
    // Identity is assigned by the client in `hello`; until then the socket is
    // anonymous and its messages are dropped.
    server.serializeAttachment({ id: null, joinedAt: Date.now() });

    await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) {
      return ws.close(1009, 'message too large');
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // malformed frames are ignored, not fatal
    }

    // Date.now() in Workers advances on I/O, and receiving this frame IS the
    // I/O, so `now` is the arrival time rather than a stale cached value.
    const now = Date.now();
    const self = ws.deserializeAttachment() || {};

    switch (msg.t) {
      case 'hello': {
        if (typeof msg.id !== 'string' || !msg.id) return;
        // A client that predates versioning sends no `v`; treat it as 0 so it
        // compares as older than everything rather than as equal.
        const v = num(msg.v);
        ws.serializeAttachment({ ...self, id: msg.id, v });

        const peers = this.peers(ws)
          .filter((p) => p.id)
          .map((p) => ({ id: p.id, v: p.v || 0 }));
        ws.send(
          JSON.stringify({ t: 'welcome', id: msg.id, peers, now, minProtocol: MIN_PROTOCOL })
        );
        this.broadcast(ws, { t: 'peer-join', id: msg.id, v, now });

        // Any join refreshes the room's lifetime.
        await this.state.storage.setAlarm(now + ROOM_TTL_MS);
        return;
      }

      case 'ping': {
        // Half of an NTP round trip. The client pairs t0/t1 with its own
        // receive time to derive its offset to this object's clock.
        ws.send(JSON.stringify({ t: 'pong', t0: msg.t0, t1: now }));
        return;
      }

      case 'state': {
        if (!self.id) return; // must say hello first
        // `srv` is stamped here, not by the sender, so a peer with a wildly
        // wrong local clock cannot poison anyone else's projection.
        this.broadcast(ws, {
          t: 'state',
          id: self.id,
          // Stamped from the sender's hello, not from this message, so a peer
          // cannot claim a different version per frame.
          v: self.v || 0,
          srv: now,
          pos: num(msg.pos),
          rate: num(msg.rate),
          paused: !!msg.paused,
          buffering: !!msg.buffering,
          media: typeof msg.media === 'string' ? msg.media.slice(0, 64) : null,
          seq: num(msg.seq),
          cause: typeof msg.cause === 'string' ? msg.cause.slice(0, 24) : null,
        });
        return;
      }

      case 'bye':
        return ws.close(1000, 'bye');
    }
  }

  webSocketClose(ws) {
    this.announceDeparture(ws);
  }

  webSocketError(ws) {
    this.announceDeparture(ws);
  }

  async alarm() {
    for (const ws of this.state.getWebSockets()) ws.close(1001, 'room expired');
    await this.state.storage.deleteAll();
  }

  // --- helpers -------------------------------------------------------------

  announceDeparture(ws) {
    const self = ws.deserializeAttachment() || {};
    if (!self.id) return;
    this.broadcast(ws, { t: 'peer-leave', id: self.id });
  }

  /** Attachments of every socket except `exclude`. */
  peers(exclude) {
    return this.state
      .getWebSockets()
      .filter((s) => s !== exclude)
      .map((s) => s.deserializeAttachment() || {});
  }

  broadcast(from, payload) {
    const body = JSON.stringify(payload);
    for (const s of this.state.getWebSockets()) {
      if (s === from) continue;
      try {
        s.send(body);
      } catch {
        // A socket that died between getWebSockets() and send() is not our
        // problem; webSocketClose will clean it up.
      }
    }
  }
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
