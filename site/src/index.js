/**
 * Static site, plus byte-range support for the demo clip.
 *
 * Everything here is served from the assets binding except one thing: Safari
 * refuses to play a <video> whose server does not honour Range requests, and
 * the assets router answers a Range request with a plain 200 and the whole
 * body. The result is networkState 3 (NO_SOURCE) and a silently dead player,
 * with no console error to explain it.
 *
 * The clip is a few megabytes, so buffering it to slice is fine. This would be
 * the wrong shape for a large file; that would want R2, which streams ranges
 * natively.
 */

const RANGED = '/demo/clip.mp4';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const res = await env.ASSETS.fetch(request);

    if (url.pathname !== RANGED) return res;

    const range = request.headers.get('Range');
    const headers = new Headers(res.headers);
    // Advertise range support even on a full response, so the player knows it
    // can seek rather than giving up before it asks.
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'public, max-age=3600');

    if (!res.ok) return res;

    const body = await res.arrayBuffer();
    const total = body.byteLength;

    if (!range) {
      headers.set('Content-Length', String(total));
      return new Response(body, { status: 200, headers });
    }

    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) {
      headers.set('Content-Range', `bytes */${total}`);
      return new Response(null, { status: 416, headers });
    }

    // A suffix range ("bytes=-500") means the LAST n bytes, not from zero.
    let start;
    let end;
    if (m[1] === '') {
      const suffix = parseInt(m[2], 10);
      if (!Number.isFinite(suffix) || suffix <= 0) {
        headers.set('Content-Range', `bytes */${total}`);
        return new Response(null, { status: 416, headers });
      }
      start = Math.max(0, total - suffix);
      end = total - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] === '' ? total - 1 : parseInt(m[2], 10);
    }

    if (!Number.isFinite(start) || start > end || start >= total) {
      headers.set('Content-Range', `bytes */${total}`);
      return new Response(null, { status: 416, headers });
    }
    end = Math.min(end, total - 1);

    headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(body.slice(start, end + 1), { status: 206, headers });
  },
};
