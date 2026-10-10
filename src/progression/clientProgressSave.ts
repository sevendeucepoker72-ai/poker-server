/**
 * 2026-10-09 — D4: what the CLIENT may write through the socket `saveProgress`
 * event. Answer: only `stats.clientData` — nothing that pays out.
 *
 * THE EXPLOIT (pre-existing since b5476ea6, 2026-07-07). The handler stripped
 * only `userId` and `chips` and forwarded the rest to authManager.saveProgress:
 *   - `level` → `level = GREATEST(level, $n)`. emit saveProgress {level:1000}
 *     and the next hydrate + hand pays every level achievement (lvl_25 …
 *     lvl_1000: ~14M chips + stars) through persistChipReward, durably.
 *   - `xp` → `xp = GREATEST(xp, $n)`. A huge xp makes the next addXP walk the
 *     level-up loop to MAX_LEVEL, paying level * 500 chips per level.
 *   - `achievements` → unioned into the earned list (corrupts it).
 *   - every other `stats` key is merged into users.stats, which hydrateFromDB
 *     reads back as SERVER counters: handsWon / royalFlushHits /
 *     tournamentsWon / … (achievement thresholds that pay chips),
 *     activeBoosters (a chip-reward MULTIPLIER), vipExpiresAt (VIP perks),
 *     masterUserId (the identity stamp the play gate and the guest carry-over
 *     read).
 *
 * WHAT THE REAL CLIENT SENDS. poker-3d persistenceService._doSync emits
 * `saveProgress { stats: { ...serverStatsEcho, clientData } }` and nothing
 * else: the server stats it echoes back are the server's own counters
 * (authoritative in memory, written by the hand-complete save), and
 * `clientData` (career / missions / battle pass / settings blobs the client
 * restores on login, persistenceService.restoreClientData) is the only part
 * that is the client's to write. The server never reads `clientData` for any
 * payout (grep: no `clientData` reference in src/ besides this module).
 *
 * So level, xp, achievements, chips and every non-clientData stats key are
 * DROPPED. Legitimate progression is unchanged: level / xp / achievements /
 * counters are persisted by the server's own paths (hand-complete save,
 * dbCommitLevelUpReward, disconnect save, graceful shutdown).
 */

export interface SanitizedClientSave {
  /** Present only when the client sent a usable clientData object. */
  stats?: { clientData: Record<string, unknown> };
}

export interface ClientSaveSanitizeResult {
  data: SanitizedClientSave;
  /** Top-level / stats keys the client sent that were dropped (telemetry only). */
  dropped: string[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v);

/** Pure. Never throws. */
export function sanitizeClientProgressSave(raw: unknown): ClientSaveSanitizeResult {
  const dropped: string[] = [];
  if (!isPlainObject(raw)) return { data: {}, dropped };
  for (const k of Object.keys(raw)) {
    if (k !== 'stats' && k !== 'userId') dropped.push(k);
  }
  const stats = raw.stats;
  if (!isPlainObject(stats)) {
    if (stats !== undefined) dropped.push('stats');
    return { data: {}, dropped };
  }
  for (const k of Object.keys(stats)) {
    if (k !== 'clientData') dropped.push(`stats.${k}`);
  }
  const clientData = stats.clientData;
  if (!isPlainObject(clientData)) return { data: {}, dropped };
  return { data: { stats: { clientData } }, dropped };
}

/**
 * Keys whose presence means a client tried to write something that pays out
 * (the real client never sends them). Logged once per socket.
 */
export const PAYOUT_KEYS_FROM_CLIENT = ['level', 'xp', 'achievements', 'chips'] as const;
