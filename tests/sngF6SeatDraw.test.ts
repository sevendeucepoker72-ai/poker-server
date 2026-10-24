/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F6) — a Sit & Go /
 * non-qualifier tournament starts with a RANDOM SEAT DRAW and a RANDOM FIRST
 * BUTTON (TDA). The 9-player event seated everyone in registration order with
 * the first button on seat 0, every time.
 *  - startTournamentGame (one table): seat k = tournament.players[order[k]]
 *    (drawSeatOrder: Fisher-Yates with crypto randomInt, as the qualifier
 *    draw); the first hand's button is presetFirstButton(randomInt(n)).
 *  - startRegisteredTournamentTables (more than 9): the round-robin follows the
 *    drawn order; each table's first button is drawn among its occupied seats.
 *  - tournament.players keeps its registration order.
 *  - Qualifiers (startQualifierTournament) are untouched: their draw exists
 *    (the first button is seat 0 of a random seating).
 *
 * The REAL startTournamentGame / startRegisteredTournamentTables (sliced) with
 * the REAL TournamentManager and PokerTable.
 */
import { PokerTable } from '../src/game/PokerTable';
import { TournamentManager } from '../src/game/TournamentManager';
import { fnSrc, load } from './helpers/indexSource';

/** A deterministic randomInt: a fixed sequence (mod the bound). */
function seq(values: number[]) {
  let i = 0;
  const calls: number[] = [];
  const fn = (max: number) => { calls.push(max); const v = values[i++ % values.length] % max; return v; };
  return { fn, calls };
}
/** The reference draw (the qualifier's algorithm) over the same sequence. */
function refDraw(n: number, values: number[]): { order: number[]; used: number } {
  const order = Array.from({ length: n }, (_, k) => k);
  let i = 0;
  for (let a = n - 1; a > 0; a--) {
    const j = values[i++ % values.length] % (a + 1);
    [order[a], order[j]] = [order[j], order[a]];
  }
  return { order, used: i };
}

function world(randomInt: (max: number) => number) {
  const tm = new TournamentManager();
  const tables = new Map<string, PokerTable>();
  let n = 0;
  const tableManager = {
    createQuickTable: (name: string, max: number, sb: number, bb: number, minBuyIn: number, _v: any, ante = 0) => {
      const id = `T${++n}`;
      tables.set(id, new PokerTable({ tableId: id, tableName: name, smallBlind: sb, bigBlind: bb, ante, minBuyIn: 1, maxBuyIn: 1_000_000, maxPlayers: max } as any));
      return id;
    },
    getTable: (id: string) => tables.get(id),
  };
  const tournamentTables = new Map<string, string>();
  const scope: Record<string, unknown> = {
    tournamentManager: tm, tableManager, tournamentTables, randomInt,
    bindRegistrantSocket: () => null, ensureTableProgressListener() {}, broadcastGameState() {}, scheduleAIAction() {},
    bootstrapTournamentTables: (_tid: string, ids: string[]) => { for (const id of ids) tables.get(id)!.startNewHand(); },
    authSessions: new Map(), playerSessions: new Map(), reservedSeats: new Map(), absentSeatMasterIds: new Map(),
    notifyPlayer: async () => {}, io: { to: () => ({ emit() {} }), sockets: { sockets: new Map() } },
    console: { log() {}, warn() {}, error() {} },
  };
  const code = [fnSrc('function drawSeatOrder('), fnSrc('function startRegisteredTournamentTables('), fnSrc('function startTournamentGame(')].join('\n');
  const { exports: m, stubbed } = load(code, scope, '{ startTournamentGame, startRegisteredTournamentTables, drawSeatOrder }');
  return { tm, tables, m, stubbed, tournamentTables };
}
const regId = (tm: TournamentManager, name: string) => {
  for (const [id, t] of (tm as any).tournaments as Map<string, any>) if (t.config.name === name && t.status === 'registering') return id;
  throw new Error(name);
};

afterEach(() => { jest.useRealTimers(); });

