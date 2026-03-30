import { Card, Rank } from '../Card';
import { evaluateHand, HandResult } from '../HandEvaluator';
import { evaluateRazzHand } from '../HandEvaluatorExtensions';
import {
  PokerTable,
  MAX_SEATS,
  GamePhase,
  TableConfig,
} from '../PokerTable';
import { SevenCardStudVariant } from './SevenCardStudVariant';
import { PokerVariant, VariantPhase, StudCardInfo } from './PokerVariant';

/**
 * SevenStudTable extends PokerTable for Seven Card Stud and Razz.
 *
 * Key differences from Hold'em:
 * - No community cards
 * - Deal pattern: 2 down + 1 up (3rd), then 1 up each (4th-6th), then 1 down (7th)
 * - Track which cards are face-up per player
 * - Betting starts with lowest (or highest for Razz) showing card
 * - Max 8 players (52 cards / 7 cards per player max)
 */
export class SevenStudTable extends PokerTable {
  public variant: SevenCardStudVariant;

  /** Track face-up/face-down status of each player's cards */
  public cardVisibility: Map<number, boolean[]> = new Map();

  /** Current stud phase */
  public currentStudPhase: VariantPhase = 'ThirdStreet';

  /** Current stud street index (0=3rd, 1=4th, ..., 4=7th) */
  private studStreetIndex: number = 0;

  constructor(config: TableConfig, isRazz: boolean = false) {
    super(config);
    this.variant = new SevenCardStudVariant(isRazz);

    // Set variant properties
    this.variantId = isRazz ? 'razz' : 'seven-stud';
    this.variantName = isRazz ? 'Razz' : 'Seven Card Stud';
    this.holeCardCount = 7;
    this.bettingStructure = 'fixed-limit';
  }

  /**
   * Override: no community cards in stud.
   */
  protected usesCommunityCards(): boolean {
    return false;
  }

  /**
   * Override: use stud/razz evaluation.
   */
  protected evaluatePlayerHand(holeCards: Card[], _communityCards: Card[]): HandResult {
    if (this.variant.isRazz) {
      return evaluateRazzHand(holeCards);
    }
    return evaluateHand(holeCards);
  }

  /**
   * Override: stud phase progression.
   */
  protected getNextPhase(): GamePhase | null {
    switch (this.currentPhase) {
      case GamePhase.PreFlop: return GamePhase.ThirdStreet; // Initial deal -> ThirdStreet betting
      case GamePhase.ThirdStreet: return GamePhase.FourthStreet;
      case GamePhase.FourthStreet: return GamePhase.FifthStreet;
      case GamePhase.FifthStreet: return GamePhase.SixthStreet;
      case GamePhase.SixthStreet: return GamePhase.SeventhStreet;
      case GamePhase.SeventhStreet: return GamePhase.Showdown;
      default: return null;
    }
  }

  /**
   * Override: deal stud cards instead of community cards.
   */
  protected dealCommunityCardsForPhase(phase: GamePhase): void {
    // Stud deals cards to individual players, not to community
    const studPhaseMap: Record<string, VariantPhase> = {
      [GamePhase.ThirdStreet]: 'ThirdStreet',
      [GamePhase.FourthStreet]: 'FourthStreet',
      [GamePhase.FifthStreet]: 'FifthStreet',
      [GamePhase.SixthStreet]: 'SixthStreet',
      [GamePhase.SeventhStreet]: 'SeventhStreet',
    };

    const studPhase = studPhaseMap[phase];
    if (studPhase) {
      this.currentStudPhase = studPhase;
      this.dealStudCards(studPhase);
    }
  }

