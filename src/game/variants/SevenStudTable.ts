import { Card, Rank } from '../Card';
import { evaluateHand, HandResult, compareTo } from '../HandEvaluator';
import { evaluateRazzHand } from '../HandEvaluatorExtensions';
import { SidePotManager } from '../SidePotManager';
import {
  PokerTable,
  MAX_SEATS,
  GamePhase,
  TableConfig,
  HandWinResult,
  WinnerInfo,
  ShowdownHandInfo,
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
  public isHiLo: boolean;

  /** Track face-up/face-down status of each player's cards */
  public cardVisibility: Map<number, boolean[]> = new Map();

  /** Current stud phase */
  public currentStudPhase: VariantPhase = 'ThirdStreet';

  /** Current stud street index (0=3rd, 1=4th, ..., 4=7th) */
  private studStreetIndex: number = 0;

  constructor(config: TableConfig, isRazz: boolean = false, isHiLo: boolean = false) {
    super(config);
    this.variant = new SevenCardStudVariant(isRazz);
    this.isHiLo = isHiLo && !isRazz; // Razz is always low-only

    // Set variant properties
    if (this.isHiLo) {
      this.variantId = 'seven-card-stud-hi-lo';
      this.variantName = 'Seven Card Stud Hi-Lo (Stud 8)';
    } else {
      this.variantId = isRazz ? 'razz' : 'seven-stud';
      this.variantName = isRazz ? 'Razz' : 'Seven Card Stud';
    }
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
   * Stud bring-in size (TDA): on Third Street, the player with the lowest
   * door card (or highest for Razz) must "bring it in" with a small forced
   * bet — typically half the small bet, never larger than a full small bet.
   * They may instead "complete" to the full small bet.
   */
  public getBringInAmount(): number {
    // Use small blind as the bring-in (half the small bet by convention)
    return this.config.smallBlind;
  }

  public getCompleteAmount(): number {
    // Full opening bet on third street == small bet (BB in our config)
    return this.config.bigBlind;
  }

  /**
   * Override raise validation on Third Street: the bring-in player can ONLY
   * post the bring-in or "complete" to the small bet — no other raise sizes.
   * On 4th street and later we fall through to standard fixed-limit logic.
   */
  playerRaise(seatIndex: number, totalRaiseAmount: number): boolean {
    if (this.currentPhase === GamePhase.ThirdStreet) {
      const bringIn = this.getBringInAmount();
      const complete = this.getCompleteAmount();
      if (this.currentBetToMatch === 0) {
        if (totalRaiseAmount === bringIn || totalRaiseAmount === complete) {
          return super.playerRaise(seatIndex, totalRaiseAmount);
        }
        return false;
      }
      if (this.currentBetToMatch === bringIn && totalRaiseAmount < complete) {
        return false;
      }
    }
    return super.playerRaise(seatIndex, totalRaiseAmount);
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
   * Override: Stud Hi-Lo splits the pot between best high and best 8-or-better low.
   * If no qualifying low exists, the high hand scoops the pot.
   */
  protected determineWinners(): void {
    if (!this.isHiLo) {
      super.determineWinners();
      return;
    }

    // Split-pot stud (Stud 8). We delegate the high-side calculation to the
    // base class by using a custom evaluator that wraps low-eligible hands,
    // but the simplest approach is: refund uncalled bets, split each pot 50/50
    // between the high winner(s) and qualifying low winner(s) using the same
    // evaluation as Omaha Hi-Lo.

    this.refundUncalledBets();
    const { evaluateLowHand, compareLowHands } = require('../HandEvaluatorExtensions');

    // Use the parent's pot-calculation infrastructure by temporarily marking
    // ourselves as not-hi-lo and calling super, then patch the per-pot results.
    // To keep this implementation simple and avoid duplicating ~200 lines of
    // pot-distribution logic, we instead invoke super.determineWinners() so the
    // HIGH side is awarded normally, then for each pot we compute the low and
    // pull half of those chips back from the high winner to give to the low.
    //
    // This is functionally equivalent to a true 50/50 split when the low
    // qualifies, and a scoop when no low qualifies.

    const seatInfos = this.seats
      .filter(s => s.state === 'occupied' && !s.eliminated && s.totalInvestedThisHand > 0)
      .map(s => ({ seatIndex: s.seatIndex, invested: s.totalInvestedThisHand, folded: s.folded, holeCards: [...s.holeCards] }));

    // Evaluate every non-folded player's high and low hands
    const evaluations = seatInfos
      .filter(s => !s.folded)
      .map(s => ({
        seatIndex: s.seatIndex,
        high: evaluateHand(s.holeCards),
        low: evaluateLowHand(s.holeCards),
      }));

    if (evaluations.length === 0) {
      super.determineWinners();
      return;
    }

    // Build pot tiers using the manager
    const pots = this.sidePotManager.calculatePots(
      this.seats.filter(s => s.state === 'occupied' && !s.eliminated).map(s => ({
        seatIndex: s.seatIndex,
        chipCount: s.chipCount,
        totalInvestedThisHand: s.totalInvestedThisHand,
        folded: s.folded,
        allIn: s.allIn,
        holeCards: s.holeCards,
        state: s.state,
      }))
    );

    const winnerInfos: WinnerInfo[] = [];
    const showdownHands: ShowdownHandInfo[] = [];
    const results: HandWinResult[] = [];

    for (const ev of evaluations) {
      const seat = this.seats[ev.seatIndex];
      showdownHands.push({
        seatIndex: ev.seatIndex,
        playerName: seat.playerName,
        handName: ev.low ? `${ev.high.handName} / ${ev.low.handName}` : ev.high.handName,
        bestFiveCards: ev.high.bestFiveCards,
        holeCards: [...seat.holeCards],
      });
    }

    for (const pot of pots) {
      if (pot.eligibleSeatIndices.length === 0) continue;

      const eligible = evaluations.filter(e => pot.eligibleSeatIndices.includes(e.seatIndex));
      if (eligible.length === 0) continue;

      // Best high
      eligible.sort((a, b) => compareTo(b.high, a.high));
      const bestHigh = eligible[0].high;
      const highWinners = eligible.filter(e => compareTo(e.high, bestHigh) === 0);

      // Best qualifying low
      const lowCandidates = eligible.filter(e => e.low !== null);
      let lowWinners: typeof eligible = [];
      if (lowCandidates.length > 0) {
        lowCandidates.sort((a, b) => compareLowHands(a.low!, b.low!));
        const bestLow = lowCandidates[0].low!;
        lowWinners = lowCandidates.filter(e => compareLowHands(e.low!, bestLow) === 0);
      }

      // Split pot — odd chip to HIGH (TDA Rule 60)
      let highPot: number, lowPot: number;
      if (lowWinners.length > 0) {
        lowPot = Math.floor(pot.amount / 2);
        highPot = pot.amount - lowPot;
      } else {
        highPot = pot.amount;
        lowPot = 0;
      }

      // Award high pot
      const orderedHigh = SidePotManager.orderClockwiseFromDealer(
        highWinners.map(w => w.seatIndex),
        this.dealerButtonSeat
      );
      const highShare = Math.floor(highPot / highWinners.length);
      let highRem = highPot - highShare * highWinners.length;
      for (const seatIdx of orderedHigh) {
        let amt = highShare;
        if (highRem > 0) { amt++; highRem--; }
        this.seats[seatIdx].chipCount += amt;
        results.push({
          seatIndex: seatIdx,
          playerName: this.seats[seatIdx].playerName,
          amount: amt,
          handResult: highWinners.find(w => w.seatIndex === seatIdx)!.high,
          potName: `${pot.name} (High)`,
        });
        const existing = winnerInfos.find(w => w.seatIndex === seatIdx);
        if (existing) {
          existing.chipsWon += amt;
        } else {
          winnerInfos.push({
            seatIndex: seatIdx,
            playerName: this.seats[seatIdx].playerName,
            chipsWon: amt,
            handName: highWinners.find(w => w.seatIndex === seatIdx)!.high.handName,
            bestFiveCards: highWinners.find(w => w.seatIndex === seatIdx)!.high.bestFiveCards,
          });
        }
      }

      // Award low pot
      if (lowPot > 0 && lowWinners.length > 0) {
        const orderedLow = SidePotManager.orderClockwiseFromDealer(
          lowWinners.map(w => w.seatIndex),
          this.dealerButtonSeat
        );
        const lowShare = Math.floor(lowPot / lowWinners.length);
        let lowRem = lowPot - lowShare * lowWinners.length;
        for (const seatIdx of orderedLow) {
          let amt = lowShare;
          if (lowRem > 0) { amt++; lowRem--; }
          this.seats[seatIdx].chipCount += amt;
          results.push({
            seatIndex: seatIdx,
            playerName: this.seats[seatIdx].playerName,
            amount: amt,
            handResult: lowWinners.find(w => w.seatIndex === seatIdx)!.low!,
            potName: `${pot.name} (Low)`,
          });
          const existing = winnerInfos.find(w => w.seatIndex === seatIdx);
          if (existing) {
            existing.chipsWon += amt;
          } else {
            winnerInfos.push({
              seatIndex: seatIdx,
              playerName: this.seats[seatIdx].playerName,
              chipsWon: amt,
              handName: lowWinners.find(w => w.seatIndex === seatIdx)!.low!.handName,
              bestFiveCards: lowWinners.find(w => w.seatIndex === seatIdx)!.low!.bestFiveCards,
            });
          }
        }
      }
    }

    this.lastHandResult = {
      handNumber: this.handNumber,
      winners: winnerInfos,
      showdownHands,
      communityCards: [],
      pots: pots.map(p => ({
        name: p.name,
        amount: p.amount,
        winners: [...new Set(results.filter(r => r.potName?.startsWith(p.name)).map(r => r.seatIndex))],
        winnerAmounts: results.filter(r => r.potName?.startsWith(p.name)).map(r => ({ seatIndex: r.seatIndex, amount: r.amount })),
      })),
    };

    for (const seat of this.seats) {
      seat.totalInvestedThisHand = 0;
    }
    this.currentPhase = GamePhase.HandComplete;
    this.activeSeatIndex = -1;
    this.emit('handResult', { results, handNumber: this.handNumber });
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
  /**
   * TDA suit precedence (highest → lowest): Spades, Hearts, Diamonds, Clubs.
   * Used to break ties when two players have the same door card on Third Street.
   */
  private static readonly SUIT_RANK: Record<number, number> = {
    /* Spades   */ 3: 4,
    /* Hearts   */ 0: 3,
    /* Diamonds */ 1: 2,
    /* Clubs    */ 2: 1,
  };

  getStudFirstActor(): number {
    const activePlayers = this.seats.filter(
      s => s.state === 'occupied' && !s.folded && !s.allIn && !s.eliminated
    );

    if (activePlayers.length === 0) return -1;

    if (this.currentStudPhase === 'ThirdStreet') {
      // Find the player with the lowest (Stud) or highest (Razz) door card.
      // Ties broken by suit using TDA precedence (Spades > Hearts > Diamonds > Clubs).
      // For Stud bring-in (lowest card), the LOWEST suit-rank breaks ties.
      // For Razz bring-in (highest card), the HIGHEST suit-rank breaks ties.
      let target = activePlayers[0];
      for (const seat of activePlayers) {
        const faceUp = this.getFaceUpCards(seat.seatIndex);
        const targetFaceUp = this.getFaceUpCards(target.seatIndex);

        if (faceUp.length === 0) continue;
        if (targetFaceUp.length === 0) { target = seat; continue; }

        const cardA = faceUp[0];
        const cardB = targetFaceUp[0];
        const suitA = SevenStudTable.SUIT_RANK[cardA.suit] ?? 0;
        const suitB = SevenStudTable.SUIT_RANK[cardB.suit] ?? 0;

        if (this.variant.isRazz) {
          // Razz: highest card brings in; ties → highest suit
          if (cardA.rank > cardB.rank) {
            target = seat;
          } else if (cardA.rank === cardB.rank && suitA > suitB) {
            target = seat;
          }
        } else {
          // Stud: lowest card brings in; ties → lowest suit (clubs is lowest)
          if (cardA.rank < cardB.rank) {
            target = seat;
          } else if (cardA.rank === cardB.rank && suitA < suitB) {
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
