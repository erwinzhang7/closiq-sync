import { Room } from './room.js';

export { Room };

// Room codes are typed by humans reading them off a screen, so the alphabet
// excludes anything that survives a phone call badly: 0/O, 1/I/L, 2/Z, 5/S, 8/B.
const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
const CODE_LENGTH = 6;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true });
    }

    // The extension asks the server for a code rather than minting one locally,
    // so the alphabet lives in exactly one place.
    if (url.pathname === '/new') {
      return json({ code: mintCode() }, { 'Cache-Control': 'no-store' });
    }

    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    if (match) {
      const code = match[1].toUpperCase();
      if (!CODE_RE.test(code)) {
        return json({ error: 'bad room code' }, {}, 400);
      }
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }

    return new Response('not found', { status: 404 });
  },
};

function mintCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let out = '';
  // Rejection-free because 256 % 25 != 0 introduces only a negligible bias at
  // this alphabet size, and room codes are ephemeral rather than secret keys.
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function json(body, headers = {}, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
