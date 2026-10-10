/* eslint-disable */
/**
 * 2026-10-10 hotfix regression — "it is auto folding me without me hitting
 * anything". Runs the REAL src/index.ts text (the wedge watchdog setInterval,
 * armTurnTimer, autoActForSeat + helpers) against the REAL PokerTable engine
 * under jest fake timers: 4 near-instant bots + 1 PRESENT human (seat 4).
 *
 * Before the fix the watchdog sampled only the active seat INDEX every 15s, so
 * a seat active at three samples in a row (three different turns) was read as
 * "stuck 30000ms" and folded/checked a few seconds into a fresh turn (live:
 * hands 223 / 233 / 244 on table 090a0e6e).
 */
const { PokerTable, GamePhase } = require('../src/game/PokerTable');
const { slice, fnSrc, load } = require('./helpers/indexSource');

const TID = 'wd-sim';
const JOSH = 4;
function lcg(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

const LIVE_CODE = [
  fnSrc('function seatHasLiveSession(tableId: string, seatIndex: number): boolean {'),
  fnSrc('function isAbsentTournamentSeatPastHandLimit('),
  fnSrc('function seatHasPlayingSession('),
  fnSrc('function tournamentSeatSitsOut('),
  fnSrc('function absentTournamentSeatMayLimp('),
  fnSrc('function autoActForSeat('),
  fnSrc('function armTurnTimer(tableId: string): void {'),
  slice('const WEDGE_TURN_GRACE_MS', '}, 15000);'),
].join('\n\n');

type Opts = {
  humans: number[]; humanDelay: (r: () => number) => number | null; aiDelay: (r: () => number) => number;
  seed: number; seats?: number[];
  /** simulate a dead turn clock: drop every armed timer right after it is armed */
  killTurnTimer?: boolean;
  /** simulate an engine oscillation: never act; bounce the active seat between two seats */
  oscillate?: [number, number];
};

function run(opts: Opts, simMs: number) {
  const rng = lcg(opts.seed);
  const table = new PokerTable({ tableId: TID, tableName: 'Sim', smallBlind: 100, bigBlind: 200, ante: 0, minBuyIn: 20000 } as any);
  const seats = opts.seats ?? [0, 1, 2, 3, 4];
  for (const i of seats) table.sitDown(i, opts.humans.includes(i) ? `Human${i}` : `AI${i}`, 50_000_000, `p${i}`, !opts.humans.includes(i));
  const out = { forced: [] as any[], humanActs: 0, humanTurns: 0, watchdogFires: 0, timerActs: 0, hands: 0, firstFireAt: -1 };
  let actor: string | null = null;
  let lastWatchdogAt = -1; let lastReason = '';
  const t0 = Date.now();
  const sessions = new Map<string, any>();
  for (const h of opts.humans) sessions.set('sock' + h, { tableId: TID, seatIndex: h, sittingOut: false });
  const scope: any = {
    tableManager: { getTable: (id: string) => (id === TID ? table : undefined), getTableList: () => [{ tableId: TID }] },
    GamePhase, DrawPhases: [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3], MAX_SEATS: 9,
    playerSessions: sessions, reservedSeats: new Map(),
    isTournamentTable: () => false, isTournamentReservation: () => false,
    tournamentHandStartSafety: { allAbsentAutoCalls: 0 },
    turnTimers: new Map(), turnWarningTimers: new Map(), turnStartedAtMap: new Map(), turnStartedSeatMap: new Map(),
    turnStartedHandMap: new Map(), turnStartedPhaseMap: new Map(), globalTurnId: 0,
    TURN_TIMEOUT_MS: 30000, ABSENT_TOURNAMENT_SEAT_TURN_MS: 3000,
    // 2026-10-10 — the turn-timer act logs at info now (it is the record of
    // every turn the server takes); count exactly those lines.
    log: { debug: () => {}, info: (m: string) => { if (String(m).startsWith('[Timer]')) out.timerActs++; } },
    console: {
      log: () => {},
      warn: (m: string) => { if (String(m).startsWith('[WedgeWatchdog] Table')) { lastReason = String(m).replace(/^.*? (stuck|pot)/, '$1'); out.watchdogFires++; lastWatchdogAt = Date.now(); if (out.firstFireAt < 0) out.firstFireAt = Date.now() - t0; } },
      error: () => {},
    },
    scheduleAIAction: () => {},
  };
  const arm = (id: string) => {
    live.armTurnTimer(id);
    if (opts.killTurnTimer) { const e = scope.turnTimers.get(id); if (e) { clearTimeout(e.timeout); scope.turnTimers.delete(id); } }
  };
  scope.broadcastGameState = (id: string) => arm(id);
  const live = load(LIVE_CODE, scope, '{ armTurnTimer, autoActForSeat }').exports;

  const wrap = (name: 'playerFold' | 'playerCheck') => {
    const orig = table[name].bind(table);
    table[name] = (seat: number) => {
      const turnAgeMs = Date.now() - scope.turnStartedAtMap.get(TID);
      const ok = orig(seat);
      if (ok && opts.humans.includes(seat) && actor !== 'human') {
        out.forced.push({ reason: lastWatchdogAt === Date.now() ? lastReason : '', by: lastWatchdogAt === Date.now() ? 'WATCHDOG' : 'turn-timer', action: name, seat, hand: table.handNumber, turnAgeMs });
      }
      return ok;
    };
  };
  wrap('playerFold'); wrap('playerCheck');

  let turnSeq = 0;
  const scheduleActor = () => {
    if (opts.oscillate) return;
    const seat = table.activeSeatIndex;
    const mySeq = ++turnSeq;
    if (!table.isHandInProgress() || seat < 0) return;
    const isHuman = opts.humans.includes(seat);
    if (isHuman) out.humanTurns++;
    const delay = isHuman ? opts.humanDelay(rng) : opts.aiDelay(rng);
    if (delay == null) return;
    setTimeout(() => {
      if (turnSeq !== mySeq || table.activeSeatIndex !== seat || !table.isHandInProgress()) return;
      const callAmt = table.currentBetToMatch - table.seats[seat].currentBet;
      actor = isHuman ? 'human' : 'ai';
      const r = rng();
      let ok = false;
      if (callAmt > 0) ok = (!isHuman && r < 0.3) ? table.playerFold(seat) : table.playerCall(seat);
      else ok = table.playerCheck(seat);
      actor = null;
      if (ok && isHuman) out.humanActs++;
      scope.broadcastGameState(TID);
    }, delay);
  };
  table.on('turnChanged', () => { arm(TID); scheduleActor(); });
  table.on('phaseChanged', ({ phase }: any) => {
    if (phase === GamePhase.HandComplete) {
      out.hands++;
      setTimeout(() => { table.startNewHand(); scope.broadcastGameState(TID); }, 1500);
    }
  });
  table.startNewHand();
  scope.broadcastGameState(TID);
  if (opts.oscillate) {
    // A wedged engine: the active seat bounces, nobody's chips move, the street never ends.
    let k = 0;
    const iv = setInterval(() => {
      if (out.watchdogFires > 0) { clearInterval(iv); return; }
      table.activeSeatIndex = opts.oscillate![k++ % 2];
      scope.broadcastGameState(TID);
    }, 2000);
  }
  for (let t = 0; t < simMs; t += 1000) jest.advanceTimersByTime(1000);
  return out;
}

describe('wedge watchdog is turn-aware (2026-10-10 hotfix)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  test('A: a PRESENT human who acts in 3-12s is never acted for (was ~11% of his turns)', () => {
    for (const seed of [7, 8, 9]) {
      const o = run({ humans: [JOSH], seed, humanDelay: (r) => 3000 + Math.floor(r() * 9000), aiDelay: (r) => 800 + Math.floor(r() * 1700) }, 60 * 60 * 1000);
      expect(o.humanTurns).toBeGreaterThan(200);
      expect(o.forced).toEqual([]);
      expect(o.watchdogFires).toBe(0);
    }
  });

  test('A2: a human who thinks 20-29s is never acted for either', () => {
    const o = run({ humans: [JOSH], seed: 5, humanDelay: (r) => 20000 + Math.floor(r() * 9000), aiDelay: (r) => 800 + Math.floor(r() * 1700) }, 60 * 60 * 1000);
    expect(o.forced).toEqual([]);
    expect(o.watchdogFires).toBe(0);
  });

  test('B: an AFK human is acted for by the 30s TURN TIMER only, never early by the watchdog', () => {
    const o = run({ humans: [JOSH], seed: 3, humanDelay: () => null, aiDelay: (r) => 800 + Math.floor(r() * 1700) }, 30 * 60 * 1000);
    expect(o.timerActs).toBeGreaterThan(0);
    expect(o.forced.length).toBeGreaterThan(0);
    for (const f of o.forced) { expect(f.by).toBe('turn-timer'); expect(f.turnAgeMs).toBe(30000); }
    expect(o.watchdogFires).toBe(0);
  });

  test('C: an all-bot table produces no watchdog fires', () => {
    const o = run({ humans: [], seats: [0, 1, 2], seed: 11, humanDelay: () => null, aiDelay: (r) => 800 + Math.floor(r() * 1700) }, 60 * 60 * 1000);
    expect(o.hands).toBeGreaterThan(100);
    expect(o.watchdogFires).toBe(0);
  });

  test('D: a DEAD turn clock is still recovered by the watchdog (safety net kept)', () => {
    const o = run({ humans: [JOSH], seed: 3, humanDelay: () => null, aiDelay: (r) => 800 + Math.floor(r() * 1700), killTurnTimer: true }, 10 * 60 * 1000);
    expect(o.timerActs).toBe(0);
    expect(o.forced.length).toBeGreaterThan(0);
    for (const f of o.forced) { expect(f.by).toBe('WATCHDOG'); expect(f.turnAgeMs).toBeGreaterThanOrEqual(30000); expect(f.turnAgeMs).toBeLessThanOrEqual(60000); }
  });

  test('E: a real OSCILLATION (seat bounces, no chips/street move) is still caught', () => {
    const o = run({ humans: [], seats: [0, 1, 2], seed: 2, humanDelay: () => null, aiDelay: () => 1000, oscillate: [0, 1] }, 3 * 60 * 1000);
    expect(o.watchdogFires).toBeGreaterThan(0);
    expect(o.firstFireAt).toBeLessThanOrEqual(50000);
  });
});
