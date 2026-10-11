/**
 * Merging a player's progress stats WITHOUT last-writer-wins (2026-10-11,
 * .online R2 — ECON-10 / ECON-12 / APPUI-11).
 *
 * users.stats (TEXT JSON on prod) holds the server's progress counters. Before
 * R2 every completed hand wrote them as ABSOLUTE values from whichever
 * in-memory progress entry the seat had (one per seat), so two seats of one
 * account overwrote each other's counters, a stale entry could lower them, and
 * the ELO / ranked / HUD window stats were never written at all. Now the
 * hand-complete save merges, under the row lock mergeUserStats already takes:
 *   - monotonic counters        → max(existing, incoming)
 *   - sets (variantsPlayed)     → union
 *   - counter maps              → per-key max (actionCounts, handsPerRank)
 *   - positionWins              → per-position per-field max
 *   - dated windows             → the NEWER window wins; the same window
 *                                 merges per field (max / union)
 *   - boosters                  → per kind, the later expiry
 *   - battlePassPremium         → OR
 *   - everything else           → the incoming value (elo, eloHistory, …)
 * The same merge reconciles a live in-memory entry with a fresh DB read at
 * every sign-in (ProgressionManager.refresh), so neither side ever moves a
 * counter backwards.
 */

/** Counters that only ever grow. */
export const MONOTONIC_STAT_KEYS: readonly string[] = [
  'handsPlayed', 'handsWon', 'biggestPot', 'bestStreak', 'bluffWins', 'allInWins', 'chatMessagesSent',
  'straightFlushHits', 'fullHouseHits', 'quadsHits', 'royalFlushHits', 'tournamentsWon', 'tournamentsPlayed',
  'vpipHands', 'pfrHands', 'flopsSeenHands', 'showdownHands', 'showdownWins', 'threeBetOpps', 'threeBets',
  'rankedWins', 'rankedLosses', 'peakElo', 'lastHandAt', 'vipExpiresAt',
];
const MONOTONIC = new Set(MONOTONIC_STAT_KEYS);
const SET_KEYS = new Set(['variantsPlayed']);
const COUNTER_MAP_KEYS = new Set(['actionCounts', 'handsPerRank']);
/** Dated windows: [object key, date key]. */
const WINDOWS: ReadonlyArray<[string, string]> = [
  ['dailyStats', 'dailyStatsDate'],
  ['weeklyStats', 'weeklyStatsWeekStart'],
];

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function maxNumber(a: unknown, b: unknown): number | undefined {
  const ha = typeof a === 'number' && Number.isFinite(a);
  const hb = typeof b === 'number' && Number.isFinite(b);
  if (!ha && !hb) return undefined;
  if (!ha) return b as number;
  if (!hb) return a as number;
  return Math.max(a as number, b as number);
}

function unionArray(a: unknown, b: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const v of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const k = JSON.stringify(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function maxCounterMap(a: unknown, b: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const src of [a, b]) {
    if (!isObj(src)) continue;
    for (const [k, v] of Object.entries(src)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      out[k] = Math.max(out[k] ?? 0, v);
    }
  }
  return out;
}

function maxPositionWins(a: unknown, b: unknown): Record<string, { wins: number; total: number }> {
  const out: Record<string, { wins: number; total: number }> = {};
  for (const src of [a, b]) {
    if (!isObj(src)) continue;
    for (const [pos, v] of Object.entries(src)) {
      if (!isObj(v)) continue;
      const cur = out[pos] || { wins: 0, total: 0 };
      out[pos] = { wins: Math.max(cur.wins, num(v.wins)), total: Math.max(cur.total, num(v.total)) };
    }
  }
  return out;
}

/** Same-window merge of two window objects: numbers max, arrays union, strings incoming. */
function mergeWindowObject(a: unknown, b: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const A = isObj(a) ? a : {};
  const B = isObj(b) ? b : {};
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const va = A[k];
    const vb = B[k];
    if (typeof va === 'number' || typeof vb === 'number') out[k] = maxNumber(va, vb) ?? 0;
    else if (Array.isArray(va) || Array.isArray(vb)) out[k] = unionArray(va, vb);
    else if (isObj(va) || isObj(vb)) out[k] = maxCounterMap(va, vb);
    else out[k] = vb !== undefined ? vb : va;
  }
  return out;
}