  /**
   * Override: deal initial cards differently for stud.
   * Instead of 2 hole cards, deal 2 face-down + 1 face-up.
   */
  protected dealHoleCardsImpl(): void {
    // In stud, the initial deal is 2 down + 1 up (ThirdStreet)
    // We'll deal them here and then the game starts on ThirdStreet betting
    const activePlayers = this.seats.filter(
      s => s.state === 'occupied' && !s.eliminated && s.chipCount >= 0
    );

    for (const seat of activePlayers) {
      this.cardVisibility.set(seat.seatIndex, []);
      const vis = this.cardVisibility.get(seat.seatIndex)!;

      // 2 face-down cards
      for (let i = 0; i < 2; i++) {
        const card = this.deck.dealOne();
        if (card) {
          seat.holeCards.push(card);
          vis.push(false);
        }
      }
      // 1 face-up card
      const upCard = this.deck.dealOne();
      if (upCard) {
        seat.holeCards.push(upCard);
        vis.push(true);
      }
    }

    this.currentStudPhase = 'ThirdStreet';
    this.studStreetIndex = 0;
  }

  /**
   * Override startNewHand to set phase to ThirdStreet instead of PreFlop.
   */
  startNewHand(): boolean {
    this.cardVisibility.clear();
    this.currentStudPhase = 'ThirdStreet';
    this.studStreetIndex = 0;

    const result = super.startNewHand();
    if (result) {
      // Override the phase to ThirdStreet since stud starts there
      this.currentPhase = GamePhase.ThirdStreet;
      this.emit('phaseChanged', { phase: this.currentPhase });

      // Set first actor based on showing cards
      const firstActor = this.getStudFirstActor();
      if (firstActor >= 0) {
        this.activeSeatIndex = firstActor;
        this.emit('turnChanged', { seatIndex: this.activeSeatIndex });
      }
    }
    return result;
  }

  /**
   * Deal stud cards for a phase.
   */
  private dealStudCards(phase: VariantPhase): void {
    this.currentStudPhase = phase;
    const activePlayers = this.seats.filter(
      s => s.state === 'occupied' && !s.folded && !s.eliminated
    );

    if (phase === 'ThirdStreet') {
      // Already dealt in dealHoleCardsImpl, nothing to do
      return;
    }

    if (phase === 'SeventhStreet') {
      // 1 face-down card
      for (const seat of activePlayers) {
        const vis = this.cardVisibility.get(seat.seatIndex) || [];
        const card = this.deck.dealOne();
        if (card) {
          seat.holeCards.push(card);
          vis.push(false);
          this.cardVisibility.set(seat.seatIndex, vis);
        }
      }
    } else {
      // FourthStreet, FifthStreet, SixthStreet: 1 face-up card
      for (const seat of activePlayers) {
        const vis = this.cardVisibility.get(seat.seatIndex) || [];
        const card = this.deck.dealOne();
        if (card) {
          seat.holeCards.push(card);
          vis.push(true);
          this.cardVisibility.set(seat.seatIndex, vis);
        }
      }
    }

    this.studStreetIndex++;
  }

  /**
   * Override: set first active player based on showing cards.
   */
  protected setFirstActivePlayer(): void {
    const firstActor = this.getStudFirstActor();
    if (firstActor >= 0) {
      this.activeSeatIndex = firstActor;
      this.emit('turnChanged', { seatIndex: this.activeSeatIndex });
    } else {
      super.setFirstActivePlayer();
    }
  }

  /**
   * Override: no board to run out in stud games.
   */
  protected runOutBoard(): void {
    // Deal remaining streets without betting
    const phases: VariantPhase[] = [
      'ThirdStreet', 'FourthStreet', 'FifthStreet', 'SixthStreet', 'SeventhStreet'
    ];
    const currentIdx = phases.indexOf(this.currentStudPhase);

    for (let i = currentIdx + 1; i < phases.length; i++) {
      this.dealStudCards(phases[i]);
    }

    this.currentPhase = GamePhase.Showdown;
    this.emit('phaseChanged', { phase: this.currentPhase });
    this.determineWinners();
  }

