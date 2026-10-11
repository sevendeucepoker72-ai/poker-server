/**
 * Fixed-window rate limiter keyed by account (or socket) — 2026-10-11, .online R1.
 *
 * Several socket handlers that read the database or pay out were callable in a
 * tight loop (searchPlayers / checkUsername enumerate accounts; a battle-pass
 * claim loop hammers the claim ledger). `hit(key)` counts one call and returns
 * true while the key is within `max` calls per `windowMs`. Memory is bounded:
 * expired windows are pruned once the map grows past `maxKeys`, and if every
 * window is still live the map is reset (a rate limiter must never become a
 * leak or an outage).
 */
export interface WindowRateLimiter {
  /** Count one call for `key`; true = allowed. */
  hit(key: string, now?: number): boolean;
  /** Keys currently tracked (for tests / health). */
  size(): number;
}

export function createWindowRateLimiter(max: number, windowMs: number, maxKeys = 10_000): WindowRateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  const prune = (now: number): void => {
    for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
    if (windows.size > maxKeys) windows.clear();
  };
  return {
    hit(key: string, now: number = Date.now()): boolean {
      let w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        if (!w && windows.size >= maxKeys) prune(now);
        w = { start: now, count: 0 };
        windows.set(key, w);
      }
      w.count++;
      return w.count <= max;
    },
    size: () => windows.size,
  };
}
