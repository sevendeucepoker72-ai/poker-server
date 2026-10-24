/**
 * 2026-10-24 (owner 2026-10-23: "Fix all"; Sit & Go fix-all F18) — the HUD
 * showed the NEXT level's blinds (and sized '3x BB' to it) while a hand was
 * still played at the old level: a tournament blind level-up rewrites
 * table.config mid-hand (7 of the 16 hands of the 9-player event).
 *
 * Now the engine captures the WHOLE level a hand is dealt at (handSmallBlind,
 * handBigBlind — Z3 already —, handAnte) and every full state carries it,
 * ALWAYS present (additive): `handSmallBlind`, `handBigBlind`, `handAnte` = the
 * level of the hand on the table (dealt, in play or just finished); with no
 * hand dealt yet they equal the table's current level. The existing
 * `smallBlind` / `bigBlind` / `ante` keys keep meaning the CURRENT level (what
 * the next hand is dealt at), so a client can show it as "Next".
 *
 * The REAL getGameStateForPlayer (sliced from src/index.ts) on a REAL PokerTable.
 */
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { FiveCardDrawTable } from '../src/game/variants/FiveCardDrawTable';
import { fnSrc, load } from './helpers/indexSource';

function mkTable(sb = 10, bb = 20, ante = 0): PokerTable {
  const t = new PokerTable({ tableId: 'T1', tableName: 'T1', smallBlind: sb, bigBlind: bb, ante, minBuyIn: 100, maxBuyIn: 100_000, maxPlayers: 9 } as any);
  for (let i = 0; i < 3; i++) t.sitDown(i, `P${i}`, 1500, `p${i}`, false);
  return t;
}

/** What blindLevelUp does to a live tournament table (index.ts startTournamentGame listener). */
function levelUp(t: PokerTable, sb: number, bb: number, ante: number): void {
  t.config.smallBlind = sb;
  t.config.bigBlind = bb;
  t.config.ante = ante;
}

function stateFn(tournamentId: string | null) {
  return load(fnSrc('function getGameStateForPlayer('), {
    playerSessions: new Map(), multiTableSessions: new Map(), sitOutTracker: new Map(),
    progressionManager: { getProgress: () => null, equippedTheme: () => null, seatCosmetics: () => null, userRecord: () => null },
    seatAccountsOfTable: () => new Map(),
    getVariantInfo: () => ({ variant: 'texas-holdem', variantName: "Texas Hold'em", holeCardCount: 2, hasDrawPhase: false, isStudGame: false }),
    turnStartedAtMap: new Map(), TURN_TIMEOUT_MS: 30000, bombPotActive: new Map(), dealersChoiceState: new Map(),
    MAX_SEATS: 9, GamePhase, SevenStudTable, FiveCardDrawTable, cardToString: (c: any) => `${c.rank}${c.suit}`,
    tournamentIdOfTable: () => tournamentId, qualifierIdOfTable: () => null, tournamentClockStateFor: () => null,
    tableKindOf: () => (tournamentId ? 'tournament' : 'cash'), rebuyAllowedAt: () => false, insuranceQuoteForSeat: () => null,
    straddleAllowedAt: () => false, bombPotAllowedAt: () => false,
  }, '{ getGameStateForPlayer }').exports.getGameStateForPlayer as (t: PokerTable, seat: number, training?: boolean) => any;
}

const hl = (x: any) => ({ sb: x.handSmallBlind, bb: x.handBigBlind, ante: x.handAnte });
const level = (s: any) => ({ handSmallBlind: s.handSmallBlind, handBigBlind: s.handBigBlind, handAnte: s.handAnte, smallBlind: s.smallBlind, bigBlind: s.bigBlind, ante: s.ante });

describe('F18 — the engine captures the level a hand is dealt at', () => {
  it('handSmallBlind / handBigBlind / handAnte are the deal-time level; a mid-hand level-up changes config only', () => {
    const t = mkTable(10, 20, 0);
    expect(t.startNewHand()).toBe(true);
    levelUp(t, 20, 40, 5);
    expect(hl(t)).toEqual({ sb: 10, bb: 20, ante: 0 });
    // The next hand is dealt at the new level.
    while (t.isHandInProgress()) t.playerFold(t.activeSeatIndex);
    expect(t.startNewHand()).toBe(true);
    expect(hl(t)).toEqual({ sb: 20, bb: 40, ante: 5 });
  });

  it('a snapshot keeps them (optional fields: an older snapshot restores 0 = use the table level)', () => {
    const t = mkTable(25, 50, 5);
    expect(t.startNewHand()).toBe(true);
    const snap = t.serializeSnapshot();
    expect((snap as any).handSmallBlind).toBe(25);
    expect((snap as any).handAnte).toBe(5);
    const r = mkTable(25, 50, 5);
    r.rehydrateFromSnapshot(snap);
    expect(hl(r)).toEqual({ sb: 25, bb: 50, ante: 5 });
    const old = { ...snap } as any;
    delete old.handSmallBlind; delete old.handAnte;
    const r2 = mkTable(25, 50, 5);
    r2.rehydrateFromSnapshot(old);
    expect({ sb: hl(r2).sb, ante: hl(r2).ante }).toEqual({ sb: 0, ante: 0 });
  });
});

describe('F18 — every full state carries the hand level (always present)', () => {
  it('tournament table: before the first deal = the table level; mid-hand after a level-up = the OLD level while bigBlind says the new one; the next deal = the new level', () => {
    const get = stateFn('TOURN-1');
    const t = mkTable(10, 20, 0);
    expect(level(get(t, 0))).toEqual({ handSmallBlind: 10, handBigBlind: 20, handAnte: 0, smallBlind: 10, bigBlind: 20, ante: undefined });
    expect(t.startNewHand()).toBe(true);
    levelUp(t, 20, 40, 5);
    // 9c37499: only bigBlind 40 / smallBlind 20 / ante 5 - the hand being played was 10/20.
    expect(level(get(t, 0))).toEqual({ handSmallBlind: 10, handBigBlind: 20, handAnte: 0, smallBlind: 20, bigBlind: 40, ante: 5 });
    // A spectator frame says the same.
    expect(level(get(t, -1))).toMatchObject({ handSmallBlind: 10, handBigBlind: 20, handAnte: 0 });
    // The hand just finished is still the hand on the table.
    while (t.isHandInProgress()) t.playerFold(t.activeSeatIndex);
    expect(t.currentPhase).toBe(GamePhase.HandComplete);
    expect(level(get(t, 0))).toMatchObject({ handSmallBlind: 10, handBigBlind: 20, handAnte: 0, bigBlind: 40 });
    expect(t.startNewHand()).toBe(true);
    expect(level(get(t, 0))).toEqual({ handSmallBlind: 20, handBigBlind: 40, handAnte: 5, smallBlind: 20, bigBlind: 40, ante: 5 });
  });

  it('cash table: the same keys, equal to the table blinds', () => {
    const get = stateFn(null);
    const t = mkTable(5, 10, 0);
    expect(t.startNewHand()).toBe(true);
    expect(level(get(t, 1))).toEqual({ handSmallBlind: 5, handBigBlind: 10, handAnte: 0, smallBlind: 5, bigBlind: 10, ante: undefined });
  });
});
