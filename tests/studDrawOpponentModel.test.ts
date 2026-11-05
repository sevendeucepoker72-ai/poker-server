/**
 * Bots review 2026-11-04 (stud-draw-lowball SD8 / B11) — the bots' opponent
 * model counts Seven Card Stud's first betting round.
 *
 * Before: ensureTableProgressListener's 'playerAction' feed counted VPIP / PFR
 * only on GamePhase.PreFlop. Stud's first betting round is ThirdStreet, so a
 * player who completed every Third Street read as vpip = pfr = 0 — a 'nit' —
 * and, the model being keyed by player id across tables, Hold'em bots read him
 * as a nit too.
 * Now: firstBettingRound = PreFlop or ThirdStreet. The bring-in posts as
 * 'blindPosted' (never here); a completion is a Raise (VPIP + PFR). The
 * player's HUD 3-bet context (progressionManager.recordPreflopRaiseContext)
 * stays PreFlop only.
 *
 * REAL src/index.ts text (ensureTableProgressListener, sliced + transpiled)
 * with the REAL recordOpponentObservation / opponentModelKey / categorizeOpponent
 * on a REAL SevenStudTable (and a PokerTable Hold'em control).
 */
import { PokerTable, GamePhase, PlayerAction } from '../src/game/PokerTable';
import { SevenStudTable } from '../src/game/variants/SevenStudTable';
import { recordOpponentObservation, opponentModelKey, getOpponentProfile, categorizeOpponent } from '../src/ai/AIPlayer';
import { fnSrc, load } from './helpers/indexSource';

const LISTENER = fnSrc('function ensureTableProgressListener(');
const quiet = { log() {}, warn() {}, error() {} };

/** Wire the REAL listener on `table`, then keep only its 'playerAction' feed (the others need the whole server). */
function wire(table: PokerTable, tableId: string) {
  const raiseContext: Array<{ playerId: string; facingRaise: boolean; isReraise: boolean; phase: string }> = [];
  const actions: Array<{ playerId: string; action: string; phase: string | undefined }> = [];
  const scope: Record<string, unknown> = {
    tableProgressListeners: new Set<string>(), GamePhase, PlayerAction, recordOpponentObservation, opponentModelKey,
    progressionManager: {
      recordAction: (playerId: string, action: string, o: any) => actions.push({ playerId, action, phase: o?.phase }),
      recordPreflopRaiseContext: (playerId: string, facingRaise: boolean, isReraise: boolean) =>
        raiseContext.push({ playerId, facingRaise, isReraise, phase: table.currentPhase }),
    },
    console: quiet,
  };
  const { exports: ensure, stubbed } = load(LISTENER, scope, 'ensureTableProgressListener');
  const before = new Map(table.eventNames().map((ev) => [ev, table.listeners(ev).length]));
  ensure(table, tableId);
  for (const ev of table.eventNames()) {
    if (ev === 'playerAction') continue;
    const added = table.listeners(ev).slice(before.get(ev) ?? 0);
    for (const fn of added) table.off(ev as string, fn as (...a: any[]) => void);
  }
  return { raiseContext, actions, stubbed };
}

