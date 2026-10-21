import { Card } from '../Card';
import { evaluateHand, HandResult } from '../HandEvaluator';
import { evaluate27LowHand, compare27Hands } from '../HandEvaluatorExtensions';
import {
  PokerTable,
  MAX_SEATS,
  GamePhase,
  PlayerAction,
  Seat,
  TableConfig,
  PokerTableSnapshot,
} from '../PokerTable';
import { FiveCardDrawVariant } from './FiveCardDrawVariant';
import { PokerVariant, VariantPhase } from './PokerVariant';

/**
 * FiveCardDrawTable extends PokerTable for Five Card Draw and 2-7 Triple Draw.
 *
 * Key differences from Hold'em:
 * - 5 hole cards, no community cards
 * - Draw phases where players discard 0-5 cards and get replacements
 * - For Triple Draw: 3 draw rounds
 * - Draw tracking per player
 */
export class FiveCardDrawTable extends PokerTable {
  public variant: FiveCardDrawVariant;

  /** Track which players have completed their draw in the current draw phase */
  public drawsCompleted: Set<number> = new Set();

  /** Track the current draw phase (for triple draw) */
  public currentDrawPhase: VariantPhase | null = null;

  /** Track which draw round we are on (1, 2, or 3) */
  private drawRound: number = 0;

  /** Discarded cards pile (for reshuffling if deck runs out) */
  private discardPile: Card[] = [];

  /** F26 (2026-10-21): reshuffles of the discard pile this hand (each its own shuffle domain). */
  private discardReshuffles: number = 0;

  constructor(config: TableConfig, isTripleDraw: boolean = false) {
    super(config);
    this.variant = new FiveCardDrawVariant(isTripleDraw);

    // Set variant properties
    this.variantId = isTripleDraw ? 'triple-draw' : 'five-card-draw';
    this.variantName = isTripleDraw ? '2-7 Triple Draw' : 'Five Card Draw';
    this.holeCardCount = 5;
    this.bettingStructure = isTripleDraw ? 'fixed-limit' : 'no-limit';
    // Deck-safety cap (matches the historically advertised lobby count):
    // 5 hole each + up to 5-card draws per player exhausts the 52-card deck
    // well before 9-handed. Triple Draw (3 draw rounds) is even tighter.
    this.maxOccupiableSeats = 6;
  }

  /**
   * Override: deal 5 hole cards.
   */
  protected getHoleCardCount(): number {
    return 5;
  }

  /**
   * Override: no community cards.
   */
  protected usesCommunityCards(): boolean {
    return false;
  }

  /**
   * Override: evaluate hand based on variant type.
   */
  protected evaluatePlayerHand(holeCards: Card[], _communityCards: Card[]): HandResult {
    if (this.variant.isTripleDraw) {
      return evaluate27LowHand(holeCards);
    }
    return evaluateHand(holeCards);
  }

  /**
   * 2026-06-11 audit G2: 2-7 Triple Draw is LOWBALL — the best low hand wins.
   * compare27Hands returns NEGATIVE when `a` is the better low (lower badness
   * / lower cards), so invert it to awardPots' positive-wins contract.
   * Regular Five Card Draw is high-hand-wins (inherits compareTo).
   * NOTE: BadugiTable extends this class with isTripleDraw=true but overrides
   * this method, so Badugi never reaches the 2-7 branch here.
   */
  protected getHandComparator(): (a: HandResult, b: HandResult) => number {
    if (this.variant.isTripleDraw) {
      return (a: HandResult, b: HandResult) => -compare27Hands(a, b);
    }
    return super.getHandComparator();
  }

  /**
   * 2026-06-11 audit C15: draw-round progress (drawsCompleted / currentDrawPhase
   * / drawRound / discardPile) is NOT base-class state, so a Railway redeploy
   * mid-hand lost it — letting a player draw AGAIN in the same draw round after
   * restart (hand improvement). Persist + restore it. (BadugiTable extends this
   * class, so this covers Badugi's draw rounds too.)
   */
  serializeSnapshot(): PokerTableSnapshot {
    const snap = super.serializeSnapshot();
    (snap as any).variantState = {
      ...((snap as any).variantState || {}),
      drawsCompleted: Array.from(this.drawsCompleted),
      currentDrawPhase: this.currentDrawPhase,
      drawRound: this.drawRound,
      discardPile: this.discardPile,
      discardOverflow: this._discardOverflow,
      discardReshuffles: this.discardReshuffles,
    };
    return snap;
  }

