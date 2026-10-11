/**
 * Daily missions (2026-10-11, .online R2 — C6 / ECON-5 / APPUI-3).
 *
 * Before R2 every SEAT (player-<uuid> progress entry) rolled its own three
 * random missions on creation (Math.random), so the lobby, each table and every
 * reconnect showed different missions, progress lived only in that seat entry,
 * the claim needed a seat, and the client invented its own PLACEHOLDER missions
 * — 0 mission claims ever on prod.
 *
 * Now missions are per USER per Denver calendar day and DETERMINISTIC: the same
 * account sees the same three missions all day on every device and after every
 * restart (seeded from userId + date). Progress is counted server-side from
 * hands the player was actually DEALT INTO, persisted in users.stats.missions,
 * and a claim is keyed `mission:<date>:<templateId>` in the user_daily_claims
 * ledger (one claim per mission per day, claimable from the lobby).
 *
 * "Fold pre-flop N times" is retired: an absent seat is folded by the turn
 * timer, so it could be completed by not playing at all.
 */

export type MissionKind = 'play_hands' | 'win_hands' | 'win_pot_over' | 'all_in' | 'hand_rank' | 'win_streak' | 'bluff_win';

export interface MissionTemplate {
  /** Stable id — part of the claim key; never reuse an id for a different mission. */
  id: string;
  kind: MissionKind;
  description: string;
  target: number;
  /** win_pot_over: the pot size; hand_rank: the minimum HandRank (Flush = 5). */
  threshold?: number;
  /** Selection group — at most one mission per group per day (no "Play 10" + "Play 20"). */
  group: string;
  reward: { chips: number; xp: number; stars: number };
}

export const MISSION_TEMPLATES: readonly MissionTemplate[] = [
  { id: 'play_10', kind: 'play_hands', description: 'Play 10 hands', target: 10, group: 'play', reward: { chips: 500, xp: 50, stars: 0 } },
  { id: 'play_20', kind: 'play_hands', description: 'Play 20 hands', target: 20, group: 'play', reward: { chips: 1000, xp: 100, stars: 0 } },
  { id: 'win_3', kind: 'win_hands', description: 'Win 3 hands', target: 3, group: 'win', reward: { chips: 1000, xp: 100, stars: 0 } },
  { id: 'win_5', kind: 'win_hands', description: 'Win 5 hands', target: 5, group: 'win', reward: { chips: 2000, xp: 200, stars: 0 } },
  { id: 'pot_5k', kind: 'win_pot_over', description: 'Win a pot of 5,000+', target: 1, threshold: 5000, group: 'pot', reward: { chips: 2000, xp: 200, stars: 0 } },
  { id: 'pot_10k', kind: 'win_pot_over', description: 'Win a pot of 10,000+', target: 1, threshold: 10000, group: 'pot', reward: { chips: 3000, xp: 300, stars: 5 } },
  { id: 'allin_3', kind: 'all_in', description: 'Go all-in 3 times', target: 3, group: 'allin', reward: { chips: 750, xp: 75, stars: 0 } },
  { id: 'allin_5', kind: 'all_in', description: 'Go all-in 5 times', target: 5, group: 'allin', reward: { chips: 1200, xp: 120, stars: 0 } },
  { id: 'flush_plus', kind: 'hand_rank', description: 'Win a hand with a flush or better', target: 1, threshold: 5, group: 'rank', reward: { chips: 1500, xp: 150, stars: 0 } },
  { id: 'streak_3', kind: 'win_streak', description: 'Win 3 hands in a row', target: 3, group: 'streak', reward: { chips: 3000, xp: 300, stars: 10 } },
  { id: 'bluff_1', kind: 'bluff_win', description: 'Win a hand with less than a pair', target: 1, group: 'bluff', reward: { chips: 1500, xp: 150, stars: 0 } },
];

export const MISSIONS_PER_DAY = 3;

const TEMPLATE_BY_ID = new Map(MISSION_TEMPLATES.map((t) => [t.id, t]));
export const missionTemplate = (id: string): MissionTemplate | undefined => TEMPLATE_BY_ID.get(id);

