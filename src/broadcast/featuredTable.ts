/**
 * 2026-11-02 (.online tournament broadcast, P2-S3) — THE FEATURED-TABLE
 * RECOMMENDER: which table of an event the program shows (spec §3
 * ProgramState.featured; the server lane's S3 rules).
 *
 * Score per table (from public facts only — stacks, pots, flags; never a card):
 *   2 x players alive
 *   + 80 for a contested all-in in a hand in play (an all-in seat and >= 2 seats
 *     still contesting)
 *   + min(40, 40 x pot / average stack)
 *   + 25 for the chip leader seated there, + 10 for each other top-3 stack
 *   + 20 for a stack of 3 big blinds or less while hand-for-hand / on the bubble
 * Rules, in order:
 *   1. One table left in play (the final table) is forced: mode 'final_table'.
 *   2. A producer lock wins until it expires or its table leaves the event
 *      (then 'auto', reason 'table_broken').
 *   3. Never cut away mid-hand from a featured table whose hand has a contested
 *      all-in.
 *   4. At the featured table's hand boundary, switch when the best table scores
 *      at least SWITCH_MARGIN more and the featured table has been on for
 *      DWELL_MS.
 *   5. The all-in cut: switch MID-HAND to another table's contested all-in only
 *      after ALL_IN_CUT_DWELL_MS, and only when the featured hand has no all-in.
 *   6. Ties break deterministically by the table's order in the event.
 * With auto off (producer setAuto {table:false}) the table only changes when it
 * leaves the event or the final table forces it.
 *
 * Pure: the wire calls it at most twice a second per program (FEATURED_EVAL_MIN_MS)
 * and owns the state; nothing here reads a card or throws on a missing table.
 */
import type { Tournament } from '../game/TournamentManager';
import type { ProgramState } from './contract';
import { tableNoOf, type BroadcastWorld, type PublicTableView } from './broadcastSnapshot';

export type FeaturedMode = ProgramState['featured']['mode'];
export type FeaturedReason = ProgramState['featured']['reason'];

export interface FeaturedTableInput {
  tableId: string;
  /** The table's position in the event (the tie-break). */
  order: number;
  tableNo: number | null;
  tableName: string;
  alive: number;
  handInProgress: boolean;
  contestedAllIn: boolean;
  pot: number;
  chipLeaderHere: boolean;
  /** Top-3 stacks seated here OTHER than the chip leader. */
  topThreeHere: number;
  /** A stack <= 3 BB here while hand-for-hand or on the bubble. */
  shortStackPressure: boolean;
}

export interface FeaturedEventContext {
  avgStack: number | null;
}

export interface FeaturedState {
  tableId: string | null;
  mode: FeaturedMode;
  reason: FeaturedReason;
  since: number;
}

export interface FeaturedLock {
  tableId: string;
  /** Epoch ms; null = until the producer releases it. */
  until: number | null;
}

export const FEATURED_RULES = {
  SWITCH_MARGIN: 40,
  DWELL_MS: 90_000,
  ALL_IN_CUT_DWELL_MS: 20_000,
} as const;

const HAND_DONE = new Set(['HandComplete', 'WaitingForPlayers']);

export function scoreTable(t: FeaturedTableInput, ctx: FeaturedEventContext): number {
  let s = 2 * t.alive;
  if (t.handInProgress && t.contestedAllIn) s += 80;
  if (ctx.avgStack && ctx.avgStack > 0 && t.pot > 0) s += Math.min(40, (40 * t.pot) / ctx.avgStack);
  if (t.chipLeaderHere) s += 25;
  s += 10 * t.topThreeHere;
  if (t.shortStackPressure) s += 20;
  return s;
}

/** Why a table is worth showing (the first that applies). */
export function reasonOf(t: FeaturedTableInput, ctx: FeaturedEventContext): FeaturedReason {
  if (t.handInProgress && t.contestedAllIn) return 'all_in';
  if (t.shortStackPressure) return 'bubble';
  if (ctx.avgStack && ctx.avgStack > 0 && t.pot * 2 >= ctx.avgStack) return 'big_pot';
  if (t.chipLeaderHere) return 'chip_leader';
  return null;
}

/** The best table: highest score, then the lowest order (deterministic). */
function best(tables: ReadonlyArray<FeaturedTableInput>, ctx: FeaturedEventContext, pred: (t: FeaturedTableInput) => boolean = () => true): { t: FeaturedTableInput; score: number } | null {
  let out: { t: FeaturedTableInput; score: number } | null = null;
  for (const t of tables) {
    if (!pred(t)) continue;
    const score = scoreTable(t, ctx);
    if (!out || score > out.score || (score === out.score && t.order < out.t.order)) out = { t, score };
  }
  return out;
}

export interface FeaturedDecision {
  state: FeaturedState;
  /** The table changed (a 'featured' event, followers re-pointed). */
  changed: boolean;
  scores: Record<string, number>;
}

/**
 * The next featured state. `prev` null = the program's first pick (no 'changed').
 * `autoTable` false = no auto switching (only a break or the final table moves it).
 */