/** The mission day object {date, progress:{templateId:n}} — newer date wins, same date per-template max. */
function mergeMissionDay(a: unknown, b: unknown): unknown {
  const A = isObj(a) && typeof a.date === 'string' ? a : null;
  const B = isObj(b) && typeof b.date === 'string' ? b : null;
  if (!A) return B ?? a;
  if (!B) return A;
  if (B.date > A.date) return { date: B.date, progress: maxCounterMap({}, B.progress) };
  if (A.date > B.date) return { date: A.date, progress: maxCounterMap({}, A.progress) };
  return { date: A.date, progress: maxCounterMap(A.progress, B.progress) };
}

function mergeBoosters(a: unknown, b: unknown): Record<string, { mult: number; expiresAt: number }> {
  const out: Record<string, { mult: number; expiresAt: number }> = {};
  for (const src of [a, b]) {
    if (!isObj(src)) continue;
    for (const [kind, v] of Object.entries(src)) {
      if (!isObj(v) || !(num(v.expiresAt) > 0) || !(num(v.mult) > 0)) continue;
      if (!out[kind] || num(v.expiresAt) > out[kind].expiresAt) out[kind] = { mult: num(v.mult), expiresAt: num(v.expiresAt) };
    }
  }
  return out;
}

/** Is `key` merged by a progress rule (counter / set / map / window / booster / flag) rather than overwritten? */
export function isProgressRuleKey(key: string): boolean {
  return MONOTONIC.has(key) || SET_KEYS.has(key) || COUNTER_MAP_KEYS.has(key)
    || key === 'positionWins' || key === 'missions' || key === 'activeBoosters' || key === 'battlePassPremium'
    || WINDOWS.some(([w, d]) => w === key || d === key);
}

/**
 * `existing` (the stored stats) merged with `patch` by the rules above. Pure;
 * never throws; neither input is mutated. Keys only in `existing` are kept.
 */
export function mergeProgressStats(existing: unknown, patch: unknown): Record<string, any> {
  const E: Record<string, any> = isObj(existing) ? { ...existing } : {};
  if (!isObj(patch)) return E;
  const out: Record<string, any> = { ...E };
  const windowDateKeys = new Set(WINDOWS.map(([, d]) => d));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || windowDateKeys.has(k)) continue;
    if (MONOTONIC.has(k)) {
      const m = maxNumber(E[k], v);
      if (m !== undefined) out[k] = m;
    } else if (SET_KEYS.has(k)) {
      out[k] = unionArray(E[k], v);
    } else if (COUNTER_MAP_KEYS.has(k)) {
      out[k] = maxCounterMap(E[k], v);
    } else if (k === 'positionWins') {
      out[k] = maxPositionWins(E[k], v);
    } else if (k === 'missions') {
      out[k] = mergeMissionDay(E[k], v);
    } else if (k === 'activeBoosters') {
      out[k] = mergeBoosters(E[k], v);
    } else if (k === 'battlePassPremium') {
      out[k] = E[k] === true || v === true;
    } else if (WINDOWS.some(([w]) => w === k)) {
      continue; // handled below with its date
    } else {
      out[k] = v;
    }
  }
  for (const [w, d] of WINDOWS) {
    if (!(w in patch) && !(d in patch)) continue;
    const pDate = typeof patch[d] === 'string' ? patch[d] : '';
    const eDate = typeof E[d] === 'string' ? E[d] : '';
    if (!pDate) continue;
    if (pDate > eDate) { out[w] = mergeWindowObject({}, patch[w]); out[d] = pDate; }
    else if (pDate === eDate) { out[w] = mergeWindowObject(E[w], patch[w]); out[d] = pDate; }
    // an OLDER window never replaces a newer stored one
  }
  return out;
}