describe('SD8 — Stud Third Street counts for the opponent model (VPIP / PFR)', () => {
  /** Deal until the human has COMPLETED `hands` Third Streets (a hand everyone folds to his bring-in never reaches him). */
  function studHands(label: string, hands: number) {
    const table = new SevenStudTable({ tableId: `S-${label}`, tableName: 'Stud', smallBlind: 25, bigBlind: 50, ante: 5, minBuyIn: 5000 } as any, false, false);
    for (let i = 0; i < 4; i++) expect(table.sitDown(i, `P${i}`, 5000, `${label}-p${i}`, i !== 1)).toBe(true);   // seat 1 is the human
    const w = wire(table, `S-${label}`);
    let completed = 0;
    for (let h = 0; h < hands * 3 && completed < hands; h++) {
      for (const s of table.seats) if (s.state === 'occupied') { s.chipCount = 5000; s.eliminated = false; }
      expect(table.startNewHand()).toBe(true);
      let g = 0;
      let raisedThisHand = false;
      while (table.isHandInProgress() && table.currentPhase === GamePhase.ThirdStreet && g++ < 20) {
        const a = table.activeSeatIndex;
        if (a === 1) {
          if (table.playerRaise(1, table.getMinRaise())) raisedThisHand = true;
          else if (!table.playerCall(1)) table.playerCheck(1);
        } else if (!table.playerFold(a)) table.playerCheck(a);
      }
      if (raisedThisHand) completed++;
      while (table.isHandInProgress() && g++ < 200) { const a = table.activeSeatIndex; if (a < 0) break; if (!table.playerCheck(a)) table.playerFold(a); }
    }
    return { table, w, key: `${label}-p1`, completed };
  }

  it('a human who completes every Third Street for 16 hands: vpipHands === pfrHands === handsSeen, categorized "maniac" (0dc1b96: 0 / 0, "nit")', () => {
    const r = studHands('stud16', 16);
    expect(r.completed).toBe(16);
    const p = getOpponentProfile(r.key)!;
    expect(p.handsSeen).toBe(16);
    expect(p.vpipHands).toBe(16);
    expect(p.pfrHands).toBe(16);
    expect(categorizeOpponent(r.key)).toBe('maniac');
    expect([...r.w.stubbed].filter((n) => /recordOpponentObservation|opponentModelKey|progressionManager|GamePhase/.test(n))).toEqual([]);
  });

  it('GUARD (passes at 0dc1b96 too) — the HUD 3-bet context is never recorded on Third Street', () => {
    const r = studHands('studHud', 12);
    expect(r.w.raiseContext.filter((c) => c.phase === GamePhase.ThirdStreet)).toEqual([]);
    expect(r.w.raiseContext).toEqual([]);
    // The human's own HUD actions are still recorded (unchanged): no PreFlop phase tag in Stud.
    expect(r.w.actions.filter((x) => x.playerId === r.key).length).toBeGreaterThan(0);
    expect(r.w.actions.every((x) => x.phase === undefined)).toBe(true);
  });

  it('GUARD (passes at 0dc1b96 too) — Hold\'em control: a preflop raiser counts VPIP + PFR once per hand and the HUD 3-bet context is recorded preflop as before', () => {
    const table = new PokerTable({ tableId: 'H1', tableName: 'Holdem', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 5000 } as any);
    for (let i = 0; i < 4; i++) expect(table.sitDown(i, `P${i}`, 5000, `hold-p${i}`, true)).toBe(true);
    const w = wire(table, 'H1');
    for (let h = 0; h < 12; h++) {
      for (const s of table.seats) if (s.state === 'occupied') { s.chipCount = 5000; s.eliminated = false; }
      expect(table.startNewHand()).toBe(true);
      let g = 0;
      let raises = 0;
      while (table.isHandInProgress() && table.currentPhase === GamePhase.PreFlop && g++ < 20) {
        const a = table.activeSeatIndex;
        if (raises < 2 && table.playerRaise(a, table.getMinRaise())) { raises++; continue; }
        if (!table.playerCall(a)) table.playerCheck(a);
      }
      while (table.isHandInProgress() && g++ < 200) { const a = table.activeSeatIndex; if (a < 0) break; if (!table.playerCheck(a)) table.playerFold(a); }
    }
    const seen = [0, 1, 2, 3].map((i) => getOpponentProfile(`hold-p${i}`)!);
    for (const p of seen) {
      expect(p.handsSeen).toBe(12);
      expect(p.vpipHands).toBeLessThanOrEqual(12);
      expect(p.pfrHands).toBeLessThanOrEqual(p.vpipHands);
    }
    expect(seen.reduce((a, p) => a + p.pfrHands, 0)).toBe(24);          // two raises a hand, each a PFR once
    expect(w.raiseContext.length).toBeGreaterThan(0);
    expect(w.raiseContext.every((c) => c.phase === GamePhase.PreFlop)).toBe(true);
    expect(w.raiseContext.filter((c) => c.isReraise).length).toBe(12);  // the second raise each hand is a 3-bet
  });
});
