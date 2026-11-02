/**
 * 2026-11-02 (.online tournament broadcast, P2-S2) — THE PUBLIC PROGRAM DATA
 * of one event (spec §3 ProgramState), built from the live game server.
 *
 * buildProgramData is pure: it reads the game server only through the
 * BroadcastWorld view (index.ts builds it from tournamentManager, tableManager,
 * the qualifier registry, tournamentClockStateFor, the hand-for-hand states and
 * the opt-out cache). What it reads of a table is PublicTableView — a type with
 * NO hole cards, deck or community cards, so the compiler refuses any read of
 * them; the program carries NO card at all (cards appear only in a featured
 * table frame, P2-S3, under the contested-showdown gate). A leak on a public path
 * is a P0: tests/broadcastSnapshot.test.ts deep-scans built programs over dealt
 * hands for any {rank, suit} object and any id / seed key.
 *
 * Every name goes through broadcastNameOf at BUILD (= emit) time: 'First L.', a
 * one-word alias as is unless it is joined capitalised words ('JohnSmith' ->
 * 'John S.'), 'Player' when opted out or unknown (fail-closed); a bot
 * is never opted out. Entrants are keyed by broadcastPid (opaque, per event).
 *
 * The caller (wire.ts) memoizes one build per event per second and emits a
 * program frame only when the result changed (signature without programNow /
 * clock.serverNow).
 */
import type { Tournament, TournamentPlayer } from '../game/TournamentManager';
import { QUALIFIER_BASE_STACK, qualifierStructure, qualifierWindows, seatsForTopWith, seatsWonAt } from '../game/qualifierSchedule';
import { broadcastNameOf, broadcastPid, type OptOutIds } from './broadcastNames';
import {
  BROADCAST_LEADERS_MAX, BROADCAST_LEGAL_LINE,
  type ChannelId, type EventStatus, type ProgramEvent, type ProgramState, type SceneId, type TableSummary, type TickerEvent,
} from './contract';
import type { ArchivedTournament, EventWorld, ResolvedEvent } from './eventKey';

/** A seat as the public program reads it: no hole cards (by type). */
export interface PublicSeatView {
  seatIndex: number;
  state: string;
  chipCount: number;
  playerId: string;
  isAI: boolean;
  eliminated: boolean;
  allIn: boolean;
  folded: boolean;
}
/** A table as the public program reads it: no deck, no board, no hole cards (by type). */
export interface PublicTableView {
  config: { tableId: string; tableName: string; bigBlind: number };
  seats: ReadonlyArray<PublicSeatView>;
  handNumber: number;
  currentPhase: string;
  /** 2026-11-02 (P5) — PokerTable.variantId: the delayed hole-card feed arms Hold'em / Omaha only. */
  variantId?: string;
  getTotalPot(): number;
}
/** index.ts HandForHandState, as far as the program reads it. */
export interface HandForHandView {
  round: { no: number; base: ReadonlyMap<string, number>; attempted: ReadonlySet<string> } | null;
}

export interface BroadcastWorld extends EventWorld {
  table(tableId: string): PublicTableView | undefined;
  /** tournamentClockStateFor(tid)?.tournamentClock (index.ts), or null. */
  clockOf(tournamentId: string): Record<string, unknown> | null;
  /** The hand-for-hand state while engaged, else null. */
  handForHandOf(tournamentId: string): HandForHandView | null;
  /** TournamentManager.payoutTableOf for that tournament, or null. */
  payoutTableOf(tournamentId: string): { field: number; projected: boolean; payouts: Array<{ place: number; amount: number }> } | null;
  lateEntryClosedAtBubble(tournamentId: string): { at: number } | null;
  /** The opt-out cache: true / false, or undefined = unknown (shown as 'Player'). */
  optOut(ids: OptOutIds): boolean | undefined;
}

export interface ProgramBuild {
  program: ProgramState;
  tables: TableSummary[];
  /** The rank memory after this build (pass it to the next build of the same event). */
  rankMemory: RankMemory;
  tournamentId: string | null;
}