  rehydrateFromSnapshot(snap: PokerTableSnapshot): void {
    super.rehydrateFromSnapshot(snap);
    const vs = (snap as any).variantState;
    if (vs) {
      if (Array.isArray(vs.drawsCompleted)) this.drawsCompleted = new Set(vs.drawsCompleted);
      if (vs.currentDrawPhase !== undefined) this.currentDrawPhase = vs.currentDrawPhase;
      if (typeof vs.drawRound === 'number') this.drawRound = vs.drawRound;
      if (Array.isArray(vs.discardPile)) this.discardPile = vs.discardPile;
      if (Array.isArray(vs.discardOverflow)) this._discardOverflow = vs.discardOverflow;
      if (typeof vs.discardReshuffles === 'number') this.discardReshuffles = vs.discardReshuffles;
    }
  }

  /**
   * Override: after PreFlop betting, go to Draw1 phase (not Flop).
   * Draw games follow: PreFlop -> Draw1 -> Bet2 -> (Draw2 -> Bet3 -> Draw3 -> Bet4 for triple) -> Showdown
   */
  protected getNextPhase(): GamePhase | null {
    if (this.variant.isTripleDraw) {
      switch (this.currentPhase) {
        case GamePhase.PreFlop: return GamePhase.Draw1;
        case GamePhase.Draw1: return GamePhase.Bet2;
        case GamePhase.Bet2: return GamePhase.Draw2;
        case GamePhase.Draw2: return GamePhase.Bet3;
        case GamePhase.Bet3: return GamePhase.Draw3;
        case GamePhase.Draw3: return GamePhase.Bet4;
        case GamePhase.Bet4: return GamePhase.Showdown;
        default: return null;
      }
    } else {
      switch (this.currentPhase) {
        case GamePhase.PreFlop: return GamePhase.Draw1;
        case GamePhase.Draw1: return GamePhase.Bet2;
        case GamePhase.Bet2: return GamePhase.Showdown;
        default: return null;
      }
    }
  }

  /**
   * Override: no community cards to deal.
   */
  protected dealCommunityCardsForPhase(_phase: GamePhase): void {
    // Draw games have no community cards.
    // Draw phases are handled separately via playerDraw().
    // Bet phases just need the betting round reset (already done by parent).

    // If entering a draw phase, set up the draw state
    if (_phase === GamePhase.Draw1 || _phase === GamePhase.Draw2 || _phase === GamePhase.Draw3) {
      this.drawRound++;
      const drawPhaseMap: Record<string, VariantPhase> = {
        [GamePhase.Draw1]: 'Draw1',
        [GamePhase.Draw2]: 'Draw2',
        [GamePhase.Draw3]: 'Draw3',
      };
      this.currentDrawPhase = drawPhaseMap[_phase] || null;
      this.drawsCompleted.clear();
      // F27 (2026-10-21): an all-in seat is NOT stood pat here any more. All-in
      // ends a player's betting, not his drawing: he draws in every draw round
      // like everyone else (he used to be frozen at the hand he was dealt).

      this.emit('drawPhaseStarted', { phase: this.currentDrawPhase, drawRound: this.drawRound });
    }
  }

