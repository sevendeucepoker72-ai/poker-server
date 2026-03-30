import { EventEmitter } from 'events';
import { Card, Rank, Suit, cardToString } from './Card';
import { CardDeck } from './CardDeck';
import { evaluateHand, compareTo, HandResult } from './HandEvaluator';
import { SidePotManager, SeatInfo, Pot, PotWinResult } from './SidePotManager';

export const MAX_SEATS = 9;

export enum GamePhase {
  WaitingForPlayers = 'WaitingForPlayers',
  PreFlop = 'PreFlop',
  Flop = 'Flop',
  Turn = 'Turn',
  River = 'River',
  Showdown = 'Showdown',
  HandComplete = 'HandComplete',
  // Draw game phases
  Draw1 = 'Draw1',
  Draw2 = 'Draw2',
  Draw3 = 'Draw3',
  Bet1 = 'Bet1',
  Bet2 = 'Bet2',
  Bet3 = 'Bet3',
  Bet4 = 'Bet4',
  // Stud game phases
  ThirdStreet = 'ThirdStreet',
  FourthStreet = 'FourthStreet',
  FifthStreet = 'FifthStreet',
  SixthStreet = 'SixthStreet',
  SeventhStreet = 'SeventhStreet',
}

export enum PlayerAction {
  None = 'None',
  Fold = 'Fold',
  Check = 'Check',
  Call = 'Call',
  Raise = 'Raise',
  AllIn = 'AllIn',
}

export interface Seat {
  seatIndex: number;
  state: 'empty' | 'occupied' | 'sitting_out';
  playerName: string;
  chipCount: number;
  currentBet: number;
  totalInvestedThisHand: number;
  holeCards: Card[];
  lastAction: PlayerAction;
  folded: boolean;
  allIn: boolean;
  hasActedSinceLastFullRaise: boolean;
  eliminated: boolean;
  isAI: boolean;
  playerId: string;
  timeBankRemaining: number;
  /** TDA Rule 6-9: Track if player missed their blind obligation */
  missedBlind: 'none' | 'small' | 'big' | 'both';
}

export interface TableConfig {
  smallBlind: number;
  bigBlind: number;
  ante: number;
  minBuyIn: number;
  tableName: string;
  tableId: string;
}

export interface HandWinResult {
  seatIndex: number;
  playerName: string;
  amount: number;
  handResult?: HandResult;
  potName: string;
}

/** Data for a single player's hand at showdown */
export interface ShowdownHandInfo {
  seatIndex: number;
  playerName: string;
  handName: string;
  bestFiveCards: Card[];
  holeCards: Card[];
}

/** Winner info for display */
export interface WinnerInfo {
  seatIndex: number;
  playerName: string;
  chipsWon: number;
  handName: string;
  bestFiveCards: Card[];
}

/** Complete hand result for showdown display and hand history */
export interface LastHandResult {
  handNumber: number;
  winners: WinnerInfo[];
  showdownHands: ShowdownHandInfo[];
  communityCards: Card[];
  pots: { amount: number; winners: number[] }[];
}

/** Player action log entry for hand history */
export interface ActionLogEntry {
  seatIndex: number;
  playerName: string;
  action: string;
}

/** Complete hand history record */
export interface HandHistoryRecord {
  handNumber: number;
  communityCards: Card[];
  players: {
    seatIndex: number;
    name: string;
    holeCards: Card[] | null; // null if mucked
    startChips: number;
    endChips: number;
    actions: string[];
    folded: boolean;
    handName: string | null;
  }[];
  winners: { seatIndex: number; name: string; chipsWon: number; handName: string }[];
  pots: { amount: number; winners: number[] }[];
}

function createEmptySeat(index: number): Seat {
  return {
    seatIndex: index,
    state: 'empty',
    playerName: '',
    chipCount: 0,
    currentBet: 0,
    totalInvestedThisHand: 0,
    holeCards: [],
    lastAction: PlayerAction.None,
    folded: false,
    allIn: false,
    hasActedSinceLastFullRaise: false,
    eliminated: false,
    isAI: false,
    playerId: '',
    timeBankRemaining: 30,
    missedBlind: 'none',
  };
}

export class PokerTable extends EventEmitter {
  public seats: Seat[] = [];
  public dealerButtonSeat: number = -1;
  public currentPhase: GamePhase = GamePhase.WaitingForPlayers;
  public communityCards: Card[] = [];
  public currentBetToMatch: number = 0;
  public activeSeatIndex: number = -1;
  public handNumber: number = 0;
  public lastRaiseAmount: number = 0;

  /** Persists until next hand starts - contains showdown results for display */
  public lastHandResult: LastHandResult | null = null;

  /** Action log for the current hand (for hand history) */
  public actionLog: ActionLogEntry[] = [];

  /** Starting chip counts at beginning of hand (for hand history) */
  public startChips: Map<number, number> = new Map();

  /** TDA Rule 16: Track last aggressor seat for showdown order */
  public lastAggressorSeat: number = -1;

  protected deck: CardDeck;
  protected sidePotManager: SidePotManager;
  public config: TableConfig;

  // Variant properties - subclasses can override these
  public variantId: string = 'holdem';
  public variantName: string = "Texas Hold'em";
  public holeCardCount: number = 2;
  public bettingStructure: 'no-limit' | 'pot-limit' | 'fixed-limit' = 'no-limit';

