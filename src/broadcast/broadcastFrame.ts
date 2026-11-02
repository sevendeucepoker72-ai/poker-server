/**
 * 2026-11-02 (.online tournament broadcast, P2-S3) — THE TABLE FRAME of the
 * featured (or a pinned) table on the PUBLIC feed: spec §3 BroadcastTableFrame.
 *
 * toBroadcastTableFrame is pure. It reads a table ONLY through FrameTableView,
 * a type whose seats carry NO hole cards: the compiler refuses any read of
 * seat.holeCards here. The only cards a public frame can carry:
 *   - the board (communityCards: already public to everyone at the table);
 *   - at a CONTESTED showdown — the Showdown / HandComplete of the hand the
 *     engine just resolved with wentToShowdown (>= 2 hands tabled) — the tabled
 *     hands of the seats that did not fold and did not muck, read from the
 *     engine's own showdown record (lastHandResult.showdownHands). That is the
 *     gate of index.ts getGameStateForPlayer: a fold win, a folded seat and an
 *     auto-muck show nothing.
 * A hole-card leak on a public path is a P0: tests/broadcastFrame.test.ts runs
 * the builder over real hands with seats whose holeCards getter THROWS, and
 * deep-scans every frame.
 *
 * Names are applied at EMIT time through the caller's identityOf (broadcastNameOf:
 * 'First L.', a one-word alias (joined capitalised words -> 'First L.'), 'Player'
 * when opted out or unknown); entrants are
 * keyed by broadcastPid. A frame never carries playerId, publicId, the action
 * log's names, a seed or the deck.
 */
import { MAX_SEATS } from '../game/PokerTable';
import { broadcastNameOf, broadcastPid } from './broadcastNames';
import { entrantName, type BroadcastWorld } from './broadcastSnapshot';
import type { BroadcastTableFrame, Card } from './contract';
import type { ResolvedEvent } from './eventKey';

/** A seat as a frame reads it: no hole cards (by type). */
export interface FrameSeatView {
  seatIndex: number;
  state: string;
  playerName: string;
  playerId: string;
  isAI: boolean;
  chipCount: number;
  currentBet: number;
  folded: boolean;
  allIn: boolean;
  eliminated: boolean;
}

/** One tabled hand of the engine's showdown record (it exists only at a contested showdown). */
export interface FrameShowdownHand {
  seatIndex: number;
  /** Who tabled it (the engine's record): shown only while the same player holds the seat. */
  playerId?: string;
  playerName?: string;
  handName: string;
  holeCards: ReadonlyArray<{ rank: number; suit: number }>;
}

/** A table as a frame reads it (PokerTable satisfies it): no deck, no seed, no seat hole cards. */
export interface FrameTableView {
  config: { tableId: string; tableName: string; smallBlind: number; bigBlind: number; ante?: number };
  seats: ReadonlyArray<FrameSeatView>;
  handNumber: number;
  currentPhase: string;
  communityCards: ReadonlyArray<{ rank: number; suit: number }>;
  dealerButtonSeat: number;
  smallBlindSeat: number;
  previousBigBlindSeat: number;
  deadSmallBlind: boolean;
  activeSeatIndex: number;
  handSmallBlind: number;
  handBigBlind: number;
  handAnte: number;
  maxOccupiableSeats: number;
  wentToShowdown: boolean;
  lastHandResult: {
    handNumber: number;
    winners: ReadonlyArray<{ seatIndex: number; chipsWon: number; handName: string }>;
    showdownHands: ReadonlyArray<FrameShowdownHand>;
  } | null;
  actionLog: ReadonlyArray<{ seatIndex: number; action: string }>;
  getTotalPot(): number;
  getCurrentPots(): ReadonlyArray<{ amount: number; eligibleSeatIndices: ReadonlyArray<number> }>;
  showdownMuckedSeats(): ReadonlySet<number>;
  isDealtOut(seatIndex: number): boolean;
}

export interface FrameContext {
  now: number;
  tableNo: number | null;
  featured: boolean;
  /** index.ts turnStartedAtMap / currentTurnTimeoutMs; null / 0 = unknown. */
  turn?: { startedAt: number | null; timeout: number | null } | null;
  /** index.ts sitOutTracker (the seats that chose Sit Out / were sat out). */
  sittingOut?: ReadonlySet<number> | null;
  /** The emit-time broadcast identity of a seat. */
  identityOf(seat: FrameSeatView): { pid: string; name: string };
  /** Server ms the frame's hand ended LIVE (the handResult hook); null while it is played. */
  liveHandEndedAt?: number | null;
}

