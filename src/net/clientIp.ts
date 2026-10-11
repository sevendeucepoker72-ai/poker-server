/**
 * 2026-10-11 (.online R2, OPS-6) — the REAL client address of a socket.
 *
 * On Railway every socket arrives through the edge proxy, so
 * `socket.handshake.address` is the proxy hop (100.64.0.0/10, a different one
 * from connection to connection) — never the player. The three per-IP checks
 * keyed on it did nothing against a real abuser and could refuse strangers who
 * happened to share a hop:
 *   - the per-IP connection cap (MAX_CONNECTIONS_PER_IP — a live probe held 25
 *     sockets from ONE address),
 *   - the same-network seat block at a cash table (collusion),
 *   - the qualifier per-device registration cap.
 *
 * Order (Railway's documented trust boundary): `X-Real-IP` first — the edge
 * OVERWRITES it, a client cannot forge it; then the FIRST `X-Forwarded-For`
 * entry (the original client as the edge saw it); then the socket address
 * (local dev, tests, a direct connection). A header value is trimmed, cut at a
 * comma, an IPv4-mapped IPv6 prefix (`::ffff:`) dropped and capped in length,
 * so one address always maps to one key.
 */

type HeaderValue = string | string[] | undefined;

const MAX_IP_LENGTH = 64;

/** One header value → its first address, normalised ('' when absent). */
function firstAddress(v: HeaderValue): string {
  const raw = Array.isArray(v) ? (v.length > 0 ? String(v[0]) : '') : (typeof v === 'string' ? v : '');
  return normalizeIp(raw.split(',')[0] || '');
}

/** Trim, drop an IPv4-mapped IPv6 prefix, cap the length. */
export function normalizeIp(ip: string): string {
  let s = String(ip || '').trim();
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(s)) s = s.slice(7);
  return s.slice(0, MAX_IP_LENGTH);
}

/**
 * The client address from a socket.io handshake (`headers` + `address`):
 * X-Real-IP, else the first X-Forwarded-For entry, else the peer address.
 */
export function clientIpFromHandshake(
  handshake: { headers?: Record<string, HeaderValue> | null; address?: string | null } | null | undefined,
): string {
  const headers = (handshake && handshake.headers) || {};
  const real = firstAddress(headers['x-real-ip']);
  if (real) return real;
  const forwarded = firstAddress(headers['x-forwarded-for']);
  if (forwarded) return forwarded;
  return normalizeIp((handshake && handshake.address) || '');
}