  constructor(config: TableConfig) {
    super();
    this.config = config;
    this.deck = new CardDeck();
    this.sidePotManager = new SidePotManager();

    // Initialize empty seats
    for (let i = 0; i < MAX_SEATS; i++) {
      this.seats.push(createEmptySeat(i));
    }
  }

  // ========== Seat Management ==========

  sitDown(
    seatIndex: number,
    playerName: string,
    buyIn: number,
    playerId: string,
    isAI: boolean = false
  ): boolean {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return false;
    if (this.seats[seatIndex].state !== 'empty') return false;
    if (buyIn < this.config.minBuyIn) return false;

    const seat = this.seats[seatIndex];
    seat.state = 'occupied';
    seat.playerName = playerName;
    seat.chipCount = buyIn;
    seat.playerId = playerId;
    seat.isAI = isAI;
    seat.eliminated = false;
    seat.folded = false;
    seat.allIn = false;

    this.emit('playerSatDown', { seatIndex, playerName, buyIn, isAI });
    return true;
  }

  standUp(seatIndex: number): boolean {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return false;
    if (this.seats[seatIndex].state === 'empty') return false;

    const playerName = this.seats[seatIndex].playerName;
    this.seats[seatIndex] = createEmptySeat(seatIndex);

    this.emit('playerStoodUp', { seatIndex, playerName });
    return true;
  }

  /** TDA Rule 6-9: Mark a seat as having missed their blind obligation */
  markMissedBlind(seatIndex: number, blindType: 'small' | 'big'): void {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return;
    const seat = this.seats[seatIndex];
    if (seat.state !== 'occupied') return;

    if (seat.missedBlind === 'none') {
      seat.missedBlind = blindType;
    } else if (
      (seat.missedBlind === 'small' && blindType === 'big') ||
      (seat.missedBlind === 'big' && blindType === 'small')
    ) {
      seat.missedBlind = 'both';
    }
  }

  // ========== Hand Flow ==========

  startNewHand(): boolean {
    const occupiedSeats = this.seats.filter(
      s => s.state === 'occupied' && !s.eliminated && s.chipCount > 0
    );

    if (occupiedSeats.length < 2) {
      return false;
    }

    this.handNumber++;

    // Reset seats for new hand
    for (const seat of this.seats) {
      if (seat.state === 'occupied') {
        seat.currentBet = 0;
        seat.totalInvestedThisHand = 0;
        seat.holeCards = [];
        seat.lastAction = PlayerAction.None;
        seat.folded = false;
        seat.allIn = false;
        seat.hasActedSinceLastFullRaise = false;

        // Eliminate players with no chips
        if (seat.chipCount <= 0) {
          seat.eliminated = true;
        }
      }
    }

    this.communityCards = [];
    this.currentBetToMatch = 0;
    this.lastRaiseAmount = this.config.bigBlind;
    this.lastAggressorSeat = -1;
    this.actionLog = [];

    // Capture starting chip counts for hand history
    this.startChips = new Map();
    for (const seat of this.seats) {
      if (seat.state === 'occupied' && !seat.eliminated) {
        this.startChips.set(seat.seatIndex, seat.chipCount);
      }
    }

    // Shuffle deck (overridable for variant decks like Short Deck)
    this.resetDeck();

    // Move dealer button
    this.moveDealerButton();

    // Post blinds
    this.postBlinds();

    // Deal hole cards
    this.dealHoleCards();

    // Set phase to PreFlop
    this.currentPhase = GamePhase.PreFlop;
    this.emit('phaseChanged', { phase: this.currentPhase });

    // Set active seat to UTG (or appropriate position)
    this.setFirstActivePlayer();

    this.emit('handStarted', { handNumber: this.handNumber, dealerSeat: this.dealerButtonSeat });

    return true;
  }

  protected moveDealerButton(): void {
    if (this.dealerButtonSeat === -1) {
      // First hand - pick first occupied seat
      const firstOccupied = this.getNextOccupiedSeat(0);
      if (firstOccupied !== -1) {
        this.dealerButtonSeat = firstOccupied;
      }
    } else {
      // Move to next occupied seat
      const next = this.getNextOccupiedSeat(this.dealerButtonSeat + 1);
      if (next !== -1) {
        this.dealerButtonSeat = next;
      }
    }
  }