describe('F6 — random seats and a random first button (non-qualifier tournaments)', () => {
  it('a 9-player Sit & Go: seat k holds players[order[k]] (the drawn order), the first button is the drawn seat; players keep registration order', () => {
    jest.useFakeTimers();
    const VALUES = [3, 7, 1, 5, 0, 2, 6, 4, 8, 5];
    const r = seq(VALUES);
    const w = world(r.fn);
    const tid = regId(w.tm, 'Sit & Go');
    for (let i = 0; i < 9; i++) expect(w.tm.registerPlayer(tid, `p${i}`, `P${i}`, `s${i}`, 100 + i).success).toBe(true);
    w.m.startTournamentGame(tid);
    const t = w.tables.get('T1')!;
    const players = w.tm.getTournament(tid)!.players;
    const { order, used } = refDraw(9, VALUES);
    expect(order).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (let k = 0; k < 9; k++) expect([k, t.seats[k].playerId]).toEqual([k, players[order[k]].playerId]);   // e038f7b: players[k]
    expect(players.map((p) => p.playerId)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
    const buttonDraw = VALUES[used % VALUES.length] % 9;
    expect(t.dealerButtonSeat).toBe(buttonDraw);                                                             // e038f7b: always 0
    expect(t.handNumber).toBe(1);
    expect([...w.stubbed].filter((x) => /drawSeatOrder|randomInt|presetFirstButton/.test(x))).toEqual([]);
  });

  it('more than one table (12 entrants): the round-robin follows the drawn order; each table gets a drawn button among its seats', () => {
    jest.useFakeTimers();
    const VALUES = [5, 2, 9, 1, 7, 3, 11, 0, 4, 8, 6, 10, 2, 1];
    const r = seq(VALUES);
    const w = world(r.fn);
    const tid = w.tm.createTournament({ name: 'Custom', buyIn: 0, prizePool: 0, maxPlayers: 18, startInterval: 0, minPlayers: 12, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 300 }] } as any);
    for (let i = 0; i < 12; i++) expect(w.tm.registerPlayer(tid, `p${i}`, `P${i}`, `s${i}`, 100 + i).success).toBe(true);
    w.m.startTournamentGame(tid);
    const players = w.tm.getTournament(tid)!.players;
    const { order } = refDraw(12, VALUES);
    const seated: string[] = [];
    for (let k = 0; k < 12; k++) {
      const t = w.tables.get(`T${(k % 2) + 1}`)!;
      expect(t.seats[Math.floor(k / 2)].playerId).toBe(players[order[k]].playerId);
      seated.push(t.seats[Math.floor(k / 2)].playerId);
    }
    expect(new Set(seated).size).toBe(12);
    for (const id of ['T1', 'T2']) {
      const t = w.tables.get(id)!;
      expect(t.seats[t.dealerButtonSeat].state).toBe('occupied');
    }
  });

  it('PokerTable.presetFirstButton: the first hand takes it; the second hand rotates normally; a preset on an empty seat is ignored', () => {
    const mk = () => {
      const t = new PokerTable({ tableId: 'X', tableName: 'X', smallBlind: 10, bigBlind: 20, minBuyIn: 1, maxBuyIn: 100000, maxPlayers: 9 } as any);
      for (const s of [0, 1, 2, 4, 5, 7]) t.sitDown(s, `P${s}`, 1000, `p${s}`, false);
      return t;
    };
    const t = mk();
    (t as any).presetFirstButton(4);
    expect(t.startNewHand()).toBe(true);
    expect(t.dealerButtonSeat).toBe(4);
    while (t.isHandInProgress()) t.playerFold(t.activeSeatIndex);
    expect(t.startNewHand()).toBe(true);
    expect(t.dealerButtonSeat).toBe(5);
    const e = mk();
    (e as any).presetFirstButton(3);   // empty
    expect(e.startNewHand()).toBe(true);
    expect(e.dealerButtonSeat).toBe(0);
  });

  it('qualifiers are untouched: startQualifierTournament keeps its own draw and never presets a button', () => {
    const q = fnSrc('function startQualifierTournament(');
    expect(q).toContain('const drawOrder = players.map((_, i) => i);');
    expect(q).not.toContain('presetFirstButton');
    expect(q).not.toContain('drawSeatOrder(');
  });
});