const SHOW_PHASES = new Set(['Showdown', 'HandComplete']);
/** The engine's action texts ('raised to 600', 'went all-in for 1500', 'posted SB 25' …): no names, no cards. */
const ACTION_TEXT = /^[A-Za-z0-9 ()-]{1,48}$/;

const toCard = (c: { rank: number; suit: number }): Card => ({ rank: Number(c.rank), suit: Number(c.suit) as Card['suit'] });
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The seats whose hand is face up at a CONTESTED showdown (cards + hand name) and
 * the seats that mucked there. Anything off the gate → nothing (fail closed: a
 * throw from the engine's muck rule shows no card at all).
 */
export function showdownReveal(view: FrameTableView): { shown: Map<number, { cards: Card[]; handName: string | null }>; mucked: Set<number> } {
  const shown = new Map<number, { cards: Card[]; handName: string | null }>();
  const mucked = new Set<number>();
  if (!SHOW_PHASES.has(String(view.currentPhase))) return { shown, mucked };
  const r = view.lastHandResult;
  if (!r || r.handNumber !== view.handNumber || !view.wentToShowdown) return { shown, mucked };
  let muckedSeats: ReadonlySet<number>;
  try { muckedSeats = view.showdownMuckedSeats(); } catch { return { shown, mucked }; }
  for (const i of muckedSeats) mucked.add(i);
  for (const h of r.showdownHands || []) {
    const seat = view.seats.find((s) => s.seatIndex === h.seatIndex);
    if (!seat || seat.state === 'empty' || seat.folded || mucked.has(h.seatIndex)) continue;
    // Review fix (2026-11-02): the seat must still hold the player who TABLED the hand (a
    // busted player's seat re-filled by a move before the next deal shows nothing, not his
    // cards under the newcomer's name). A record without an id falls back to the name.
    if (typeof h.playerId === 'string' && h.playerId) {
      if (seat.playerId !== h.playerId) continue;
    } else if (typeof h.playerName === 'string' && h.playerName && seat.playerName !== h.playerName) continue;
    if (!Array.isArray(h.holeCards) || h.holeCards.length === 0) continue;
    shown.set(h.seatIndex, { cards: h.holeCards.map(toCard), handName: typeof h.handName === 'string' ? h.handName : null });
  }
  return { shown, mucked };
}

/** The PUBLIC frame of one table. Throws only on a programming error (the caller catches and keeps the last frame). */
export function toBroadcastTableFrame(view: FrameTableView, ctx: FrameContext): BroadcastTableFrame {
  const phase = String(view.currentPhase);
  const inHand = phase !== 'WaitingForPlayers';
  const { shown, mucked } = showdownReveal(view);
  const idOf = new Map<number, { pid: string; name: string }>();
  const seats: BroadcastTableFrame['seats'] = [];
  for (const s of view.seats) {
    if (s.state === 'empty' || !s.playerId) continue;
    const id = ctx.identityOf(s);
    idOf.set(s.seatIndex, id);
    let dealtOut = false;
    try { dealtOut = view.isDealtOut(s.seatIndex); } catch { dealtOut = false; }
    const r = shown.get(s.seatIndex);
    const seat: BroadcastTableFrame['seats'][number] = {
      seatIndex: s.seatIndex,
      pid: id.pid,
      name: id.name,
      chips: Number(s.chipCount) || 0,
      bet: Number(s.currentBet) || 0,
      folded: !!s.folded,
      allIn: !!s.allIn,
      sittingOut: s.state === 'sitting_out' || !!ctx.sittingOut?.has(s.seatIndex),
      eliminated: !!s.eliminated,
      // Card BACKS: in this hand, not folded, not dealt out. Never a face.
      hasCards: inHand && !s.eliminated && !s.folded && !dealtOut,
      holeCards: r ? r.cards : null,
    };
    if (mucked.has(s.seatIndex)) seat.mucked = true;
    if (r) seat.handName = r.handName;
    seats.push(seat);
  }

  let pot = 0;
  try { pot = Number(view.getTotalPot()) || 0; } catch { pot = 0; }
  let pots: BroadcastTableFrame['pots'];
  try {
    pots = view.getCurrentPots().map((p) => ({ amount: Number(p.amount) || 0, eligibleSeats: [...p.eligibleSeatIndices] }));
  } catch { pots = undefined; }

  let lastAction: BroadcastTableFrame['lastAction'];
  const lastLog = inHand && view.actionLog.length > 0 ? view.actionLog[view.actionLog.length - 1] : undefined;
  if (lastLog && typeof lastLog.action === 'string' && ACTION_TEXT.test(lastLog.action) && Number.isInteger(lastLog.seatIndex)) {
    const amt = /(\d+)/.exec(lastLog.action);
    lastAction = { seatIndex: lastLog.seatIndex, text: lastLog.action, ...(amt ? { amount: Number(amt[1]) } : {}) };
  }

  let handResult: BroadcastTableFrame['handResult'] = null;
  const r = view.lastHandResult;
  if (SHOW_PHASES.has(phase) && r && r.handNumber === view.handNumber) {
    handResult = {
      winners: (r.winners || []).filter((w) => (Number(w.chipsWon) || 0) > 0).map((w) => {
        const id = idOf.get(w.seatIndex);
        const shownHere = shown.get(w.seatIndex);
        return {
          seatIndex: w.seatIndex,
          name: id ? id.name : broadcastNameOf(undefined, undefined),
          amount: Number(w.chipsWon) || 0,
          // A hand's strength only with its cards face up (never for a fold win).
          ...(shownHere && shownHere.handName ? { handName: shownHere.handName } : {}),
        };
      }),
      showdownSeats: [...shown.keys()].sort((a, b) => a - b),
      muckedSeats: [...mucked].sort((a, b) => a - b),
    };
  }

  const handLevelOnTable = view.handBigBlind > 0 && view.handNumber > 0 && inHand;
  const turnStartedAt = finite(ctx.turn?.startedAt);
  const turnTimeout = finite(ctx.turn?.timeout);
  const frame: BroadcastTableFrame = {
    t: ctx.now,
    tableId: view.config.tableId,
    tableNo: ctx.tableNo,
    tableName: view.config.tableName,
    maxSeats: Math.min(MAX_SEATS, view.maxOccupiableSeats || MAX_SEATS),
    featured: ctx.featured,
    handNumber: view.handNumber,
    phase,
    handLevel: {
      sb: handLevelOnTable && view.handSmallBlind > 0 ? view.handSmallBlind : view.config.smallBlind,
      bb: handLevelOnTable ? view.handBigBlind : view.config.bigBlind,
      ante: handLevelOnTable ? view.handAnte : (view.config.ante || 0),
    },
    dealerSeat: view.dealerButtonSeat,
    smallBlindSeat: view.deadSmallBlind ? -1 : view.smallBlindSeat,
    bigBlindSeat: view.previousBigBlindSeat,
    activeSeat: view.activeSeatIndex,
    turnStartedAt: turnStartedAt && turnStartedAt > 0 && view.activeSeatIndex >= 0 ? turnStartedAt : null,
    turnTimeout: turnTimeout && turnTimeout > 0 && view.activeSeatIndex >= 0 ? turnTimeout : null,
    pot,
    board: view.communityCards.slice(0, 5).map(toCard),
    seats,
    handResult,
    liveHandEndedAt: finite(ctx.liveHandEndedAt) ?? null,
  };
  if (pots) frame.pots = pots;
  if (lastAction) frame.lastAction = lastAction;
  return frame;
}

/** The change signature of a frame (everything but its build time). Equal = no frame. */
export function frameSignature(f: BroadcastTableFrame): string {
  return JSON.stringify({ ...f, t: 0 });
}

/**
 * The emit-time identity of a seat at an event's table: pid (opaque, per event)
 * and broadcast name (opt-out from the cache; a bot is never opted out). One
 * resolver per flush: lookups are memoized by playerId.
 */
export function seatIdentityResolver(world: BroadcastWorld, ev: ResolvedEvent): (seat: Pick<FrameSeatView, 'playerId' | 'playerName' | 'isAI'>) => { pid: string; name: string } {
  const tid = ev.tournamentId;
  const t = tid ? world.tournament(tid) : undefined;
  const players = new Map((t?.players || []).map((p) => [p.playerId, p] as const));
  const reg = new Map((ev.qt?.players || []).map((p) => [p.playerId, p] as const));
  const memo = new Map<string, { pid: string; name: string }>();
  return (seat) => {
    const hit = memo.get(seat.playerId);
    if (hit) return hit;
    const tp = players.get(seat.playerId);
    const r = reg.get(seat.playerId);
    const userId = tp?.userId ?? r?.localUserId;
    const masterUserId = tp?.masterUserId ?? r?.masterPlayerId;
    const id = {
      pid: broadcastPid(tid || ev.key, seat.playerId),
      name: entrantName(world, {
        rawName: tp ? tp.playerName : (r?.playerName ?? seat.playerName),
        userId,
        masterUserId,
        bot: userId === undefined && !masterUserId && !!seat.isAI,
      }),
    };
    memo.set(seat.playerId, id);
    return id;
  };
}