  protected postBlinds(): void {
    const activePlayers = this.getActivePlayerSeats();

    if (activePlayers.length < 2) return;

    const isHeadsUp = activePlayers.length === 2;

    let sbSeat: number;
    let bbSeat: number;

    if (isHeadsUp) {
      // TDA Rule 5: Heads-up - dealer posts SB, other player posts BB
      sbSeat = this.dealerButtonSeat;
      bbSeat = this.getNextOccupiedSeat(this.dealerButtonSeat + 1);
    } else {
      // TDA Rules 6-9: SB is left of dealer, BB is left of SB
      sbSeat = this.getNextOccupiedSeat(this.dealerButtonSeat + 1);
      bbSeat = this.getNextOccupiedSeat(sbSeat + 1);
    }

    // TDA Rule 6-9: Handle missed blinds - players returning must post
    for (const seatIdx of activePlayers) {
      const seat = this.seats[seatIdx];
      if (seat.missedBlind !== 'none' && seatIdx !== sbSeat && seatIdx !== bbSeat) {
        // Player missed blind(s) - post dead blind (goes to pot, doesn't count toward bet)
        let deadAmount = 0;
        if (seat.missedBlind === 'both') {
          deadAmount = this.config.smallBlind + this.config.bigBlind;
        } else if (seat.missedBlind === 'big') {
          deadAmount = this.config.bigBlind;
        } else if (seat.missedBlind === 'small') {
          deadAmount = this.config.smallBlind;
        }
        if (deadAmount > 0) {
          const postAmount = Math.min(deadAmount, seat.chipCount);
          seat.chipCount -= postAmount;
          seat.totalInvestedThisHand += postAmount;
          // Dead blind doesn't count toward currentBet - it's dead money
          if (seat.chipCount === 0) {
            seat.allIn = true;
          }
          this.emit('blindPosted', { seatIndex: seatIdx, amount: postAmount, type: 'dead' });
          this.actionLog.push({
            seatIndex: seatIdx,
            playerName: seat.playerName,
            action: `posted dead blind ${postAmount}`,
          });
        }
        seat.missedBlind = 'none'; // Clear after posting
      }
    }

    // Post antes first
    if (this.config.ante > 0) {
      for (const seat of activePlayers) {
        const anteAmount = Math.min(this.config.ante, this.seats[seat].chipCount);
        this.seats[seat].chipCount -= anteAmount;
        this.seats[seat].totalInvestedThisHand += anteAmount;
        // Antes don't count toward currentBet
      }
    }

    // Post small blind
    if (sbSeat !== -1) {
      const sbAmount = Math.min(this.config.smallBlind, this.seats[sbSeat].chipCount);
      this.seats[sbSeat].chipCount -= sbAmount;
      this.seats[sbSeat].currentBet = sbAmount;
      this.seats[sbSeat].totalInvestedThisHand += sbAmount;
      if (this.seats[sbSeat].chipCount === 0) {
        this.seats[sbSeat].allIn = true;
      }
      this.actionLog.push({
        seatIndex: sbSeat,
        playerName: this.seats[sbSeat].playerName,
        action: `posted SB ${sbAmount}`,
      });

      this.emit('blindPosted', {
        seatIndex: sbSeat,
        amount: sbAmount,
        type: 'small',
      });
    }

    // Post big blind
    if (bbSeat !== -1) {
      const bbAmount = Math.min(this.config.bigBlind, this.seats[bbSeat].chipCount);
      this.seats[bbSeat].chipCount -= bbAmount;
      this.seats[bbSeat].currentBet = bbAmount;
      this.seats[bbSeat].totalInvestedThisHand += bbAmount;
      if (this.seats[bbSeat].chipCount === 0) {
        this.seats[bbSeat].allIn = true;
      }
      this.actionLog.push({
        seatIndex: bbSeat,
        playerName: this.seats[bbSeat].playerName,
        action: `posted BB ${bbAmount}`,
      });

      this.emit('blindPosted', {
        seatIndex: bbSeat,
        amount: bbAmount,
        type: 'big',
      });
    }

    this.currentBetToMatch = this.config.bigBlind;
  }

  /**
   * Deal hole cards. Calls the overridable dealHoleCardsImpl().
   */
  protected dealHoleCards(): void {
    this.dealHoleCardsImpl();
  }

  /**
   * Overridable: the actual dealing logic.
   * Default deals 2 cards per player for Hold'em.
   */
  protected dealHoleCardsImpl(): void {
    const startSeat = this.getNextOccupiedSeat(this.dealerButtonSeat + 1);
    if (startSeat === -1) return;

    const cardCount = this.getHoleCardCount();

    // Deal cardCount rounds, one card at a time, clockwise from left of button
    for (let round = 0; round < cardCount; round++) {
      let seat = startSeat;
      do {
        if (
          this.seats[seat].state === 'occupied' &&
          !this.seats[seat].eliminated &&
          this.seats[seat].chipCount >= 0
        ) {
          const card = this.deck.dealOne();
          if (card) {
            this.seats[seat].holeCards.push(card);
            this.emit('cardDealt', { seatIndex: seat, round });
          }
        }
        seat = this.getNextOccupiedSeat(seat + 1);
      } while (seat !== startSeat);
    }
  }

  /**
   * Overridable: how many hole cards to deal. Default 2 for Hold'em.
   */
  protected getHoleCardCount(): number {
    return 2;
  }

  /**
   * Overridable: evaluate a player's hand from their hole cards and community cards.
   * Default uses standard evaluateHand for Hold'em.
   */
  protected evaluatePlayerHand(holeCards: Card[], communityCards: Card[]): HandResult {
    const allCards = [...holeCards, ...communityCards];
    return evaluateHand(allCards);
  }

  /**
   * Overridable: get the max raise amount for a seat.
   * Default returns Infinity (no limit). Subclasses can enforce pot-limit, etc.
   */
  protected getMaxRaise(_seatIndex: number): number {
    return Infinity;
  }