  /**
   * Override advanceToNextStreet for draw phases.
   * Draw phases don't follow normal betting logic - they wait for all players to draw.
   */
  protected advanceToNextStreet(): void {
    const nextPhase = this.getNextPhase();

    if (nextPhase === null || nextPhase === GamePhase.Showdown) {
      this.currentPhase = GamePhase.Showdown;
      this.determineWinners();
      return;
    }

    // Check if only one player remains (GAME-10: a cardless seat is not in the hand)
    const playingSeats = this.seats.filter(
      s => s.state === 'occupied' && !s.folded && !s.eliminated && s.holeCards.length > 0
    );
    if (playingSeats.length <= 1) {
      this.accumulateInvestments();
      this.determineWinners();
      return;
    }

    // For draw phases, we enter the phase and wait for playerDraw calls
    if (nextPhase === GamePhase.Draw1 || nextPhase === GamePhase.Draw2 || nextPhase === GamePhase.Draw3) {
      this.accumulateInvestments();
      this.currentPhase = nextPhase;
      // F28 (2026-10-21): a draw round has no bet to match. accumulateInvestments
      // put the closed round's bets in the pot (every currentBet is 0), but
      // currentBetToMatch still held that round's bet, so every seat "owed" it
      // during the draw. isValidAction also refuses every betting action in a
      // draw round now (the seat that closed the betting is still
      // activeSeatIndex: a call / raise / fold there used to be accepted).
      this.currentBetToMatch = 0;
      this.dealCommunityCardsForPhase(nextPhase); // Sets up draw state
      this.emit('phaseChanged', { phase: this.currentPhase });
      // F27 (2026-10-21): the round always waits for the draws — an all-in
      // seat draws too (it used to be stood pat, and a hand where everyone was
      // all-in skipped every draw round).
      return;
    }

    // F44 (2026-10-21): no betting round when at most one player can still bet
    // (the others are all-in): nobody could call a bet, so the lone player was
    // handed a pointless turn (three of them in Triple Draw / Badugi) on a 30s
    // clock. Skip it — on to the next draw round (where everyone still draws)
    // or the showdown, as the base engine runs out the board.
    if (this.actingPlayers().length <= 1) {
      this.currentPhase = nextPhase;
      this.resetBettingRound();
      this.emit('phaseChanged', { phase: this.currentPhase });
      this.advanceToNextStreet();
      return;
    }

    // For betting phases, use normal logic
    this.currentPhase = nextPhase;
    this.resetBettingRound();
    this.emit('phaseChanged', { phase: this.currentPhase });
    this.setFirstActivePlayer();

    if (this.isBettingRoundComplete()) {
      this.accumulateInvestments();
      this.advanceToNextStreet();
    }
  }

  /**
   * Override: no board to run out in draw games.
   */
  protected runOutBoard(): void {
    // In draw games, there's no board. Just go to showdown.
    this.currentPhase = GamePhase.Showdown;
    this.emit('phaseChanged', { phase: this.currentPhase });
    this.determineWinners();
  }

  /**
   * Override startNewHand to reset draw state.
   */
  startNewHand(): boolean {
    // F1 (2026-10-10): a nested call is refused by the base class — never reset this hand's draw state for it.
    // P2: likewise a call made while the previous hand is still completing (its handResult listeners).
    if (this.isStartingHand() || this.isCompletingHand()) return super.startNewHand();
    this.drawsCompleted.clear();
    this.currentDrawPhase = null;
    this.drawRound = 0;
    this.discardPile = [];
    this._discardOverflow = [];
    this.discardReshuffles = 0;
    return super.startNewHand();
  }

