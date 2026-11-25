/**
 * Owner 2026-11-25: "Lets make it to where bots auto fill room to 7 players".
 *
 * CASH_TABLE_TARGET_OCCUPIED is 7 (was 5): bots top a cash table someone sits
 * at up to 7 SEATED players (people count), always leaving one takeable seat
 * open, and trim back to 7 as more people sit. A table capped lower fills to
 * its cap - 1. The env var of the same name overrides it (2..8). A table
 * nobody sits at keeps the heartbeat's floor of 3 (LIVE_ROOM_MIN_OCCUPIED).
 *
 * The REAL src/index.ts constant and fillWithAI / trimExcessAI /
 * backfillAIToMin (sliced + transpiled) with the REAL PokerTable.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { slice, fnSrc, load } from './helpers/indexSource';

const TARGET_LINE = slice('const CASH_TABLE_TARGET_OCCUPIED: number =', ';\n');
const FLOOR_LINE = slice('const LIVE_ROOM_MIN_OCCUPIED = ', ';\n');
const FILL = [
  fnSrc('function aiSeatsMutableNow('),
  fnSrc('function fillWithAI('),
  fnSrc('function trimExcessAI('),
  fnSrc('function backfillAIToMin('),
].join('\n');

function targetFor(env: Record<string, string | undefined>): number {
  return load(TARGET_LINE, { MAX_SEATS: 9, process: { env } }, 'CASH_TABLE_TARGET_OCCUPIED').exports;
}

function world(maxSeats?: number) {
  const t = new PokerTable({ tableId: 'cash1', tableName: 'Cash', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 } as any);
  if (maxSeats) t.maxOccupiableSeats = maxSeats;
  let n = 0;
  const scope: Record<string, unknown> = {
    MAX_SEATS: 9, GamePhase, CASH_TABLE_TARGET_OCCUPIED: targetFor({}),
    aiProfiles: new Map(),
    generateRandomProfile: () => ({ botName: `Bot${++n}` }),
    uuidv4: () => `u${n}`,
    noteBotSeated() {}, noteBotStackRemoved() {},
    log: { debug() {} },
  };
  const { exports: f, stubbed } = load(FILL, scope, '{ fillWithAI, trimExcessAI, backfillAIToMin }');
  const seated = () => t.seats.filter((s) => s.state === 'occupied');
  const bots = () => seated().filter((s) => s.isAI).length;
  const humans = () => seated().filter((s) => !s.isAI).length;
  const sitHuman = (k: number) => {
    const i = t.seats.findIndex((s, j) => s.state === 'empty' && j < t.maxOccupiableSeats);
    expect(t.sitDown(i, `Player${k}`, 1000, `user-${k}`, false)).toBe(true);
  };
  return { t, f, stubbed, seated, bots, humans, sitHuman };
}

describe('bots fill a cash table to 7 players (owner 2026-11-25)', () => {
  test('the target is 7 by default; the env var overrides it only with a whole number 2..8', () => {
    expect(targetFor({})).toBe(7);
    expect(targetFor({ CASH_TABLE_TARGET_OCCUPIED: '' })).toBe(7);
    expect(targetFor({ CASH_TABLE_TARGET_OCCUPIED: '5' })).toBe(5);
    expect(targetFor({ CASH_TABLE_TARGET_OCCUPIED: '2' })).toBe(2);
    expect(targetFor({ CASH_TABLE_TARGET_OCCUPIED: '8' })).toBe(8);
    expect(targetFor({ CASH_TABLE_TARGET_OCCUPIED: '9' })).toBe(7);
    expect(targetFor({ CASH_TABLE_TARGET_OCCUPIED: '1' })).toBe(7);
    expect(targetFor({ CASH_TABLE_TARGET_OCCUPIED: '6.5' })).toBe(7);
    expect(targetFor({ CASH_TABLE_TARGET_OCCUPIED: 'seven' })).toBe(7);
  });

  test('the empty-table floor is unchanged (3)', () => {
    expect(load(FLOOR_LINE, {}, 'LIVE_ROOM_MIN_OCCUPIED').exports).toBe(3);
  });

  test('one player sits at a 9-max: bots fill to 7 seated, 2 seats stay open', () => {
    const w = world();
    w.sitHuman(1);
    w.f.fillWithAI(w.t, 'cash1');
    expect(w.seated().length).toBe(7);
    expect(w.bots()).toBe(6);
    expect(w.humans()).toBe(1);
    expect(w.t.seats.filter((s) => s.state === 'empty').length).toBe(2);
    expect([...w.stubbed]).toEqual([]);
    // a second fill is a no-op
    w.f.fillWithAI(w.t, 'cash1');
    expect(w.seated().length).toBe(7);
  });

  test('more players sit: the open seats are theirs and bots are trimmed back to 7 between hands', () => {
    const w = world();
    w.sitHuman(1);
    w.f.fillWithAI(w.t, 'cash1');
    w.sitHuman(2);
    w.sitHuman(3);
    expect(w.seated().length).toBe(9);
    w.f.trimExcessAI(w.t, 'cash1');
    expect(w.seated().length).toBe(7);
    expect(w.humans()).toBe(3);
    expect(w.bots()).toBe(4);
    w.f.fillWithAI(w.t, 'cash1');
    expect(w.seated().length).toBe(7);
  });

  test('eight players: no bots are added and none of the players is ever removed', () => {
    const w = world();
    for (let k = 1; k <= 8; k++) w.sitHuman(k);
    w.f.fillWithAI(w.t, 'cash1');
    w.f.trimExcessAI(w.t, 'cash1');
    expect(w.bots()).toBe(0);
    expect(w.humans()).toBe(8);
  });

  test('a table capped at 6 seats (home game, 5-card draw) fills to 5, one seat inside the cap left open', () => {
    const w = world(6);
    w.sitHuman(1);
    w.f.fillWithAI(w.t, 'cash1');
    expect(w.seated().length).toBe(5);
    expect(w.t.seats.slice(0, 6).filter((s) => s.state === 'empty').length).toBe(1);
  });

  test('bots are never added during a hand (the fill waits for the hand boundary)', () => {
    const w = world();
    w.sitHuman(1);
    w.sitHuman(2);
    expect(w.t.startNewHand()).toBe(true);
    w.f.fillWithAI(w.t, 'cash1');
    expect(w.bots()).toBe(0);
  });

  test('a table nobody sits at is backfilled only to the floor of 3', () => {
    const w = world();
    w.f.backfillAIToMin(w.t, 'cash1', 3);
    expect(w.seated().length).toBe(3);
    expect(w.bots()).toBe(3);
  });
});