  /**
   * Overridable: get the next game phase after the current one.
   * Default follows Hold'em progression.
   */
  protected getNextPhase(): GamePhase | null {
    switch (this.currentPhase) {
      case GamePhase.PreFlop: return GamePhase.Flop;
      case GamePhase.Flop: return GamePhase.Turn;
      case GamePhase.Turn: return GamePhase.River;
      case GamePhase.River: return GamePhase.Showdown;
      default: return null;
    }
  }

  /**
   * Overridable: reset the deck. Default creates a standard 52-card deck.
   * Subclasses (e.g., ShortDeck) can override to use a different deck.
   */
  protected resetDeck(): void {
    this.deck.reset();
    const commitment = this.deck.shuffle(this.handNumber);
    // Commit hash to all players — seed revealed after hand
    this.emit('deckCommitment', { hash: commitment.hash, handNumber: commitment.handNumber });
  }

  /**
   * Overridable: deal community cards for a phase.
   * Default deals standard community cards. Subclasses can override (e.g., no community in draw/stud).
   */
  protected dealCommunityCardsForPhase(phase: GamePhase): void {
    switch (phase) {
      case GamePhase.Flop:
        this.dealCommunityCards(3);
        break;
      case GamePhase.Turn:
      case GamePhase.River:
        this.dealCommunityCards(1);
        break;
    }
  }

  /**
   * Overridable: whether this variant uses community cards.
   * Default true for Hold'em.
   */
  protected usesCommunityCards(): boolean {
    return true;
  }

  protected dealCommunityCards(count: number): void {
    // Burn one card first
    this.deck.dealOne();

    for (let i = 0; i < count; i++) {
      const card = this.deck.dealOne();
      if (card) {
        this.communityCards.push(card);
        this.emit('communityCard', { card, total: this.communityCards.length });
      }
    }
  }

  protected setFirstActivePlayer(): void {
    const activePlayers = this.getActivePlayerSeats();
    const isHeadsUp = activePlayers.length === 2;

    if (this.currentPhase === GamePhase.PreFlop) {
      if (isHeadsUp) {
        // Heads-up: dealer (SB) acts first pre-flop
        this.activeSeatIndex = this.dealerButtonSeat;
      } else {
        // UTG: next after BB
        const sbSeat = this.getNextOccupiedSeat(this.dealerButtonSeat + 1);
        const bbSeat = this.getNextOccupiedSeat(sbSeat + 1);
        this.activeSeatIndex = this.getNextPlayingSeat(bbSeat + 1);
      }
    } else {
      // Post-flop: first active player after dealer
      this.activeSeatIndex = this.getNextPlayingSeat(this.dealerButtonSeat + 1);
    }

    if (this.activeSeatIndex !== -1) {
      this.emit('turnChanged', { seatIndex: this.activeSeatIndex });
    }
  }

  // ========== Player Actions ==========

  playerFold(seatIndex: number): boolean {
    if (!this.isValidAction(seatIndex)) return false;

    this.seats[seatIndex].folded = true;
    this.seats[seatIndex].lastAction = PlayerAction.Fold;
    this.seats[seatIndex].hasActedSinceLastFullRaise = true;

    this.actionLog.push({
      seatIndex,
      playerName: this.seats[seatIndex].playerName,
      action: 'folded',
    });

    this.emit('playerAction', {
      seatIndex,
      action: PlayerAction.Fold,
      amount: 0,
    });

    this.advanceTurn();
    return true;
  }

  playerCheck(seatIndex: number): boolean {
    if (!this.isValidAction(seatIndex)) return false;

    const seat = this.seats[seatIndex];
    if (seat.currentBet < this.currentBetToMatch) {
      // TDA Rule 7: BB has the "option" to check or raise preflop when no raise has occurred
      if (
        !(
          this.currentPhase === GamePhase.PreFlop &&
          seat.currentBet === this.config.bigBlind &&
          this.currentBetToMatch === this.config.bigBlind
        )
      ) {
        return false;
      }
    }

    seat.lastAction = PlayerAction.Check;
    seat.hasActedSinceLastFullRaise = true;

    this.actionLog.push({
      seatIndex,
      playerName: seat.playerName,
      action: 'checked',
    });

    this.emit('playerAction', {
      seatIndex,
      action: PlayerAction.Check,
      amount: 0,
    });

    this.advanceTurn();
    return true;
  }

  playerCall(seatIndex: number): boolean {
    if (!this.isValidAction(seatIndex)) return false;

    const seat = this.seats[seatIndex];
    const callAmount = this.getCallAmount(seat);

    if (callAmount <= 0) return false;

    if (callAmount >= seat.chipCount) {
      // Calling all-in
      return this.playerAllIn(seatIndex);
    }

    seat.chipCount -= callAmount;
    seat.currentBet += callAmount;
    seat.totalInvestedThisHand += callAmount;
    seat.lastAction = PlayerAction.Call;
    seat.hasActedSinceLastFullRaise = true;

    this.actionLog.push({
      seatIndex,
      playerName: seat.playerName,
      action: `called ${callAmount}`,
    });

    this.emit('playerAction', {
      seatIndex,
      action: PlayerAction.Call,
      amount: callAmount,
    });

    this.advanceTurn();
    return true;
  }