  /**
   * Player draw action: discard selected cards and receive replacements.
   * @param seatIndex The seat performing the draw
   * @param discardIndices Indices of cards to discard (0-4), empty = stand pat
   */
  playerDraw(seatIndex: number, discardIndices: number[]): boolean {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return false;
    // 2026-10-11 (.online R2, GAME-6) — a draw exists ONLY in a draw round. With
    // no phase check a player could swap cards during any BETTING round too
    // (repeatedly, one per round — drawsCompleted is cleared at each draw
    // round): extra draws, a cheat.
    if (!FiveCardDrawTable.DRAW_PHASES.includes(this.currentPhase)) return false;

    const seat = this.seats[seatIndex];
    if (seat.state !== 'occupied' || seat.folded || seat.eliminated) return false;
    // GAME-6 / GAME-10 — and only by a seat DEALT INTO this hand.
    if (seat.holeCards.length === 0) return false;

    // Validate indices (whole numbers only — a socket payload is untyped)
    if (!Array.isArray(discardIndices)) return false;
    if (discardIndices.length > 5) return false;
    for (const idx of discardIndices) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= seat.holeCards.length) return false;
    }

    // Check for duplicates
    const uniqueIndices = new Set(discardIndices);
    if (uniqueIndices.size !== discardIndices.length) return false;

    // Already drew this round?
    if (this.drawsCompleted.has(seatIndex)) return false;

    // Sort indices descending so removal doesn't shift later indices
    const sortedIndices = [...discardIndices].sort((a, b) => b - a);

    // Remove the discarded cards. F26 (2026-10-21): they are held aside and
    // reach the discard pile only AFTER this player's replacements are dealt —
    // a drawer never gets his own discards back (the standard rule). Before, a
    // reshuffle during his draw could hand them straight back to him.
    const thrown: Card[] = [];
    for (const idx of sortedIndices) {
      thrown.push(...seat.holeCards.splice(idx, 1));
    }

    // Deal replacement cards: the deck, then the reshuffled discards
    for (let i = 0; i < discardIndices.length; i++) {
      const newCard = this.dealReplacementCard();
      if (newCard) {
        seat.holeCards.push(newCard);
      }
    }
    this.discardPile.push(...thrown);

    this.drawsCompleted.add(seatIndex);

    this.emit('playerDrew', {
      seatIndex,
      discardCount: discardIndices.length,
    });

    this.completeDrawRoundIfDone();
    return true;
  }

  /** The draw rounds (playerDraw is refused in any other phase). */
  static readonly DRAW_PHASES: readonly GamePhase[] = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];

  /**
   * End the current draw round when every seat that still has to draw has
   * drawn, and move on to the next betting round (or award the pot when one
   * player is left). Called after each draw, and by index.ts after a seat was
   * folded OUTSIDE its turn during a draw round (a leaver — forceFoldSeat
   * never advances anything; before R2 the round then waited for a draw that
   * could never come). Only dealt-in seats are waited for (GAME-10: a mid-hand
   * joiner holds no cards). Returns true when the round was completed.
   */
  completeDrawRoundIfDone(): boolean {
    if (!FiveCardDrawTable.DRAW_PHASES.includes(this.currentPhase)) return false;
    // Check if every seat still in the hand has drawn. F27 (2026-10-21): an
    // all-in seat too — it is no longer stood pat for the player.
    const mustDraw = this.seats.filter(
      s => s.state === 'occupied' && !s.folded && !s.eliminated && s.holeCards.length > 0
    );

    const allDrawn = mustDraw.every(s => this.drawsCompleted.has(s.seatIndex));
    if (!allDrawn) return false;

    // Move to next betting phase
    this.drawsCompleted.clear();
    this.currentDrawPhase = null;
    this.emit('drawPhaseComplete', { phase: this.currentDrawPhase });

    // Advance to next phase (betting)
    this.advanceToNextStreet();
    return true;
  }

  /** Overflow buffer: shuffled discards used when the main deck is exhausted */
  private _discardOverflow: Card[] = [];

  /**
   * F26 (2026-10-21) — the next replacement card: the deck, then what is left
   * of the reshuffled discards, and only when both are empty a new reshuffle.
   * (It used to reshuffle on every card once the deck ran dry, REPLACING the
   * cards still waiting in the overflow — they dropped out of the hand — so
   * every later drawer was dealt back only his own discards.)
   */
  private dealReplacementCard(): Card | null {
    const fromDeck = this.deck.dealOne();
    if (fromDeck) return fromDeck;
    if (this._discardOverflow.length === 0) this.reshuffleDiscardPile();
    return this._discardOverflow.length > 0 ? this._discardOverflow.pop()! : null;
  }

  /**
   * Reshuffle the discard pile into _discardOverflow so playerDraw can draw from it.
   * Uses the deck's seeded PRNG so the reshuffle is provably fair (verifiable
   * after the hand by combining the revealed seed with the 'discards' domain tag).
   * F26: the first reshuffle of a hand keeps the domain `discards-h<hand>`; each
   * later one appends `-r<n>` (the same domain would replay the same shuffle).
   * The shuffled cards are added to the overflow, never replace it.
   */
  private reshuffleDiscardPile(): void {
    if (this.discardPile.length === 0) return;
    this.discardReshuffles++;
    const domain = this.discardReshuffles === 1
      ? `discards-h${this.handNumber}`
      : `discards-h${this.handNumber}-r${this.discardReshuffles}`;
    const cards = this.deck.shuffleForeignCards(this.discardPile, domain);
    this.discardPile = [];
    this._discardOverflow = [...cards, ...this._discardOverflow];
  }

  /**
   * Override: for fixed-limit (triple draw), enforce bet sizing.
   */
  protected getMaxRaise(seatIndex: number): number {
    if (this.variant.bettingStructure === 'fixed-limit') {
      return this.currentBetToMatch + this.getFixedLimitBetSize();
    }
    return Infinity;
  }

  /**
   * 2-7 Triple Draw (and Badugi): the small bet before the draw (Bet1) and
   * after the first draw (Bet2); the big bet after the second and third draws
   * (Bet3, Bet4). 2026-10-21 (gameplay F39) — Bet2 took the big bet; limit
   * triple draw / Badugi use the small bet for the first two rounds.
   * 2026-10-21 (gameplay F30) — also the street's raise size (base
   * resetBettingRound), so a big-bet round's opening bet is exactly the big bet.
   */
  protected getFixedLimitBetSize(): number {
    const isBigBetRound =
      this.currentPhase === GamePhase.Bet3 ||
      this.currentPhase === GamePhase.Bet4;
    return isBigBetRound ? this.handBB() * 2 : this.handBB();
  }
}