export function recommendFeatured(
  tables: ReadonlyArray<FeaturedTableInput>,
  ctx: FeaturedEventContext,
  prev: FeaturedState | null,
  now: number,
  opts: { lock?: FeaturedLock | null; autoTable?: boolean; rules?: Partial<typeof FEATURED_RULES> } = {},
): FeaturedDecision {
  const rules = { ...FEATURED_RULES, ...(opts.rules || {}) };
  const scores: Record<string, number> = {};
  for (const t of tables) scores[t.tableId] = Math.round(scoreTable(t, ctx) * 10) / 10;
  const to = (tableId: string | null, mode: FeaturedMode, reason: FeaturedReason): FeaturedDecision => {
    const sameTable = !!prev && prev.tableId === tableId;
    return {
      state: { tableId, mode, reason: sameTable && mode === 'auto' && prev!.mode === 'auto' ? prev!.reason : reason, since: sameTable ? prev!.since : now },
      changed: !!prev && !sameTable,
      scores,
    };
  };
  if (tables.length === 0) return to(null, 'auto', null);
  // 1. The final table.
  if (tables.length === 1) return to(tables[0].tableId, 'final_table', 'final_table');
  const byId = new Map(tables.map((t) => [t.tableId, t] as const));
  // 2. A producer lock (still in the event, not expired).
  const lock = opts.lock;
  if (lock && byId.has(lock.tableId) && (lock.until === null || lock.until > now)) return to(lock.tableId, 'producer', 'producer');
  const cur = prev && prev.tableId ? byId.get(prev.tableId) : undefined;
  if (!cur) {
    // No table yet, or the featured table left the event (broken): the best one now.
    const b = best(tables, ctx)!;
    return to(b.t.tableId, 'auto', prev && prev.tableId ? 'table_broken' : reasonOf(b.t, ctx));
  }
  // The same table, now on auto (a lock released / expired, or the final table undone).
  const keep = (): FeaturedDecision => to(cur.tableId, 'auto', prev!.mode === 'auto' ? prev!.reason : null);
  if (opts.autoTable === false) return keep();
  // 3. Never away from a contested all-in in play.
  if (cur.handInProgress && cur.contestedAllIn) return keep();
  const dwell = now - prev!.since;
  // 5. The all-in cut (mid-hand).
  if (cur.handInProgress) {
    if (dwell >= rules.ALL_IN_CUT_DWELL_MS) {
      const allIn = best(tables, ctx, (t) => t.tableId !== cur.tableId && t.handInProgress && t.contestedAllIn);
      if (allIn) return to(allIn.t.tableId, 'auto', 'all_in');
    }
    return keep();
  }
  // 4. At the hand boundary: a clearly better table, after the dwell.
  if (dwell >= rules.DWELL_MS) {
    const b = best(tables, ctx)!;
    if (b.t.tableId !== cur.tableId && b.score >= scoreTable(cur, ctx) + rules.SWITCH_MARGIN) return to(b.t.tableId, 'auto', reasonOf(b.t, ctx));
  }
  return keep();
}

/**
 * The recommender's inputs for one event, from the public table views (stacks,
 * pots, all-in / folded flags — no card). `bubble`: the event is on its bubble.
 */
export function featuredInputsOf(world: BroadcastWorld, t: Tournament, opts: { bubble: boolean; handForHand: boolean; bigBlind: number | null }): FeaturedTableInput[] {
  const ids = Array.isArray(t.tableIds) && t.tableIds.length > 0 ? t.tableIds : (t.tableId ? [t.tableId] : []);
  const live: Array<{ tableId: string; table: PublicTableView; order: number }> = [];
  ids.forEach((tableId, order) => {
    const table = world.table(tableId);
    if (table && table.seats.some((s) => s.state === 'occupied' && !s.eliminated)) live.push({ tableId, table, order });
  });
  // The top-3 stacks of the event (ties: the lower table order, then seat).
  const stacks: Array<{ tableId: string; chips: number; order: number; seat: number }> = [];
  for (const { tableId, table, order } of live) {
    for (const s of table.seats) if (s.state === 'occupied' && !s.eliminated) stacks.push({ tableId, chips: s.chipCount, order, seat: s.seatIndex });
  }
  stacks.sort((a, b) => (b.chips - a.chips) || (a.order - b.order) || (a.seat - b.seat));
  const leaderTable = stacks.length > 0 ? stacks[0].tableId : null;
  const top3 = stacks.slice(1, 3);
  const pressure = (opts.bubble || opts.handForHand) && !!opts.bigBlind && opts.bigBlind > 0;
  return live.map(({ tableId, table, order }) => {
    const occ = table.seats.filter((s) => s.state === 'occupied' && !s.eliminated);
    const handInProgress = !HAND_DONE.has(String(table.currentPhase));
    const contesting = occ.filter((s) => !s.folded);
    let pot = 0;
    try { pot = Number(table.getTotalPot()) || 0; } catch { pot = 0; }
    return {
      tableId,
      order,
      tableNo: tableNoOf(table.config.tableName, order),
      tableName: table.config.tableName,
      alive: occ.length,
      handInProgress,
      contestedAllIn: handInProgress && contesting.length >= 2 && contesting.some((s) => s.allIn),
      pot,
      chipLeaderHere: leaderTable === tableId,
      topThreeHere: top3.filter((x) => x.tableId === tableId).length,
      shortStackPressure: pressure && occ.some((s) => s.chipCount > 0 && s.chipCount <= 3 * (opts.bigBlind as number)),
    };
  });
}