  /**
   * TDA Rule 40-41: Raise must be at least the size of the last raise.
   * TDA Rule 2F: Opening bet must be at least one big blind.
   * Check-raise is permitted (no code prevents it).
   * String betting is not applicable in online play (actions are atomic).
   */
  playerRaise(seatIndex: number, totalRaiseAmount: number): boolean {
    if (!this.isValidAction(seatIndex)) return false;

    const seat = this.seats[seatIndex];
    const minRaise = this.getMinRaise();

    // TDA: Opening bet must be at least one big blind
    if (this.currentBetToMatch === 0 && totalRaiseAmount < this.config.bigBlind) {
      if (totalRaiseAmount >= seat.chipCount + seat.currentBet) {
        return this.playerAllIn(seatIndex);
      }
      return false;
    }

    // totalRaiseAmount is the total bet the player wants to have in front of them
    if (totalRaiseAmount < minRaise) {
      // If they can't meet min raise but are going all in, treat as all-in
      if (totalRaiseAmount >= seat.chipCount + seat.currentBet) {
        return this.playerAllIn(seatIndex);
      }
      return false;
    }

    // Enforce max raise (pot-limit, fixed-limit, etc.)
    const maxRaise = this.getMaxRaise(seatIndex);
    if (maxRaise !== Infinity && totalRaiseAmount > maxRaise) {
      totalRaiseAmount = maxRaise;
    }

    const additionalChips = totalRaiseAmount - seat.currentBet;

    if (additionalChips >= seat.chipCount) {
      return this.playerAllIn(seatIndex);
    }

    if (additionalChips <= 0) return false;

    // Track if this is a full raise (for re-raise eligibility)
    const raiseSize = totalRaiseAmount - this.currentBetToMatch;
    if (raiseSize >= this.lastRaiseAmount) {
      // Full raise - reset action flags
      this.lastRaiseAmount = raiseSize;
      for (const s of this.seats) {
        if (
          s.state === 'occupied' &&
          !s.folded &&
          !s.allIn &&
          s.seatIndex !== seatIndex
        ) {
          s.hasActedSinceLastFullRaise = false;
        }
      }
    }

    seat.chipCount -= additionalChips;
    seat.currentBet = totalRaiseAmount;
    seat.totalInvestedThisHand += additionalChips;
    seat.lastAction = PlayerAction.Raise;
    seat.hasActedSinceLastFullRaise = true;
    this.currentBetToMatch = totalRaiseAmount;

    // TDA Rule 16: Track last aggressor for showdown order
    this.lastAggressorSeat = seatIndex;

    this.actionLog.push({
      seatIndex,
      playerName: seat.playerName,
      action: `raised to ${totalRaiseAmount}`,
    });

    this.emit('playerAction', {
      seatIndex,
      action: PlayerAction.Raise,
      amount: totalRaiseAmount,
    });

    this.advanceTurn();
    return true;
  }

  /**
   * TDA Rule 41: An all-in that is less than a full raise does NOT
   * reopen betting action for players who have already acted.
   * Only a full raise (raiseSize >= lastRaiseAmount) resets action flags.
   */
  playerAllIn(seatIndex: number): boolean {
    if (!this.isValidAction(seatIndex)) return false;

    const seat = this.seats[seatIndex];
    const allInAmount = seat.chipCount;
    const totalBet = seat.currentBet + allInAmount;

    // Check if this constitutes a raise
    if (totalBet > this.currentBetToMatch) {
      const raiseSize = totalBet - this.currentBetToMatch;
      // TDA Rule 41: Only reset action flags if this is a FULL raise
      if (raiseSize >= this.lastRaiseAmount) {
        this.lastRaiseAmount = raiseSize;
        for (const s of this.seats) {
          if (
            s.state === 'occupied' &&
            !s.folded &&
            !s.allIn &&
            s.seatIndex !== seatIndex
          ) {
            s.hasActedSinceLastFullRaise = false;
          }
        }
      }
      this.currentBetToMatch = totalBet;
    }

    seat.totalInvestedThisHand += allInAmount;
    seat.currentBet += allInAmount;
    seat.chipCount = 0;
    seat.allIn = true;
    seat.lastAction = PlayerAction.AllIn;
    seat.hasActedSinceLastFullRaise = true;

    // TDA Rule 16: If this all-in is a raise, track as last aggressor
    if (totalBet > this.currentBetToMatch) {
      this.lastAggressorSeat = seatIndex;
    }

    this.actionLog.push({
      seatIndex,
      playerName: seat.playerName,
      action: `went all-in for ${totalBet}`,
    });

    this.emit('playerAction', {
      seatIndex,
      action: PlayerAction.AllIn,
      amount: totalBet,
    });

    this.advanceTurn();
    return true;
  }

  // ========== Turn Management ==========

  protected advanceTurn(): void {
    // Check if only one player left (everyone else folded)
    const playingSeats = this.seats.filter(
      s =>
        s.state === 'occupied' &&
        !s.folded &&
        !s.eliminated
    );

    if (playingSeats.length <= 1) {
      // Last player standing wins
      this.accumulateInvestments();
      this.determineWinners();
      return;
    }

    // Check if betting round is complete
    if (this.isBettingRoundComplete()) {
      this.accumulateInvestments();
      this.advanceToNextStreet();
      return;
    }

    // Find next active player
    const nextSeat = this.getNextActiveSeat(this.activeSeatIndex + 1);
    if (nextSeat === -1) {
      // No more active players - advance
      this.accumulateInvestments();
      this.advanceToNextStreet();
      return;
    }

    this.activeSeatIndex = nextSeat;
    this.emit('turnChanged', { seatIndex: this.activeSeatIndex });
  }

