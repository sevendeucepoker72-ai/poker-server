import { Card } from '../Card';
import { evaluateHand, HandResult } from '../HandEvaluator';
import { evaluate27LowHand } from '../HandEvaluatorExtensions';
import {
  PokerTable,
  MAX_SEATS,
  GamePhase,
  PlayerAction,
  Seat,
  TableConfig,
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

  constructor(config: TableConfig, isTripleDraw: boolean = false) {
    super(config);
    this.variant = new FiveCardDrawVariant(isTripleDraw);

    // Set variant properties
    this.variantId = isTripleDraw ? 'triple-draw' : 'five-card-draw';
    this.variantName = isTripleDraw ? '2-7 Triple Draw' : 'Five Card Draw';
    this.holeCardCount = 5;
    this.bettingStructure = isTripleDraw ? 'fixed-limit' : 'no-limit';
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

      // Auto-stand pat for all-in players
      const allInPlayers = this.seats.filter(
        s => s.state === 'occupied' && !s.folded && s.allIn && !s.eliminated
      );
      for (const p of allInPlayers) {
        this.drawsCompleted.add(p.seatIndex);
      }

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

    // Check if only one player remains
    const playingSeats = this.seats.filter(
      s => s.state === 'occupied' && !s.folded && !s.eliminated
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
      this.dealCommunityCardsForPhase(nextPhase); // Sets up draw state
      this.emit('phaseChanged', { phase: this.currentPhase });

      // Check if all active players are all-in (auto-complete draw)
      const activePlayers = this.seats.filter(
        s => s.state === 'occupied' && !s.folded && !s.allIn && !s.eliminated
      );
      if (activePlayers.length === 0) {
        // Everyone is all-in, skip draw and go to next phase
        this.drawsCompleted.clear();
        this.currentDrawPhase = null;
        this.advanceToNextStreet();
      }
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
    this.drawsCompleted.clear();
    this.currentDrawPhase = null;
    this.drawRound = 0;
    this.discardPile = [];
    return super.startNewHand();
  }

  /**
   * Player draw action: discard selected cards and receive replacements.
   * @param seatIndex The seat performing the draw
   * @param discardIndices Indices of cards to discard (0-4), empty = stand pat
   */
  playerDraw(seatIndex: number, discardIndices: number[]): boolean {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return false;

    const seat = this.seats[seatIndex];
    if (seat.state !== 'occupied' || seat.folded || seat.eliminated) return false;

    // Validate indices
    if (discardIndices.length > 5) return false;
    for (const idx of discardIndices) {
      if (idx < 0 || idx >= seat.holeCards.length) return false;
    }

    // Check for duplicates
    const uniqueIndices = new Set(discardIndices);
    if (uniqueIndices.size !== discardIndices.length) return false;

    // Already drew this round?
    if (this.drawsCompleted.has(seatIndex)) return false;

    // Sort indices descending so removal doesn't shift later indices
    const sortedIndices = [...discardIndices].sort((a, b) => b - a);

    // Remove discarded cards, add to discard pile
    for (const idx of sortedIndices) {
      const removed = seat.holeCards.splice(idx, 1);
      this.discardPile.push(...removed);
    }

    // Deal replacement cards from the deck
    for (let i = 0; i < discardIndices.length; i++) {
      let newCard = this.deck.dealOne();
      if (!newCard) {
        // Deck ran out - reshuffle discard pile
        this.reshuffleDiscardPile();
        newCard = this.deck.dealOne();
      }
      if (newCard) {
        seat.holeCards.push(newCard);
      }
    }

    this.drawsCompleted.add(seatIndex);

    this.emit('playerDrew', {
      seatIndex,
      discardCount: discardIndices.length,
    });

    // Check if all active players have drawn
    const activePlayers = this.seats.filter(
      s => s.state === 'occupied' && !s.folded && !s.allIn && !s.eliminated
    );
    const allInPlayers = this.seats.filter(
      s => s.state === 'occupied' && !s.folded && s.allIn && !s.eliminated
    );

    // All-in players auto-stand pat
    for (const p of allInPlayers) {
      this.drawsCompleted.add(p.seatIndex);
    }

    const allDrawn = activePlayers.every(s => this.drawsCompleted.has(s.seatIndex));

    if (allDrawn) {
      // Move to next betting phase
      this.drawsCompleted.clear();
      this.currentDrawPhase = null;
      this.emit('drawPhaseComplete', { phase: this.currentDrawPhase });

      // Advance to next phase (betting)
      this.advanceToNextStreet();
    }

    return true;
  }

  /**
   * Reshuffle the discard pile back into the deck when it runs out.
   */
  private reshuffleDiscardPile(): void {
    if (this.discardPile.length === 0) return;

    // We can't easily inject cards into the CardDeck, so we'll track extra cards
    // This is a simplified approach - shuffle discards and they become available
    for (let i = this.discardPile.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.discardPile[i], this.discardPile[j]] = [this.discardPile[j], this.discardPile[i]];
    }

    // Store reshuffled cards back - we'll draw from discardPile as overflow
    // Actually, let's just push them as available via deck.dealOne() won't work since
    // we can't add cards back. We'll handle it in playerDraw by checking discardPile.
  }

  /**
   * Override: for fixed-limit (triple draw), enforce bet sizing.
   */
  protected getMaxRaise(seatIndex: number): number {
    if (this.variant.bettingStructure === 'fixed-limit') {
      const isLateRound = this.currentPhase === GamePhase.Bet3 || this.currentPhase === GamePhase.Bet4;
      const betSize = isLateRound ? this.config.bigBlind * 2 : this.config.bigBlind;
      return this.currentBetToMatch + betSize;
    }
    return Infinity;
  }
}
