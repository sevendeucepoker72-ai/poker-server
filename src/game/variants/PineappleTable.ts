import { Card, Rank } from '../Card';
import {
  PokerTable,
  TableConfig,
  GamePhase,
} from '../PokerTable';
import { TexasHoldemVariant } from './TexasHoldemVariant';
import { PokerVariant } from './PokerVariant';

/**
 * PineappleTable — Pineapple and Crazy Pineapple variants of Hold'em.
 *
 * Pineapple:        3 hole cards dealt; players must discard 1 BEFORE the flop.
 * Crazy Pineapple:  3 hole cards dealt; players must discard 1 AFTER the flop.
 *
 * Standard Hold'em board, betting structure, and showdown otherwise.
 *
 * Discard policy: MANUAL with server-side fallback. When the discard deadline
 * arrives, each seat's chosen card (via `selectPineappleDiscard`) is dropped.
 * If no choice was made in time, the weakest card is auto-discarded so the
 * hand can proceed (Crazy Pineapple, with the flop out: the card whose loss
 * leaves the best hand — F16).
 */
export class PineappleTable extends PokerTable {
  public variant: PokerVariant;
  public isCrazyPineapple: boolean;
  /** Pending player-chosen discard index per seat. Cleared after each discard phase and at every deal (F17). */
  private pendingDiscardIndex: Map<number, number> = new Map();
  /**
   * 2026-10-21 (gameplay F18) — the card each seat discarded THIS hand. The
   * shared action log (and so every player's hand-history copy) only says
   * "discarded a card"; the card itself is the owner's alone (index.ts adds
   * it to his own copy as `viewerDiscard`). Cleared at every deal.
   */
  private discardsThisHand: Map<number, Card> = new Map();

  /**
   * 2026-10-21 (gameplay F16) — the Crazy Pineapple DISCARD WINDOW of an all-in
   * runout. The discard comes after the flop, but a hand whose betting closed
   * before the flop (all-in and called) used to deal flop, turn and river in
   * one tick: nobody ever saw the flop with the discard picker open, and the
   * server threw away each player's lowest card even when it made a set.
   * index.ts installs `discardHoldDecider`; when such a runout reaches the flop
   * it is asked ONCE per hand whether to HOLD there (phase Flop, no actor,
   * activeSeatIndex -1) so the players still holding 3 cards can pick, until
   * index.ts calls releaseDiscardHold() (every pick in, or the window's
   * timer). A second runOutBoard() while held (the wedge watchdog's advanceTurn
   * fallback) releases it too. No decider (engine tests) = no hold.
   */
  public discardHoldDecider: ((table: PineappleTable) => boolean) | null = null;
  private discardHeld = false;
  private discardHoldAskedForHand = -1;

  constructor(config: TableConfig, isCrazyPineapple: boolean = false) {
    super(config);
    this.isCrazyPineapple = isCrazyPineapple;
    // Reuses the Hold'em variant for phase progression / community card dealing
    this.variant = new TexasHoldemVariant();

    this.variantId = isCrazyPineapple ? 'crazy-pineapple' : 'pineapple';
    this.variantName = isCrazyPineapple ? 'Crazy Pineapple' : 'Pineapple';
    this.holeCardCount = 3;
    this.bettingStructure = 'no-limit';
  }