  /**
   * Override: enforce fixed-limit betting.
   */
  protected getMaxRaise(_seatIndex: number): number {
    const isLateRound = [
      GamePhase.FifthStreet,
      GamePhase.SixthStreet,
      GamePhase.SeventhStreet,
    ].includes(this.currentPhase);
    const betSize = isLateRound ? this.config.bigBlind * 2 : this.config.bigBlind;
    return this.currentBetToMatch + betSize;
  }

  /**
   * Get the face-up cards for a given seat (visible to all players).
   */
  getFaceUpCards(seatIndex: number): Card[] {
    const seat = this.seats[seatIndex];
    const visibility = this.cardVisibility.get(seatIndex) || [];
    const faceUp: Card[] = [];

    for (let i = 0; i < seat.holeCards.length; i++) {
      if (visibility[i]) {
        faceUp.push(seat.holeCards[i]);
      }
    }

    return faceUp;
  }

  /**
   * Get the face-down cards for a given seat (only visible to the player).
   */
  getFaceDownCards(seatIndex: number): Card[] {
    const seat = this.seats[seatIndex];
    const visibility = this.cardVisibility.get(seatIndex) || [];
    const faceDown: Card[] = [];

    for (let i = 0; i < seat.holeCards.length; i++) {
      if (!visibility[i]) {
        faceDown.push(seat.holeCards[i]);
      }
    }

    return faceDown;
  }

  /**
   * Get all card info (card + visibility) for a given seat.
   */
  getStudCardInfo(seatIndex: number): StudCardInfo[] {
    const seat = this.seats[seatIndex];
    const visibility = this.cardVisibility.get(seatIndex) || [];
    const info: StudCardInfo[] = [];

    for (let i = 0; i < seat.holeCards.length; i++) {
      info.push({
        card: seat.holeCards[i],
        faceUp: visibility[i] || false,
      });
    }

    return info;
  }

  /**
   * Determine the seat that acts first based on showing cards.
   * For Stud: lowest showing card brings it in.
   * For Razz: highest showing card (worst low) brings it in.
   * On 4th+ street: highest showing hand acts first (Stud) or lowest (Razz).
   */
  getStudFirstActor(): number {
    const activePlayers = this.seats.filter(
      s => s.state === 'occupied' && !s.folded && !s.allIn && !s.eliminated
    );

    if (activePlayers.length === 0) return -1;

    if (this.currentStudPhase === 'ThirdStreet') {
      // Find the player with the lowest (Stud) or highest (Razz) door card
      let target = activePlayers[0];
      for (const seat of activePlayers) {
        const faceUp = this.getFaceUpCards(seat.seatIndex);
        const targetFaceUp = this.getFaceUpCards(target.seatIndex);

        if (faceUp.length === 0) continue;
        if (targetFaceUp.length === 0) { target = seat; continue; }

        if (this.variant.isRazz) {
          // Razz: highest card (worst) brings it in
          if (faceUp[0].rank > targetFaceUp[0].rank) {
            target = seat;
          }
        } else {
          // Stud: lowest card brings it in
          if (faceUp[0].rank < targetFaceUp[0].rank) {
            target = seat;
          }
        }
      }
      return target.seatIndex;
    }

    // 4th+ street: highest (Stud) or lowest (Razz) showing hand acts first
    let target = activePlayers[0];
    for (const seat of activePlayers) {
      const faceUp = this.getFaceUpCards(seat.seatIndex);
      const targetFaceUp = this.getFaceUpCards(target.seatIndex);

      // Simple comparison: compare highest face-up card
      const maxRank = faceUp.length > 0 ? Math.max(...faceUp.map(c => c.rank)) : 0;
      const targetMaxRank = targetFaceUp.length > 0 ? Math.max(...targetFaceUp.map(c => c.rank)) : 0;

      if (this.variant.isRazz) {
        // Razz: lowest showing hand acts first
        if (maxRank < targetMaxRank) target = seat;
      } else {
        // Stud: highest showing hand acts first
        if (maxRank > targetMaxRank) target = seat;
      }
    }
    return target.seatIndex;
  }
}
