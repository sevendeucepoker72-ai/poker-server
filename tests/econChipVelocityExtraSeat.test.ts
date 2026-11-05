/**
 * Bots review 2026-11-04 (economy-farming E8) — the anti-cheat chip-velocity
 * monitor now sees an EXTRA-table seat (multiTableSessions). At 0dc1b96
 * recordChipVelocity walked playerSessions only: a second table's winnings
 * counted toward the paid season chips-won (dealtInSeatAccount) but never
 * reached the alert.
 *
 * The REAL recordChipVelocity and its CHIP_VELOCITY_* constants, sliced from
 * src/index.ts, on a REAL PokerTable. Each "hand" sets the seat's hand-start
 * stack (table.startChips, as startNewHand does), deals it cards, and moves its
 * stack by the hand's result before the monitor reads it.
 *
 * Fails on 0dc1b96: the extra-table seat gives 0 alerts.
 */
import { PokerTable } from '../src/game/PokerTable';
import { slice, load } from './helpers/indexSource';

const T = 'T';
const USER = 7;
const CV_SRC = slice('const CHIP_VELOCITY_MIN_HANDS = ', '\n}\n');

function world(opts: { via: 'main' | 'extra'; tournament?: boolean }) {
  const table = new PokerTable({ tableId: T, tableName: 'T', smallBlind: 50, bigBlind: 100, ante: 0, minBuyIn: 1000 } as any);
  table.sitDown(0, 'Alice', 1000, 'p-alice', false);
  table.sitDown(1, 'Bot', 1000, 'ai-1', true);
  const session = { tableId: T, seatIndex: 0, playerName: 'Alice', playerId: 'p-alice' };
  const playerSessions = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>();
  if (opts.via === 'main') playerSessions.set('S1', session);
  else { playerSessions.set('S1', { tableId: 'other', seatIndex: 3 }); multiTableSessions.set('S1', [session]); }
  const audits: Array<[string, string, any]> = [];
  const scope: Record<string, unknown> = {
    playerSessions, multiTableSessions, authSessions: new Map([['S1', { userId: USER, username: 'alice.player' }]]),
    chipVelocity: new Map(), chipVelocityAlerts: new Map(), incrementChipVelocityAlert: () => 1, banUserDB() {},
    auditLog: (a: string, b: string, d: any) => audits.push([a, b, d]),
    isTournamentTable: () => !!opts.tournament,
    console: { log() {}, warn() {}, error() {} },
  };
  const { exports: m, stubbed } = load(CV_SRC, scope, '{ recordChipVelocity, chipVelocityStats }');
  /** One dealt hand the seat wins `won` chips in (its stack goes up by `won`). */
  const hand = (won: number) => {
    const seat = table.seats[0];
    table.startChips.set(0, seat.chipCount);
    seat.holeCards = [{ rank: 14, suit: 0 }, { rank: 13, suit: 0 }] as any;
    seat.chipCount += won;
    m.recordChipVelocity(T, table, [{ seatIndex: 0, isAI: false, chipsWon: won, playerId: 'p-alice' }]);
  };
  return { m, stubbed, hand, audits, scope };
}

describe('E8 — the chip-velocity monitor covers an extra-table seat', () => {
  it('a seat held ONLY through multiTableSessions that nets > 10x its first-hand stack over 5 hands alerts once (0dc1b96: 0)', () => {
    const w = world({ via: 'extra' });
    for (let h = 0; h < 5; h++) w.hand(2500);
    expect(w.m.chipVelocityStats.alerts).toBe(1);
    expect(w.audits).toHaveLength(1);
    expect(w.audits[0][1]).toBe('CHIP_VELOCITY_ALERT');
    expect(w.audits[0][2]).toMatchObject({ userId: USER, tableId: T, netWon: 12_500, stakeAtStart: 1000, hands: 5 });
    w.hand(2500);
    expect(w.m.chipVelocityStats.alerts).toBe(1);        // once per session
    expect([...w.stubbed]).toEqual([]);
  });

  it('CONTROL — a main-session seat behaves exactly as before (alerts at the 5th hand, once)', () => {
    const w = world({ via: 'main' });
    for (let h = 0; h < 4; h++) w.hand(2500);
    expect(w.m.chipVelocityStats.alerts).toBe(0);         // under CHIP_VELOCITY_MIN_HANDS
    w.hand(2500);
    expect(w.m.chipVelocityStats.alerts).toBe(1);
    expect(w.audits[0][2]).toMatchObject({ userId: USER, netWon: 12_500, hands: 5 });
  });

  it('CONTROL — a tournament table records nothing, main or extra seat', () => {
    for (const via of ['main', 'extra'] as const) {
      const w = world({ via, tournament: true });
      for (let h = 0; h < 6; h++) w.hand(2500);
      expect(w.m.chipVelocityStats.alerts).toBe(0);
      expect((w.scope.chipVelocity as Map<number, unknown>).size).toBe(0);
    }
  });

  it('a seat on ANOTHER table in the same extra-session list is not counted here', () => {
    const w = world({ via: 'extra' });
    (w.scope.multiTableSessions as Map<string, any[]>).set('S1', [{ tableId: 'elsewhere', seatIndex: 0 }]);
    for (let h = 0; h < 6; h++) w.hand(2500);
    expect(w.m.chipVelocityStats.alerts).toBe(0);
  });
});