  protected isBettingRoundComplete(): boolean {
    const playingSeats = this.seats.filter(
      s =>
        s.state === 'occupied' &&
        !s.folded &&
        !s.allIn &&
        !s.eliminated
    );

    // If no one can act (all folded or all-in), betting is complete
    if (playingSeats.length === 0) return true;

    // If only one player can act and they've matched, round is complete
    if (playingSeats.length === 1) {
      const seat = playingSeats[0];
      // If no one has bet, and this player hasn't acted, they should get a chance
      if (!seat.hasActedSinceLastFullRaise && this.currentBetToMatch === 0) {
        return false;
      }
      if (seat.currentBet >= this.currentBetToMatch && seat.hasActedSinceLastFullRaise) {
        return true;
      }
    }

    // All playing seats must have: matched the current bet AND acted since last full raise
    for (const seat of playingSeats) {
      if (seat.currentBet < this.currentBetToMatch) return false;
      if (!seat.hasActedSinceLastFullRaise) return false;
    }

    return true;
  }

  protected advanceToNextStreet(): void {
    // Check if we need to run out the board (only 0 or 1 non-all-in, non-folded players)
    const activePlayers = this.seats.filter(
      s =>
        s.state === 'occupied' &&
        !s.folded &&
        !s.allIn &&
        !s.eliminated
    );

    const allInPlayers = this.seats.filter(
      s =>
        s.state === 'occupied' &&
        !s.folded &&
        s.allIn &&
        !s.eliminated
    );

    const totalContesting = activePlayers.length + allInPlayers.length;

    // Use getNextPhase() to determine next street (overridable by variants)
    const nextPhase = this.getNextPhase();

    if (nextPhase === null || nextPhase === GamePhase.Showdown) {
      this.currentPhase = GamePhase.Showdown;
      this.determineWinners();
      return;
    }

    if (totalContesting <= 1) {
      // Only one player left contesting - they win without showdown
      // But if there are all-in players, we need to run out the board
      if (allInPlayers.length > 0 || (activePlayers.length === 0 && allInPlayers.length === 0)) {
        // Check if there are at least 2 players total (including all-in) to contest
        const contestingPlayers = this.seats.filter(
          s => s.state === 'occupied' && !s.folded && !s.eliminated
        );
        if (contestingPlayers.length >= 2) {
          this.runOutBoard();
          return;
        }
      }
      this.determineWinners();
      return;
    }

    // Check if we should run out board (all remaining are all-in, or only 1 active + all-ins)
    if (activePlayers.length <= 1 && allInPlayers.length >= 1 && totalContesting >= 2) {
      this.runOutBoard();
      return;
    }

    // Advance to the next phase
    this.currentPhase = nextPhase;
    this.resetBettingRound();
    this.dealCommunityCardsForPhase(nextPhase);

    this.emit('phaseChanged', { phase: this.currentPhase });

    // Set first active player for new street
    this.setFirstActivePlayer();

    // Check if only one active player after reset (everyone else all-in)
    if (this.isBettingRoundComplete()) {
      this.accumulateInvestments();
      this.advanceToNextStreet();
    }
  }

  protected resetBettingRound(): void {
    this.currentBetToMatch = 0;
    this.lastRaiseAmount = this.config.bigBlind;

    for (const seat of this.seats) {
      if (seat.state === 'occupied') {
        seat.currentBet = 0;
        seat.lastAction = PlayerAction.None;
        seat.hasActedSinceLastFullRaise = false;
      }
    }
  }

  protected runOutBoard(): void {
    // Deal remaining community cards without betting
    while (this.communityCards.length < 5) {
      switch (this.communityCards.length) {
        case 0:
          this.currentPhase = GamePhase.Flop;
          this.dealCommunityCards(3);
          break;
        case 3:
          this.currentPhase = GamePhase.Turn;
          this.dealCommunityCards(1);
          break;
        case 4:
          this.currentPhase = GamePhase.River;
          this.dealCommunityCards(1);
          break;
        default:
          // Shouldn't happen, but deal remaining
          this.dealCommunityCards(5 - this.communityCards.length);
          break;
      }
      this.emit('phaseChanged', { phase: this.currentPhase });
    }

    this.currentPhase = GamePhase.Showdown;
    this.emit('phaseChanged', { phase: this.currentPhase });
    this.determineWinners();
  }

  accumulateInvestments(): void {
    // Reset currentBet to 0 for all seats
    // totalInvestedThisHand is already accumulated when bets are made
    // Pots are calculated from totalInvestedThisHand
    for (const seat of this.seats) {
      if (seat.state === 'occupied') {
        seat.currentBet = 0;
      }
    }
  }

