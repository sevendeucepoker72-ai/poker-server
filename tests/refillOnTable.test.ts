/**
 * R1 (2026-10-11) — ECON-19: the broke refill counts the chips a player holds
 * on tables.
 *
 * claimRefill (+5,000 when the WALLET is under 5,000) ignored stacks at the
 * table: buy in with everything, claim the refill, top up / cash out, repeat —
 * free chips on a loop. Now "broke" means wallet + every non-tournament stack
 * of the account (any of its sockets, extra tables, a reserved seat, a seat
 * waiting for removal; plus its chips in a live pot) is under the threshold.
 * Real chipsOnTablesOfUser + claimRefill (sliced from src/index.ts) on real
 * PokerTables and an atomic in-memory wallet.
 */
import { PokerTable } from '../src/game/PokerTable';
import { fnSrc, handlerSrc, load, flush } from './helpers/indexSource';

const HANDLER = handlerSrc('claimRefill', '\n  });\n');

function world(walletChips: number, handler = HANDLER) {
  const wallet = new Map<number, number>([[7, walletChips]]);
  const tables = new Map<string, PokerTable>();
  const mk = (id: string) => {
    const t = new PokerTable({ tableId: id, tableName: id, smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 200 } as any);
    tables.set(id, t);
    return t;
  };
  const tournament = new Set<string>();
  const authSessions = new Map<string, any>([['S1', { userId: 7, username: 'u7' }]]);
  const playerSessions = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>();
  const reservedSeats = new Map<number, any>();
  const pendingSeatRemovalAfterHand = new Map<string, Map<number, any>>();
  const scope: Record<string, unknown> = {
    tableManager: { getTable: (id: string) => tables.get(id) },
    isTournamentTable: (id: string) => tournament.has(id),
    authSessions, playerSessions, multiTableSessions, reservedSeats, pendingSeatRemovalAfterHand,
    ensureHydrated: async () => ({ userId: 7, playerId: 'player-7' }),
    // The real SQL: UPDATE users SET chips = chips + $1 WHERE id = $2 AND chips < $3 RETURNING chips
    refillBrokeUser: async (uid: number, threshold: number, amount: number) => {
      const c = wallet.get(uid)!;
      if (!(c < threshold)) return null;
      wallet.set(uid, c + amount);
      return c + amount;
    },
    getUserChips: async (uid: number) => wallet.get(uid)!,
    progressionManager: { getProgress: () => null }, auditLog() {}, sendProgressToPlayer() {},
  };
  const code = fnSrc('function isTournamentReservation(') + fnSrc('function chipsOnTablesOfUser(') + `\nfunction wire(socket) {\n${handler}\n}`;
  const { exports: m } = load(code, scope, '{ wire, chipsOnTablesOfUser }');
  const emitted: any[] = [];
  const handlers: Record<string, () => any> = {};
  m.wire({ id: 'S1', emit: (_ev: string, d: any) => emitted.push(d), on: (ev: string, fn: any) => { handlers[ev] = fn; } });
  const claim = async () => { await handlers.claimRefill(); await flush(); return emitted[emitted.length - 1]; };
  /** Seat the account at a fresh table with `stack` chips (and a bot). */
  const seat = (id: string, stack: number) => {
    const t = mk(id);
    expect(t.sitDown(0, 'u7', stack, 'p7', false, true)).toBe(true);
    expect(t.sitDown(1, 'Bot', 1000, 'ai', true)).toBe(true);
    return t;
  };
  return { m, wallet, seat, tournament, playerSessions, multiTableSessions, reservedSeats, pendingSeatRemovalAfterHand, authSessions, claim };
}

describe('claimRefill counts chips on tables (ECON-19)', () => {
  it('control: broke with nothing on a table -> +5,000', async () => {
    const w = world(0);
    expect(await w.claim()).toMatchObject({ success: true, added: 5000, chips: 5000 });
  });

  it('THE CYCLE: wallet 0 but 6,000 on a cash table -> refused chips_on_table, nothing added', async () => {
    const w = world(0);
    w.seat('CASH', 6000);
    w.playerSessions.set('S1', { tableId: 'CASH', seatIndex: 0 });
    expect(await w.claim()).toMatchObject({ success: false, error: 'chips_on_table', onTable: 6000, chips: 0 });
    expect(w.wallet.get(7)).toBe(0);
  });

  it('CONTROL — the pre-R1 handler refills while 6,000 sit on the table', async () => {
    const pre = HANDLER
      .replace('const onTable = chipsOnTablesOfUser(ctx.userId);', 'const onTable = 0;');
    const w = world(0, pre);
    w.seat('CASH', 6000);
    w.playerSessions.set('S1', { tableId: 'CASH', seatIndex: 0 });
    expect(await w.claim()).toMatchObject({ success: true, added: 5000 });
  });

  it('really broke: 100 in the wallet + 3,000 on a table (3,100 < 5,000) -> refilled', async () => {
    const w = world(100);
    w.seat('CASH', 3000);
    w.playerSessions.set('S1', { tableId: 'CASH', seatIndex: 0 });
    expect(await w.claim()).toMatchObject({ success: true, chips: 5100 });
  });

  it('3,000 + 3,000 on a table (6,000) -> refused chips_on_table (the atomic predicate uses threshold - table chips)', async () => {
    const w = world(3000);
    w.seat('CASH', 3000);
    w.playerSessions.set('S1', { tableId: 'CASH', seatIndex: 0 });
    expect(await w.claim()).toMatchObject({ success: false, error: 'chips_on_table', onTable: 3000 });
    expect(w.wallet.get(7)).toBe(3000);
  });

  it('counts every seat of the ACCOUNT: another socket, an extra table, a reserved seat, a seat awaiting removal — once each', async () => {
    const w = world(0);
    w.seat('A', 1000); w.seat('B', 1500); w.seat('C', 2000); w.seat('D', 700);
    w.authSessions.set('S2', { userId: 7, username: 'u7' });                      // his phone, too
    w.playerSessions.set('S2', { tableId: 'A', seatIndex: 0 });
    w.playerSessions.set('S1', { tableId: 'A', seatIndex: 0 });                    // the same seat twice: counted once
    w.multiTableSessions.set('S2', [{ tableId: 'B', seatIndex: 0 }]);
    w.reservedSeats.set(7, { tableId: 'C', seatIndex: 0, expiresAt: Date.now() + 60_000 });
    w.pendingSeatRemovalAfterHand.set('D', new Map([[0, { userId: 7, username: 'u7' }]]));
    expect(w.m.chipsOnTablesOfUser(7)).toBe(1000 + 1500 + 2000 + 700);
    expect(w.m.chipsOnTablesOfUser(8)).toBe(0);
  });

  it('tournament stacks are not wallet chips: 50,000 in a tournament never blocks the refill', async () => {
    const w = world(0);
    w.seat('TOUR', 50_000);
    w.tournament.add('TOUR');
    w.playerSessions.set('S1', { tableId: 'TOUR', seatIndex: 0 });
    expect(await w.claim()).toMatchObject({ success: true, added: 5000 });
  });
});