/** 'Qualifier Table 3' → 3; else the table's position in the event (1-based); else null. */
export function tableNoOf(tableName: string | undefined, index: number): number | null {
  const m = typeof tableName === 'string' ? /(\d+)\s*$/.exec(tableName) : null;
  if (m) return Number(m[1]);
  return index >= 0 ? index + 1 : null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const LIVE_PHASES_DONE = new Set(['HandComplete', 'WaitingForPlayers']);

interface Entrant {
  playerId: string;
  rawName: string;
  userId?: number;
  masterUserId?: string;
  bot: boolean;
  alive: boolean;
  chips: number;
  tableId: string | null;
  seatIndex: number | null;
}

/** The tables of an event, in its order (a single-table Sit & Go keeps only `tableId`). */
function eventTableIds(t: Tournament): string[] {
  if (Array.isArray(t.tableIds) && t.tableIds.length > 0) return t.tableIds.slice();
  return t.tableId ? [t.tableId] : [];
}

/** The program's view of the event's entrants: identity for the opt-out, live stack and seat. */
function entrantsOf(world: BroadcastWorld, ev: ResolvedEvent, t: Tournament | undefined, archived: ArchivedTournament | undefined,
  live: Array<{ tableId: string; table: PublicTableView }>): Map<string, Entrant> {
  const out = new Map<string, Entrant>();
  const reg = new Map<string, { localUserId?: number; masterPlayerId?: string }>();
  for (const p of ev.qt?.players || []) reg.set(p.playerId, p);
  const seatOf = new Map<string, { tableId: string; seat: PublicSeatView }>();
  for (const { tableId, table } of live) {
    for (const s of table.seats) {
      if (s.state !== 'occupied' || s.eliminated || !s.playerId) continue;
      if (!seatOf.has(s.playerId)) seatOf.set(s.playerId, { tableId, seat: s });
    }
  }
  const players: TournamentPlayer[] = t ? t.players : (archived ? archived.players : []);
  for (const p of players) {
    const r = reg.get(p.playerId);
    const at = seatOf.get(p.playerId);
    const userId = p.userId ?? r?.localUserId;
    const masterUserId = p.masterUserId ?? r?.masterPlayerId;
    const alive = !p.eliminated;
    out.set(p.playerId, {
      playerId: p.playerId,
      rawName: p.playerName,
      userId,
      masterUserId,
      bot: userId === undefined && !masterUserId && !!at?.seat.isAI,
      alive,
      chips: alive ? (at ? at.seat.chipCount : (p.chips || 0)) : 0,
      tableId: at ? at.tableId : null,
      seatIndex: at ? at.seat.seatIndex : null,
    });
  }
  return out;
}

/** The emit-time broadcast name of an entrant (opt-out from the cache; a bot is never opted out). */
export function entrantName(world: BroadcastWorld, e: { rawName: unknown; userId?: number; masterUserId?: string; bot: boolean }): string {
  let optOut: boolean | undefined;
  try { optOut = e.bot ? false : world.optOut({ userId: e.userId, masterUserId: e.masterUserId }); } catch { optOut = undefined; }
  return broadcastNameOf(e.rawName, optOut);
}

export function eventStatusOf(world: BroadcastWorld, ev: ResolvedEvent, t: Tournament | undefined, archived: ArchivedTournament | undefined, now: number): EventStatus {
  const qt = ev.qt;
  if (qt) {
    if (qt.status === 'finished') return qt.cancelled ? 'cancelled' : 'finished';
    if (qt.status === 'running' || qt.status === 'starting') return !t || t.pauseReason === 'prestart' ? 'tables_open' : 'running';
    const at = Date.parse(qt.scheduledAt);
    return Number.isFinite(at) && now < qualifierWindows(at).signupOpensAt ? 'scheduled' : 'registering';
  }
  if (!t) return archived ? 'finished' : 'cancelled';
  if (t.status === 'registering') return 'registering';
  if (t.status === 'running') return t.pauseReason === 'prestart' ? 'tables_open' : 'running';
  return t.status === 'finished' ? 'finished' : 'cancelled';
}

/** The scene the program suggests while scene.auto is on (the page's scene machine decides). */
export function autoSceneOf(status: EventStatus, clock: Record<string, unknown> | null, handForHandOn: boolean): SceneId {
  if (status === 'scheduled' || status === 'registering' || status === 'tables_open') return 'starting';
  if (status === 'finished') return 'results';
  if (status === 'cancelled') return 'slate';
  if (clock && clock.pauseReason === 'break') return 'break';
  if (handForHandOn) return 'hfh';
  return 'table';
}

/**
 * The PUBLIC program of one resolved event. Never reads a card. Throws only on a
 * programming error (the caller catches, counts and keeps the last good program).
 */
export function buildProgramData(input: {
  world: BroadcastWorld;
  ev: ResolvedEvent;
  channel: ChannelId | null;
  now: number;
  /** Already name-resolved, newest last. */
  ticker: TickerEvent[];
  /** The previous build's rank memory of this event (prevRank). */
  rankMemory?: RankMemory;
}): ProgramBuild {
  const { world, ev, channel, now } = input;
  const tid = ev.tournamentId;
  const t = tid ? world.tournament(tid) : undefined;
  const archived = !t && tid && ev.kind === 'sitgo' ? world.archived?.(tid) : undefined;
  const qt = ev.qt;
  let clock: Record<string, unknown> | null = null;
  if (t && tid) { try { clock = world.clockOf(tid); } catch { clock = null; } }
  const status = eventStatusOf(world, ev, t, archived, now);
  const started = status === 'running' || status === 'tables_open' || status === 'finished';

  // ---- the event's live tables (existing, with at least one live seat), in event order
  const liveTables: Array<{ tableId: string; table: PublicTableView; tableNo: number | null }> = [];
  if (t && (t.status === 'running')) {
    eventTableIds(t).forEach((tableId, i) => {
      const table = world.table(tableId);
      if (!table) return;
      if (!table.seats.some((s) => s.state === 'occupied' && !s.eliminated)) return;
      liveTables.push({ tableId, table, tableNo: tableNoOf(table.config.tableName, i) });
    });
  }
  const tableNoById = new Map(liveTables.map((x) => [x.tableId, x.tableNo] as const));

  const entrants = entrantsOf(world, ev, t, archived, liveTables);
  const pidOf = (playerId: string): string => broadcastPid(tid || ev.key, playerId);
  const nameOf = (e: Entrant | undefined, fallbackRaw?: string): string => (e ? entrantName(world, e) : broadcastNameOf(fallbackRaw, undefined));

  // ---- the event
  const scheduledAtRaw = qt ? Date.parse(qt.scheduledAt) : (t ? (t.startedAt || t.nextStartTime || t.createdAt) : (archived?.finishedAt ?? now));
  const scheduledAt = Number.isFinite(scheduledAtRaw) ? scheduledAtRaw : 0;
  const startingStack = qt ? (qt.startingStack || QUALIFIER_BASE_STACK) : (t?.config.startingChips || archived?.startingStack || 1000);
  const levels = qt
    ? qualifierStructure(startingStack).levels
    : (t?.config.blindLevels || []).map((l) => ({ sb: l.sb, bb: l.bb, ante: l.ante, minutes: round1(l.duration / 60) }));
  const registered = qt ? qt.players.length : (t ? t.players.length : (archived ? archived.players.length : 0));
  const entries = t && started ? (t.entries || t.players.length) : (archived ? archived.entries : registered);
  const alive = t && started ? t.players.filter((p) => !p.eliminated).length : (archived ? 0 : registered);

  let prizes: ProgramEvent['prizes'];
  if (qt) {
    const pkg = qt.seatPackage ?? null;
    const seatsForTop = seatsForTopWith(qt.qualifierType, pkg);
    const rows: ProgramEvent['prizes']['rows'] = [];
    for (let place = 1; place <= seatsForTop; place++) rows.push({ place, seats: seatsWonAt(qt.qualifierType, pkg, place) });
    const bubblePlace = seatsForTop > 0 ? seatsForTop + 1 : null;
    prizes = {
      kind: 'seats', seatsForTop, seatPackage: pkg ? Object.fromEntries(Object.entries(pkg).map(([k, v]) => [String(k), Number(v)])) : null,
      paidPlaces: seatsForTop || null, rows, bubblePlace, onBubble: status === 'running' && bubblePlace !== null && alive === bubblePlace,
    };
  } else {
    let payouts: Array<{ place: number; amount: number }> = [];
    if (t && tid) { try { payouts = world.payoutTableOf(tid)?.payouts || []; } catch { payouts = []; } }
    else if (archived) payouts = archived.finalResults.filter((r) => r.payout > 0 && r.position > 0).map((r) => ({ place: r.position, amount: r.payout }));
    const rows = payouts.filter((r) => r.amount > 0).sort((a, b) => a.place - b.place).map((r) => ({ place: r.place, amount: r.amount }));
    const paidPlaces = rows.length > 0 ? rows.length : null;
    const bubblePlace = paidPlaces ? paidPlaces + 1 : null;
    prizes = { kind: 'chips', seatsForTop: null, seatPackage: null, paidPlaces, rows, bubblePlace, onBubble: status === 'running' && bubblePlace !== null && alive === bubblePlace };
  }

  let lateReg: ProgramEvent['lateReg'] = { open: null, until: null, closedReason: null };
  if (qt && Number.isFinite(scheduledAtRaw)) {
    const w = qualifierWindows(scheduledAtRaw);
    let bubbleClose: { at: number } | null = null;
    if (t && tid) { try { bubbleClose = world.lateEntryClosedAtBubble(tid); } catch { bubbleClose = null; } }
    const playing = status === 'running' || status === 'tables_open';
    lateReg = {
      open: playing ? (now <= w.lateRegUntil && !bubbleClose) : null,
      until: w.lateRegUntil,
      closedReason: bubbleClose ? 'seat_bubble' : (playing && now > w.lateRegUntil ? 'time' : null),
    };
  }

  const event: ProgramEvent = {
    kind: ev.kind,
    qualifierId: ev.qualifierId,
    tournamentId: tid,
    name: qt ? qt.qualifierName : (t ? t.config.name : (archived ? archived.name : 'Tournament')),
    title: null,
    status,
    scheduledAt,
    dealsAt: num(clock?.dealsAt),
    registered,
    entries,
    startingStack,
    levels,
    howToEnter: null,
    prizes,
    lateReg,
  };

  // ---- standings
  const bbNow = num(clock?.bb) ?? (t ? (t.config.blindLevels[t.currentBlindLevel]?.bb ?? null) : null);
  const avgStack = num(clock?.avgStack) ?? (started && alive > 0 && entries > 0 ? Math.round((entries * startingStack) / alive) : null);
  const aliveList = [...entrants.values()].filter((e) => e.alive && started && status !== 'finished')
    .map((e) => ({ e, pid: pidOf(e.playerId) }))
    .sort((a, b) => (b.e.chips - a.e.chips) || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0));
  const ranks = new Map<string, number>();
  aliveList.forEach((x, i) => ranks.set(x.pid, i + 1));
  const rankMemory = nextRankMemory(input.rankMemory, ranks);
  const leaders = aliveList.slice(0, BROADCAST_LEADERS_MAX).map((x, i) => ({
    pid: x.pid,
    name: nameOf(x.e),
    chips: x.e.chips,
    bb: bbNow && bbNow > 0 ? round1(x.e.chips / bbNow) : null,
    tableNo: x.e.tableId ? (tableNoById.get(x.e.tableId) ?? null) : null,
    rank: i + 1,
    prevRank: rankMemory.prev.get(x.pid) ?? null,
  }));
  const leaderTableId = aliveList.length > 0 ? aliveList[0].e.tableId : null;

  // ---- hand-for-hand
  let handForHand: ProgramState['handForHand'] = null;
  if (t && tid && status === 'running') {
    let hfh: HandForHandView | null = null;
    try { hfh = world.handForHandOf(tid); } catch { hfh = null; }
    if (hfh) {
      const r = hfh.round;
      handForHand = {
        on: true,
        round: r ? r.no : null,
        tables: liveTables.map(({ tableId, table, tableNo }) => {
          const base = r ? r.base.get(tableId) : undefined;
          let state: 'waiting' | 'playing' | 'done' = 'waiting';
          if (r && base !== undefined && r.attempted.has(tableId) && table.handNumber > base) {
            state = LIVE_PHASES_DONE.has(String(table.currentPhase)) ? 'done' : 'playing';
          }
          return { tableId, tableNo, state };
        }),
      };
    }
  }

  // ---- results (only once finished: programNow >= the finish on the public live feed)
  let results: ProgramState['results'] = null;
  if (status === 'finished') {
    if (qt) {
      const finals = t?.finalResults || [];
      results = (qt.results || []).slice().sort((a, b) => a.place - b.place).map((r) => {
        const reg = r.masterUserId ? qt.players.find((p) => p.masterPlayerId === r.masterUserId) : undefined;
        const e = reg ? entrants.get(reg.playerId) : undefined;
        const tied = reg ? finals.find((f) => f.playerId === reg.playerId)?.tied === true : false;
        const name = e ? entrantName(world, e)
          : broadcastNameOf(r.playerName, (() => { try { return world.optOut({ userId: reg?.localUserId, masterUserId: r.masterUserId }); } catch { return undefined; } })());
        return {
          place: r.place,
          pid: reg ? pidOf(reg.playerId) : broadcastPid(tid || ev.key, `place:${r.place}`),
          name,
          seatsWon: r.seats ?? (r.wonSeat ? 1 : 0),
          ...(tied ? { tied: true } : {}),
        };
      });
    } else {
      const finals = (t?.finalResults || archived?.finalResults || []).filter((r) => r.position > 0 && !r.disqualified)
        .slice().sort((a, b) => a.position - b.position);
      results = finals.map((r) => ({
        place: r.position,
        pid: pidOf(r.playerId),
        name: nameOf(entrants.get(r.playerId)),
        ...(r.payout > 0 ? { amount: r.payout } : {}),
        ...(r.tied ? { tied: true } : {}),
      }));
    }
  }

  // ---- the final table (one table left in play)
  let finalTable: ProgramState['finalTable'] = null;
  if (status === 'running' && liveTables.length === 1) {
    const only = liveTables[0];
    finalTable = {
      seats: only.table.seats.filter((s) => s.state === 'occupied' && !s.eliminated && !!s.playerId).map((s) => ({
        seatIndex: s.seatIndex,
        pid: pidOf(s.playerId),
        name: nameOf(entrants.get(s.playerId)),
        chips: s.chipCount,
      })),
    };
  }

  // ---- table summaries (snapshot only; public numbers)
  const tables: TableSummary[] = liveTables.map(({ tableId, table, tableNo }) => {
    const occ = table.seats.filter((s) => s.state === 'occupied' && !s.eliminated);
    let pot = 0;
    try { pot = Number(table.getTotalPot()) || 0; } catch { pot = 0; }
    return {
      tableId,
      tableNo,
      tableName: table.config.tableName,
      players: occ.length,
      handNumber: table.handNumber,
      pot,
      allIn: !LIVE_PHASES_DONE.has(String(table.currentPhase)) && occ.some((s) => s.allIn && !s.folded),
      biggestStack: occ.reduce((m, s) => Math.max(m, s.chipCount), 0),
      chipLeaderHere: leaderTableId === tableId,
    };
  });

  const hfhOn = !!handForHand && handForHand.on;
  const program: ProgramState = {
    v: 1,
    channel,
    eventKey: ev.key,
    onAir: false,
    rehearsal: false,
    programNow: now,
    event,
    scene: { id: autoSceneOf(status, clock, hfhOn), auto: true, since: 0 },
    featured: { tableId: null, tableNo: null, tableName: null, mode: 'auto', reason: null, since: 0 },
    clock,
    standings: {
      playersLeft: alive,
      entries,
      avgStack,
      avgStackBb: avgStack !== null && bbNow && bbNow > 0 ? round1(avgStack / bbNow) : null,
      paidPlaces: prizes.paidPlaces,
      tables: liveTables.length,
      leaders,
    },
    ticker: input.ticker,
    handForHand,
    lowerThirds: [],
    legal: { line: BROADCAST_LEGAL_LINE, platformLine: null },
    results,
    finalTable,
  };
  return { program, tables, rankMemory, tournamentId: tid };
}

/**
 * The change signature of a program: everything but the fields that move every
 * build (programNow, clock.serverNow). Equal signatures = no frame.
 */
export function programSignature(p: ProgramState): string {
  const clock = p.clock ? { ...p.clock, serverNow: 0 } : null;
  return JSON.stringify({ ...p, programNow: 0, clock });
}

/**
 * prevRank memory per event: `last` = the ranks of the latest build, `prev` = the
 * ranks BEFORE the latest change of the order — so a leader's arrow stays up
 * until the order changes again (prevRank = prev.get(pid); null = new / first).
 */
export interface RankMemory { last: Map<string, number>; prev: Map<string, number> }
export function nextRankMemory(mem: RankMemory | undefined, ranks: Map<string, number>): RankMemory {
  if (!mem) return { last: ranks, prev: new Map() };
  let changed = mem.last.size !== ranks.size;
  if (!changed) for (const [k, v] of ranks) if (mem.last.get(k) !== v) { changed = true; break; }
  return changed ? { last: ranks, prev: mem.last } : mem;
}