  /**
   * Register a player's chosen discard index (0, 1, or 2 — index into their
   * holeCards array at the moment of choice). Call from the socket handler.
   * Returns true if recorded, false if invalid.
   */
  public selectPineappleDiscard(seatIndex: number, cardIndex: number): boolean {
    const seat = this.seats[seatIndex];
    if (!seat || seat.state !== 'occupied' || seat.folded || seat.eliminated) return false;
    // F17 (2026-10-21) — only during a live hand: a hand that ended before its
    // discard leaves the seat holding 3 cards, and a pick made then used to be
    // applied to the NEXT hand's cards.
    if (!this.isHandInProgress() || this.currentPhase === GamePhase.Showdown) return false;
    if (seat.holeCards.length <= 2) return false; // already discarded
    if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= seat.holeCards.length) return false;
    this.pendingDiscardIndex.set(seatIndex, cardIndex);
    return true;
  }

  /** F16 — has this seat picked its discard (for the discard window's early release)? */
  public hasDiscardChoice(seatIndex: number): boolean {
    return this.pendingDiscardIndex.has(seatIndex);
  }

  /** F18 — the card this seat discarded this hand (its owner's own view), else null. */
  public discardOf(seatIndex: number): Card | null {
    return this.discardsThisHand.get(seatIndex) ?? null;
  }

  /** F16 — in-hand seats still holding 3 cards (each has a discard to make). */
  public seatsAwaitingDiscard(): number[] {
    return this.seats
      .filter(s => s.state === 'occupied' && !s.folded && !s.eliminated && s.holeCards.length === 3)
      .map(s => s.seatIndex);
  }

  /** F16 — is the runout held for the Crazy Pineapple discard right now? */
  public isDiscardHeld(): boolean {
    return this.discardHeld && this.isHandInProgress();
  }

  /**
   * The runout is held — the insurance window (never on this table) or the
   * F16 discard window. index.ts's teardown (a covering caller keeps his hand
   * while the runout is held) and canRaise read this.
   */
  isRunoutHeld(): boolean {
    return super.isRunoutHeld() || this.isDiscardHeld();
  }

  /** F16 — end the discard window: discard, deal the turn and river, settle. False when nothing was held. */
  public releaseDiscardHold(): boolean {
    if (!this.isDiscardHeld()) return false;
    this.runOutBoard();
    return true;
  }

  /** Override: deal 3 hole cards instead of 2. */
  protected getHoleCardCount(): number {
    return 3;
  }

  /**
   * F17 / F18 (2026-10-21) — a new deal starts with no discard picks, no
   * discards and no discard window. A pick from a hand that ended before its
   * discard (a pre-flop walk, a Crazy Pineapple flop fold-out) used to survive
   * and was applied to this player's next hand — or to the next player in the
   * seat — logged as his own choice.
   */
  protected dealHoleCardsImpl(): void {
    this.pendingDiscardIndex.clear();
    this.discardsThisHand.clear();
    this.discardHeld = false;
    super.dealHoleCardsImpl();
  }

  /**
   * F16 — the all-in runout. Crazy Pineapple from before the flop: deal the
   * flop and HOLD there for the discard when the decider says so (see
   * discardHoldDecider); released (or asked again while held) it runs out the
   * rest — the discard fires before the turn, picks first, else the
   * board-aware fallback.
   */
  protected runOutBoard(): void {
    if (this.discardHeld) {
      this.discardHeld = false;
      super.runOutBoard();
      return;
    }
    if (
      this.isCrazyPineapple &&
      this.discardHoldDecider &&
      this.discardHoldAskedForHand !== this.handNumber &&
      this.communityCards.length === 0 &&
      !super.isRunoutHeld() &&
      this.seatsAwaitingDiscard().length > 0
    ) {
      this.discardHoldAskedForHand = this.handNumber;
      let hold = false;
      try {
        hold = this.discardHoldDecider(this) === true;
      } catch (e: any) {
        console.error('[PineappleTable] discardHoldDecider threw (ignored, board runs out):', e?.message || e);
      }
      if (hold) {
        this.currentPhase = GamePhase.Flop;
        this.dealCommunityCards(3);   // no discard at an empty board (Crazy discards before the turn)
        this.emit('phaseChanged', { phase: this.currentPhase });
        this.discardHeld = true;
        // The betting is over: nobody acts or owes while held (as the
        // insurance hold). The bets are already in the pot.
        this.activeSeatIndex = -1;
        this.currentBetToMatch = 0;
        for (const s of this.seats) if (s.state === 'occupied') s.currentBet = 0;
        this.emit('turnChanged', { seatIndex: -1 });
        this.emit('pineappleDiscardHeld', { handNumber: this.handNumber });
        return;
      }
    }
    super.runOutBoard();
  }

  /**
   * Override the LOW-LEVEL community dealer (not dealCommunityCardsForPhase) so
   * the forced discard fires on BOTH the normal street path AND the all-in
   * `runOutBoard()` — runOutBoard deals via dealCommunityCards() directly and
   * bypasses dealCommunityCardsForPhase, which previously let an all-in player
   * reach showdown still holding all 3 hole cards (best-5-of-8 — unfair).
   * 2026-06-19 fix. Keyed off board size so it triggers exactly once at the
   * correct boundary: before the flop (Pineapple) / before the turn (Crazy).
   * autoDiscardOne() is a no-op for seats already at 2 cards, so it's safe even
   * if both paths were to reach it.
   */
  protected dealCommunityCards(count: number): void {
    if (!this.isCrazyPineapple && this.communityCards.length === 0) {
      this.autoDiscardOne();   // Pineapple: discard before the flop
    } else if (this.isCrazyPineapple && this.communityCards.length === 3) {
      this.autoDiscardOne();   // Crazy Pineapple: discard before the turn
    }
    super.dealCommunityCards(count);
  }

  /**
   * Drop one hole card from each non-folded, non-eliminated occupied seat.
   * Uses the player's pending choice if they made one; otherwise falls back
   * to the server's pick (fallbackDiscardIndex) so the hand never stalls.
   */
  private autoDiscardOne(): void {
    for (const seat of this.seats) {
      if (seat.state !== 'occupied') continue;
      if (seat.folded || seat.eliminated) continue;
      if (seat.holeCards.length <= 2) continue;

      let chosenIdx = this.pendingDiscardIndex.get(seat.seatIndex);
      let auto = false;
      if (chosenIdx == null || chosenIdx < 0 || chosenIdx >= seat.holeCards.length) {
        auto = true;
        chosenIdx = this.fallbackDiscardIndex(seat.holeCards);
      }
      const [removed] = seat.holeCards.splice(chosenIdx, 1);
      this.discardsThisHand.set(seat.seatIndex, removed);
      // F18 (2026-10-21) — the shared log never names the card: it reaches
      // every player's hand history (a discard is a face-down card, and an
      // auto-discard of "the lowest card" also bounded the two cards kept).
      // The owner gets his own discard through discardOf().
      this.actionLog.push({
        seatIndex: seat.seatIndex,
        playerName: seat.playerName,
        action: auto ? 'auto-discarded a card' : 'discarded a card',
      });
      this.emit('pineappleDiscarded', { seatIndex: seat.seatIndex, card: removed, auto });
    }
    this.pendingDiscardIndex.clear();
  }

  /**
   * The server's discard when the player chose none. Before any board
   * (Pineapple): the weakest card by rank, ties → lowest suit. F16
   * (2026-10-21) — Crazy Pineapple discards with the flop out: drop the card
   * whose loss leaves the BEST hand with the board (the rank rule alone broke
   * sets, two pair and flushes); ties go to the rank rule.
   */
  private fallbackDiscardIndex(cards: Card[]): number {
    let weakest = 0;
    for (let i = 1; i < cards.length; i++) {
      const c = cards[i];
      const w = cards[weakest];
      if (c.rank < w.rank || (c.rank === w.rank && c.suit < w.suit)) weakest = i;
    }
    if (!this.isCrazyPineapple || this.communityCards.length < 3) return weakest;
    const without = (i: number): Card[] => cards.filter((_c, j) => j !== i);
    const cmp = this.getHandComparator();
    let best = weakest;
    let bestHand = this.evaluatePlayerHand(without(weakest), this.communityCards);
    for (let i = 0; i < cards.length; i++) {
      if (i === weakest) continue;
      const hand = this.evaluatePlayerHand(without(i), this.communityCards);
      if (cmp(hand, bestHand) > 0) { best = i; bestHand = hand; }
    }
    return best;
  }

  private cardLabel(c: Card): string {
    const rankNames: Record<number, string> = {
      2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
      11: 'J', 12: 'Q', 13: 'K', 14: 'A',
    };
    const suitNames: Record<number, string> = { 0: '♥', 1: '♦', 2: '♣', 3: '♠' };
    return `${rankNames[c.rank] || c.rank}${suitNames[c.suit] || ''}`;
  }
}