/** FNV-1a 32-bit. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
/** mulberry32 — a tiny deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The three template ids a user gets on a Denver date — the same answer every time. */
export function missionTemplateIdsFor(userId: number, dateKey: string): string[] {
  const rng = mulberry32(hash32(`missions|${userId}|${dateKey}`));
  const pool = [...MISSION_TEMPLATES];
  // Fisher-Yates with the seeded rng, then the first template of each group.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const groups = new Set<string>();
  const out: string[] = [];
  for (const t of pool) {
    if (out.length >= MISSIONS_PER_DAY) break;
    if (groups.has(t.group)) continue;
    groups.add(t.group);
    out.push(t.id);
  }
  return out;
}

/** `mission:<date>:<templateId>` — the user_daily_claims claim_type of a mission claim. */
export const missionClaimKey = (dateKey: string, templateId: string): string => `mission:${dateKey}:${templateId}`;
/** A mission's public id (what the client sends back in claimMission). */
export const missionId = (dateKey: string, templateId: string): string => `${dateKey}:${templateId}`;
export function parseMissionId(id: unknown): { dateKey: string; templateId: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2}):([a-z0-9_]{1,40})$/.exec(String(id ?? ''));
  return m ? { dateKey: m[1], templateId: m[2] } : null;
}

/** Per-user per-day mission state (in memory + users.stats.missions). */
export interface MissionDayState {
  date: string;
  /** templateId -> progress (capped at the template's target). */
  progress: Record<string, number>;
  /** templateIds claimed today (from the ledger; never persisted in stats). */
  claimed: string[];
}

export const emptyMissionDay = (date: string): MissionDayState => ({ date, progress: {}, claimed: [] });

/** A won hand's facts, for mission progress (only for a seat dealt into the hand). */
export interface MissionWinFacts {
  potWon: number;
  handRank?: number;
  /** The player's current win streak AFTER this hand. */
  currentStreak: number;
}

/**
 * Apply an event of a DEALT-IN hand to today's missions: `played` (the hand
 * counted), `win` (it was won), `allIns` (all-in actions this hand). Returns the
 * templateIds that became COMPLETE with this update (for the toast). Mutates `day`.
 */
export function applyMissionProgress(
  day: MissionDayState,
  templateIds: string[],
  event: { played?: boolean; win?: MissionWinFacts; allIns?: number },
): string[] {
  const completedNow: string[] = [];
  for (const id of templateIds) {
    const t = TEMPLATE_BY_ID.get(id);
    if (!t) continue;
    const before = Math.min(t.target, day.progress[id] || 0);
    if (before >= t.target) continue;
    let after = before;
    const w = event.win;
    switch (t.kind) {
      case 'play_hands': if (event.played) after = before + 1; break;
      case 'win_hands': if (w) after = before + 1; break;
      case 'win_pot_over': if (w && w.potWon >= (t.threshold || 0)) after = 1; break;
      case 'hand_rank': if (w && typeof w.handRank === 'number' && w.handRank >= (t.threshold || 0)) after = 1; break;
      case 'bluff_win': if (w && typeof w.handRank === 'number' && w.handRank < 1) after = before + 1; break;
      case 'win_streak': if (w) after = Math.max(before, Math.min(t.target, w.currentStreak || 0)); break;
      case 'all_in': if ((event.allIns || 0) > 0) after = before + Math.floor(event.allIns || 0); break;
    }
    after = Math.min(t.target, after);
    if (after !== before) day.progress[id] = after;
    if (after >= t.target && before < t.target) completedNow.push(id);
  }
  return completedNow;
}

/** The C5/C6 mission rows for a user's day. */
export function missionRows(day: MissionDayState, templateIds: string[]): Array<{
  id: string; templateId: string; type: MissionKind; description: string; progress: number; target: number;
  reward: { chips: number; xp: number; stars: number }; completed: boolean; claimed: boolean;
}> {
  const claimed = new Set(day.claimed);
  return templateIds.map((tid) => TEMPLATE_BY_ID.get(tid)).filter((t): t is MissionTemplate => !!t).map((t) => {
    const progress = Math.min(t.target, day.progress[t.id] || 0);
    return {
      id: missionId(day.date, t.id),
      templateId: t.id,
      type: t.kind,
      description: t.description,
      progress,
      target: t.target,
      reward: { ...t.reward },
      completed: progress >= t.target,
      claimed: claimed.has(t.id),
    };
  });
}
