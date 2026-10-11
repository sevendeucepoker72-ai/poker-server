/**
 * 2026-10-11 (.online R2, S1) — club tournaments played for real (TOURNEY-14).
 *
 * Before: registerClubTournament toggled a row (no buy-in charged) and
 * startClubTournament only flipped `status` to 'running' — no tournament was
 * ever dealt. Now the buy-in is charged at registration (refunded on
 * unregister / cancel), and the start creates a real TournamentManager
 * tournament for the registered members. Pure helpers: the blind structure it
 * runs and the config values a manager may set.
 */

export interface ClubBlindLevel { sb: number; bb: number; ante: number; duration: number }

/** The default club structure (minutes per level), as createClubTournament stores it. */
const DEFAULT_LEVELS = [
  { smallBlind: 25, bigBlind: 50, ante: 0, duration: 15 },
  { smallBlind: 50, bigBlind: 100, ante: 0, duration: 15 },
  { smallBlind: 100, bigBlind: 200, ante: 25, duration: 15 },
];

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null));

/**
 * The structure the server RUNS for a club tournament (TournamentManager
 * BlindLevels, duration in SECONDS): the club's stored levels (`duration` in
 * minutes, 1-120; sb >= 1, bb >= 2 sb, ante >= 0 — an invalid level is
 * skipped; none valid → the default levels), then continued — doubling the
 * last level, same duration — until a big blind is four starting stacks, so
 * the tournament always ends (the blind clock stops at the LAST level; the
 * stored three default levels topped out at 100/200 on 5,000 stacks).
 */
export function clubTournamentBlindLevels(stored: unknown, startingChips: number): ClubBlindLevel[] {
  let raw: unknown = stored;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = []; } }
  const levels: ClubBlindLevel[] = [];
  for (const l of Array.isArray(raw) ? raw : []) {
    const o = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    const sb = int(o.smallBlind ?? o.sb);
    const bb = int(o.bigBlind ?? o.bb);
    const ante = int(o.ante ?? 0);
    const minutes = int(o.duration);
    if (sb === null || bb === null || ante === null || minutes === null) continue;
    if (sb < 1 || bb < 2 * sb || ante < 0 || minutes < 1 || minutes > 120) continue;
    levels.push({ sb, bb, ante, duration: minutes * 60 });
    if (levels.length >= 40) break;
  }
  if (levels.length === 0) for (const d of DEFAULT_LEVELS) levels.push({ sb: d.smallBlind, bb: d.bigBlind, ante: d.ante, duration: d.duration * 60 });
  const stack = Number.isFinite(startingChips) && startingChips > 0 ? Math.floor(startingChips) : 5000;
  while (levels[levels.length - 1].bb < 4 * stack && levels.length < 60) {
    const last = levels[levels.length - 1];
    levels.push({ sb: last.sb * 2, bb: last.bb * 2, ante: last.ante * 2, duration: last.duration });
  }
  return levels;
}

/** Club tournament numbers a manager may set (anything else falls back to the defaults). */
export function clubTournamentNumbers(config: { buyIn?: unknown; startingChips?: unknown; maxPlayers?: unknown }): { buyIn: number; startingChips: number; maxPlayers: number } {
  const buyIn = int(config.buyIn);
  const chips = int(config.startingChips);
  const max = int(config.maxPlayers);
  return {
    // 0 is a real (free) club tournament — it used to become 100 (`|| 100`).
    buyIn: buyIn !== null && buyIn >= 0 && buyIn <= 1_000_000 ? buyIn : 100,
    startingChips: chips !== null && chips >= 100 && chips <= 1_000_000 ? chips : 5000,
    maxPlayers: Math.min(200, Math.max(2, max ?? 20)),
  };
}