  protected determineWinners(): void {
    this.currentPhase = GamePhase.Showdown;

    const seatInfos: SeatInfo[] = this.seats
      .filter(s => s.state === 'occupied' && !s.eliminated)
      .map(s => ({
        seatIndex: s.seatIndex,
        chipCount: s.chipCount,
        totalInvestedThisHand: s.totalInvestedThisHand,
        folded: s.folded,
        allIn: s.allIn,
        holeCards: s.holeCards,
        state: s.state,
      }));

    // Check if only one player remains (everyone else folded)
    const nonFolded = seatInfos.filter(s => !s.folded);

    const results: HandWinResult[] = [];

    // Collect showdown hand info for all non-folded players
    const showdownHands: ShowdownHandInfo[] = [];
    const winnerInfos: WinnerInfo[] = [];

    if (nonFolded.length === 1) {
      // Last player standing wins everything
      const totalPot = seatInfos.reduce((sum, s) => sum + s.totalInvestedThisHand, 0);
      const winner = nonFolded[0];
      this.seats[winner.seatIndex].chipCount += totalPot;

      const winnerSeat = this.seats[winner.seatIndex];
      results.push({
        seatIndex: winner.seatIndex,
        playerName: winnerSeat.playerName,
        amount: totalPot,
        potName: 'Main Pot',
      });

      // No showdown display needed (won by fold), but record winner info
      winnerInfos.push({
        seatIndex: winner.seatIndex,
        playerName: winnerSeat.playerName,
        chipsWon: totalPot,
        handName: 'Won by fold',
        bestFiveCards: [],
      });
    } else {
      // Evaluate all non-folded hands for showdown display
      for (const info of nonFolded) {
        const seat = this.seats[info.seatIndex];
        const allCards = [...seat.holeCards, ...this.communityCards];
        if (allCards.length >= 5 || (!this.usesCommunityCards() && seat.holeCards.length >= 5)) {
          const handRes = this.evaluatePlayerHand(seat.holeCards, this.communityCards);
          showdownHands.push({
            seatIndex: info.seatIndex,
            playerName: seat.playerName,
            handName: handRes.handName,
            bestFiveCards: handRes.bestFiveCards,
            holeCards: [...seat.holeCards],
          });
        }
      }

      // TDA Rule 16: Determine showdown order
      // Last aggressor shows first; if no aggression on final street, first left of dealer
      if (this.lastAggressorSeat >= 0) {
        const aggressorIdx = showdownHands.findIndex(
          h => h.seatIndex === this.lastAggressorSeat
        );
        if (aggressorIdx > 0) {
          const [aggressor] = showdownHands.splice(aggressorIdx, 1);
          showdownHands.unshift(aggressor);
        }
      } else {
        // Sort clockwise from first active seat left of dealer
        showdownHands.sort((a, b) => {
          const distA = (a.seatIndex - this.dealerButtonSeat + MAX_SEATS) % MAX_SEATS;
          const distB = (b.seatIndex - this.dealerButtonSeat + MAX_SEATS) % MAX_SEATS;
          return distA - distB;
        });
      }

      // Award pots using side pot manager, passing variant evaluator
      const evaluator = (hole: Card[], community: Card[]): HandResult => {
        return this.evaluatePlayerHand(hole, community);
      };
      const winnings = this.sidePotManager.awardPots(
        seatInfos,
        this.communityCards,
        this.dealerButtonSeat,
        evaluator
      );

      for (const [seatIdx, amount] of winnings) {
        this.seats[seatIdx].chipCount += amount;

        const handResult = this.evaluatePlayerHand(
          this.seats[seatIdx].holeCards,
          this.communityCards
        );

        results.push({
          seatIndex: seatIdx,
          playerName: this.seats[seatIdx].playerName,
          amount,
          handResult,
          potName: 'Pot',
        });

        // Build winner info (aggregate chips won per seat)
        const existing = winnerInfos.find(w => w.seatIndex === seatIdx);
        if (existing) {
          existing.chipsWon += amount;
        } else {
          winnerInfos.push({
            seatIndex: seatIdx,
            playerName: this.seats[seatIdx].playerName,
            chipsWon: amount,
            handName: handResult?.handName || 'Unknown',
            bestFiveCards: handResult?.bestFiveCards || [],
          });
        }
      }
    }

    // Calculate pot breakdown for hand history
    const pots = this.sidePotManager.calculatePots(seatInfos);
    const potBreakdown = pots.map(p => ({
      amount: p.amount,
      winners: winnerInfos
        .filter(w => p.eligibleSeatIndices.includes(w.seatIndex))
        .map(w => w.seatIndex),
    }));
    // If no pots calculated (single winner by fold), create a synthetic one
    if (potBreakdown.length === 0 && winnerInfos.length > 0) {
      const totalPot = seatInfos.reduce((sum, s) => sum + s.totalInvestedThisHand, 0);
      potBreakdown.push({
        amount: totalPot,
        winners: winnerInfos.map(w => w.seatIndex),
      });
    }

    // Store lastHandResult for game state broadcast
    this.lastHandResult = {
      handNumber: this.handNumber,
      winners: winnerInfos,
      showdownHands,
      communityCards: [...this.communityCards],
      pots: potBreakdown,
    };

    // Build hand history record
    const handHistory: HandHistoryRecord = {
      handNumber: this.handNumber,
      communityCards: [...this.communityCards],
      players: this.seats
        .filter(s => s.state === 'occupied' && !s.eliminated)
        .map(s => {
          const allCards = [...s.holeCards, ...this.communityCards];
          const handRes = (allCards.length >= 5 || (!this.usesCommunityCards() && s.holeCards.length >= 5)) && !s.folded
            ? this.evaluatePlayerHand(s.holeCards, this.communityCards) : null;
          return {
            seatIndex: s.seatIndex,
            name: s.playerName,
            holeCards: s.folded ? null : (s.holeCards.length > 0 ? [...s.holeCards] : null),
            startChips: this.startChips.get(s.seatIndex) || 0,
            endChips: s.chipCount,
            actions: this.actionLog
              .filter(a => a.seatIndex === s.seatIndex)
              .map(a => a.action),
            folded: s.folded,
            handName: handRes?.handName || null,
          };
        }),
      winners: winnerInfos.map(w => ({
        seatIndex: w.seatIndex,
        name: w.playerName,
        chipsWon: w.chipsWon,
        handName: w.handName,
      })),
      pots: potBreakdown,
    };

    // Reset totalInvestedThisHand
    for (const seat of this.seats) {
      seat.totalInvestedThisHand = 0;
    }

    this.currentPhase = GamePhase.HandComplete;
    this.activeSeatIndex = -1;

    this.emit('handResult', { results, handNumber: this.handNumber });
    this.emit('handHistory', handHistory);
    // Reveal seed so players can verify the shuffle was fair
    const commitment = this.deck.revealSeed();
    if (commitment) {
      this.emit('deckSeedRevealed', { seed: commitment.seed, hash: commitment.hash, handNumber: commitment.handNumber });
    }
    this.emit('phaseChanged', { phase: this.currentPhase });
  }

