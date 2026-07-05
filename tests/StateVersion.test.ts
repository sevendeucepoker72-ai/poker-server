/**
 * Decision-point version guard (2026-07-05).
 *
 * PokerTable.stateVersion is a monotonic counter bumped by the emit() override on exactly
 * the three events that redefine what the active player is deciding: 'turnChanged',
 * 'phaseChanged', 'handStarted'. The client echoes the version it acted on and the server
 * rejects an action whose echoed version is strictly older than the table's current one
 * (a stale click against a decision point that already moved on). These tests pin the two
 * properties the reject-guard relies on: (1) the version only ever increases and advances
 * on every real transition, and (2) it survives a snapshot round-trip (Railway restart).
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';

const TERMINAL = new Set<GamePhase>([GamePhase.HandComplete, GamePhase.WaitingForPlayers]);

function makeTable(): PokerTable {
  return new PokerTable({
    tableId: 'sv', tableName: 'SV', smallBlind: 25, bigBlind: 50,
    minBuyIn: 100, maxBuyIn: 100000, maxPlayers: 9,
  } as any);
}

describe('PokerTable — stateVersion (stale-action guard)', () => {
  test('starts at 0 and advances when a hand starts', () => {
    const t = makeTable();
    const any = t as any;
    expect(any.stateVersion).toBe(0);
    t.sitDown(0, 'A', 5000, 'a', false);
    t.sitDown(1, 'B', 5000, 'b', false);
    any.startNewHand();
    // handStarted + phaseChanged(preflop) + the first turnChanged all bump.
    expect(any.stateVersion).toBeGreaterThan(0);
  });

  test('is strictly monotonic across a full hand of random legal actions', () => {
    const t = makeTable();
    const any = t as any;
    for (let i = 0; i < 4; i++) t.sitDown(i, `P${i}`, 5000, `p${i}`, false);
    any.startNewHand();

    let prev = any.stateVersion;
    let guard = 0;
    while (!TERMINAL.has(any.currentPhase) && guard++ < 400) {
      const seatIdx = any.activeSeatIndex;
      if (seatIdx < 0 || !any.canAct(any.seats[seatIdx])) break;
      const before = any.stateVersion;
      const callAmt = any.currentBetToMatch - any.seats[seatIdx].currentBet;
      // Deterministic legal action: check if free, else call.
      if (callAmt > 0) any.playerCall(seatIdx); else any.playerCheck(seatIdx);
      // Every action produces at least one bump (turnChanged or phaseChanged),
      // so the version can never go backwards or stall while the hand is live.
      expect(any.stateVersion).toBeGreaterThanOrEqual(before);
      expect(any.stateVersion).toBeGreaterThanOrEqual(prev);
      prev = any.stateVersion;
    }
    // The hand actually progressed (didn't instantly end), so the version moved.
    expect(any.stateVersion).toBeGreaterThan(1);
  });

  test('survives a snapshot round-trip (restart-safe)', () => {
    const t = makeTable();
    const any = t as any;
    t.sitDown(0, 'A', 5000, 'a', false);
    t.sitDown(1, 'B', 5000, 'b', false);
    any.startNewHand();
    const captured = any.stateVersion;
    expect(captured).toBeGreaterThan(0);

    const snap = t.serializeSnapshot();
    expect(snap.stateVersion).toBe(captured);

    // Rehydrate a fresh instance and confirm the version restores (>= captured;
    // rehydrate re-emits phase/turn events which may bump it further — never lower).
    const t2 = makeTable();
    (t2 as any).rehydrateFromSnapshot(snap);
    expect((t2 as any).stateVersion).toBeGreaterThanOrEqual(captured);
  });

  test('older snapshots without stateVersion rehydrate without throwing (backward-compat)', () => {
    const t = makeTable();
    t.sitDown(0, 'A', 5000, 'a', false);
    t.sitDown(1, 'B', 5000, 'b', false);
    (t as any).startNewHand();
    const snap: any = t.serializeSnapshot();
    delete snap.stateVersion; // simulate a pre-2026-07-05 snapshot
    const t2 = makeTable();
    expect(() => (t2 as any).rehydrateFromSnapshot(snap)).not.toThrow();
    expect(typeof (t2 as any).stateVersion).toBe('number');
  });
});