  // ========== Utility Methods ==========

  protected isValidAction(seatIndex: number): boolean {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return false;
    if (this.activeSeatIndex !== seatIndex) return false;
    if (this.currentPhase === GamePhase.WaitingForPlayers) return false;
    if (this.currentPhase === GamePhase.HandComplete) return false;
    if (this.currentPhase === GamePhase.Showdown) return false;

    const seat = this.seats[seatIndex];
    if (seat.state !== 'occupied') return false;
    if (seat.folded || seat.allIn || seat.eliminated) return false;

    return true;
  }

  getCallAmount(seat: Seat): number {
    const amount = this.currentBetToMatch - seat.currentBet;
    return Math.max(0, amount);
  }

  /**
   * TDA Rule 40: Minimum raise must equal the last raise size.
   * The minimum total bet = current bet to match + last raise amount.
   * TDA Rule 41: An all-in less than a full raise does NOT reopen
   * action (handled in playerAllIn by checking raiseSize >= lastRaiseAmount).
   */
  getMinRaise(): number {
    return this.currentBetToMatch + this.lastRaiseAmount;
  }

  getTotalPot(): number {
    let total = 0;
    for (const seat of this.seats) {
      if (seat.state === 'occupied') {
        // totalInvestedThisHand is updated in real-time with every bet/call/raise,
        // so it already includes the current round's bets — don't add currentBet again
        total += seat.totalInvestedThisHand;
      }
    }
    return total;
  }

  getCurrentPots(): Pot[] {
    const seatInfos: SeatInfo[] = this.seats
      .filter(s => s.state === 'occupied' && !s.eliminated)
      .map(s => ({
        seatIndex: s.seatIndex,
        chipCount: s.chipCount,
        // totalInvestedThisHand already includes current-round bets (updated in real-time)
        totalInvestedThisHand: s.totalInvestedThisHand,
        folded: s.folded,
        allIn: s.allIn,
        holeCards: s.holeCards,
        state: s.state,
      }));

    return this.sidePotManager.calculatePots(seatInfos);
  }

  getNextOccupiedSeat(from: number): number {
    for (let i = 0; i < MAX_SEATS; i++) {
      const idx = (from + i) % MAX_SEATS;
      const seat = this.seats[idx];
      if (seat.state === 'occupied' && !seat.eliminated && seat.chipCount >= 0) {
        return idx;
      }
    }
    return -1;
  }

  getNextPlayingSeat(from: number): number {
    for (let i = 0; i < MAX_SEATS; i++) {
      const idx = (from + i) % MAX_SEATS;
      const seat = this.seats[idx];
      if (
        seat.state === 'occupied' &&
        !seat.folded &&
        !seat.eliminated
      ) {
        return idx;
      }
    }
    return -1;
  }

  getNextActiveSeat(from: number): number {
    for (let i = 0; i < MAX_SEATS; i++) {
      const idx = (from + i) % MAX_SEATS;
      const seat = this.seats[idx];
      if (
        seat.state === 'occupied' &&
        !seat.folded &&
        !seat.allIn &&
        !seat.eliminated
      ) {
        return idx;
      }
    }
    return -1;
  }

  getActivePlayerSeats(): number[] {
    return this.seats
      .filter(s => s.state === 'occupied' && !s.eliminated && s.chipCount >= 0)
      .map(s => s.seatIndex);
  }

  getOccupiedSeatCount(): number {
    return this.seats.filter(s => s.state === 'occupied').length;
  }

  isHandInProgress(): boolean {
    return (
      this.currentPhase !== GamePhase.WaitingForPlayers &&
      this.currentPhase !== GamePhase.HandComplete
    );
  }
}
