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
  /**
   * TDA Rule 6-9/6-10: actual chips owed as dead-blind debt. Accumulates
   * across multiple missed hands (1 BB per skipped hand minimum). Used as
   * source of truth for the "Post Blinds to re-enter" payment. When this is
   * non-zero, `missedBlind` summarizes which categories; both clear on
   * successful post.
   */
  deadBlindOwedChips: number;
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
    deadBlindOwedChips: 0,
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

  /** TDA Rule 33 (Dead Button): track previous BB position so blinds advance
   * by exactly one occupied seat per hand even when players bust. */
  public previousBigBlindSeat: number = -1;
  /** When true, no SB is posted this hand (dead small blind). */
  public deadSmallBlind: boolean = false;
  /** When true, the button sits on an empty seat this hand (dead button). */
  public deadButton: boolean = false;

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
    // A brand-new player at this seat must not inherit any missed-blind
    // state from the previous occupant. Without this reset, a seat
    // vacated by a sitting-out player would charge the next occupant
    // dead-blind debt on their first hand.
    seat.missedBlind = 'none';
    seat.deadBlindOwedChips = 0;
    // Also drop the seat from the sitting-out set if it was still in
    // there — the new occupant is not sitting out.
    this._sittingOutSeats.delete(seatIndex);

    this.emit('playerSatDown', { seatIndex, playerName, buyIn, isAI });
    return true;
  }

  standUp(seatIndex: number): boolean {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return false;
    if (this.seats[seatIndex].state === 'empty') return false;

    const playerName = this.seats[seatIndex].playerName;
    this.seats[seatIndex] = createEmptySeat(seatIndex);
    // Defensively drop from the sitting-out set so a new occupant of
    // this index inherits a clean slate — belt-and-suspenders on top
    // of handlePlayerLeave's server-side cleanup.
    this._sittingOutSeats.delete(seatIndex);

    this.emit('playerStoodUp', { seatIndex, playerName });
    return true;
  }

  /**
   * TDA Rule 6-9: Mark a seat as having missed their blind obligation.
   * Updates the status flag (`missedBlind`) AND accumulates the chip debt
   * (`deadBlindOwedChips`) so a seat that sits out multiple rotations
   * correctly owes multiple BB+SB rather than a single BB.
   *
   * Accepts seats in any state — including `sitting_out` — because the
   * whole point is that a sitting-out player is the one who owes. Was
   * previously gated on `state === 'occupied'` which meant the function
   * could never be called on the seats that actually need marking. That
   * gating was the root cause of the dead-code bug flagged in audit #1.
   */
  markMissedBlind(seatIndex: number, blindType: 'small' | 'big'): void {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return;
    const seat = this.seats[seatIndex];
    if (seat.state === 'empty' || seat.eliminated) return;

    // Advance the flag. 'both' is terminal until cleared.
    if (seat.missedBlind === 'none') {
      seat.missedBlind = blindType;
    } else if (
      (seat.missedBlind === 'small' && blindType === 'big') ||
      (seat.missedBlind === 'big' && blindType === 'small')
    ) {
      seat.missedBlind = 'both';
    }
    // Accumulate chip debt. Small = smallBlind, Big = bigBlind.
    const delta = blindType === 'big' ? this.config.bigBlind : this.config.smallBlind;
    seat.deadBlindOwedChips = (seat.deadBlindOwedChips || 0) + delta;
  }

  /**
   * Externally-provided set of seat indices currently sitting out. Populated
   * by the socket layer (sitOutTracker) ahead of each hand because the
   * current codebase tracks sit-out status on the SESSION, not the seat.
   * Reset each hand so stale seats don't bleed forward.
   */
  private _sittingOutSeats: Set<number> = new Set();
  public setSittingOutSeats(indices: Iterable<number>): void {
    this._sittingOutSeats = new Set(indices);
  }

  /**
   * Mark seats in _sittingOutSeats that would naturally be due SB/BB this
   * hand with the appropriate missed-blind debt. Called from startNewHand
   * BEFORE postBlinds so the blind rotation can bypass them while still
   * recording their obligation.
   *
   * Strategy: compute the positions the SB and BB WOULD be if every
   * non-eliminated seat (playing or sitting out) participated in the
   * button rotation. If those positions land on a sitting-out seat,
   * mark it. This mirrors the TDA intent — blinds are a function of
   * seat rotation, not of current turn eligibility.
   */
  protected markSittingOutBlinds(): void {
    if (this._sittingOutSeats.size === 0) return;

    const allPlayable = this.seats
      .map((s, idx) => ({ s, idx }))
      .filter(({ s, idx }) =>
        (s.state === 'occupied' || this._sittingOutSeats.has(idx))
        && !s.eliminated);
    if (allPlayable.length < 2) return;

    const btn = this.dealerButtonSeat;
    if (btn < 0) return;

    const orderedFromButton: number[] = [];
    for (let offset = 1; offset <= MAX_SEATS && orderedFromButton.length < allPlayable.length; offset++) {
      const probe = (btn + offset) % MAX_SEATS;
      if (allPlayable.find((p) => p.idx === probe)) orderedFromButton.push(probe);
    }

    const isHeadsUp = allPlayable.length === 2;
    const sbSeat = isHeadsUp ? btn : orderedFromButton[0];
    const bbSeat = isHeadsUp ? orderedFromButton[0] : orderedFromButton[1];

    // Mark ONLY if that position is in our sitting-out set.
    //
    // Re-audit fix: respect TDA Rule 33 "dead small blind". When the
    // SB position falls on an empty seat from a prior-hand bust, the
    // SB is DEAD this hand — no one owes it. Previously a sitting-out
    // player whose seat coincidentally mapped to the natural SB slot
    // would accumulate a false SB debt. `this.deadSmallBlind` is set
    // by moveDealerButton() earlier in startNewHand; skip the SB mark
    // when it's true.
    if (sbSeat != null && !this.deadSmallBlind && this._sittingOutSeats.has(sbSeat)) {
      this.markMissedBlind(sbSeat, 'small');
    }
    if (bbSeat != null && this._sittingOutSeats.has(bbSeat)) {
      this.markMissedBlind(bbSeat, 'big');
    }
  }

  /**
   * Clear dead-blind debt on a seat. Called after successful posting
   * (on-demand via postOwedBlindsNow, OR automatically from the blind
   * loop in postBlinds). Idempotent.
   */
  clearDeadBlind(seatIndex: number): void {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return;
    const seat = this.seats[seatIndex];
    seat.missedBlind = 'none';
    seat.deadBlindOwedChips = 0;
  }

  /**
   * On-demand payment of owed dead blinds. Called from the
   * `postMissedBlinds` socket handler when the player taps "Post Blinds".
   *
   * Returns:
   *   { ok: true, amount } — chips deducted, debt cleared, pot incremented
   *   { ok: false, reason } — 'no_debt' | 'insufficient_chips' | 'invalid_seat'
   *
   * The deducted chips go into the pot as DEAD money: they increment
   * `totalInvestedThisHand` but NOT `currentBet`, so they don't count
   * toward the player's call obligation (TDA Rule 6-9).
   */
  postOwedBlindsNow(seatIndex: number): { ok: boolean; amount?: number; reason?: string } {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return { ok: false, reason: 'invalid_seat' };
    const seat = this.seats[seatIndex];
    if (!seat || seat.state === 'empty') return { ok: false, reason: 'invalid_seat' };
    const owed = seat.deadBlindOwedChips || 0;
    if (owed <= 0) return { ok: false, reason: 'no_debt' };
    if (seat.chipCount < owed) return { ok: false, reason: 'insufficient_chips' };

    seat.chipCount -= owed;
    seat.totalInvestedThisHand += owed;
    // No currentBet change — dead money doesn't count toward the call.
    if (seat.chipCount === 0) seat.allIn = true;
    this.clearDeadBlind(seatIndex);
    this.emit('blindPosted', { seatIndex, amount: owed, type: 'dead' });
    return { ok: true, amount: owed };
  }

  /** Quick read-only check — used by socket handlers + clients. */
  hasDeadBlindDebt(seatIndex: number): boolean {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return false;
    return (this.seats[seatIndex]?.deadBlindOwedChips || 0) > 0;
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

    // Missed-blinds refactor: BEFORE posting blinds, mark any sitting-out
    // seats whose "natural" position this hand would be SB or BB. The
    // debt accumulates against their deadBlindOwedChips so they owe the
    // proper amount when they sit back in. Seats that are active this
    // hand won't be marked here — they'll post live blinds in postBlinds.
    this.markSittingOutBlinds();

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

  /**
   * TDA Rule 33 — Dead Button Rule.
   * The big blind always advances by exactly one position per hand. The small
   * blind and button are derived from the new BB position. If the seat that
   * would be SB is empty (e.g., the previous BB busted), no SB is posted this
   * hand ("dead small blind"). If the seat that would be the button is empty,
   * the button sits on a dead seat ("dead button").
   *
   * Heads-up is a special case: dealer = SB, opponent = BB; standard rotation.
   */
  protected moveDealerButton(): void {
    // Reset dead-button flags
    this.deadSmallBlind = false;
    this.deadButton = false;

    const occupied = this.getActivePlayerSeats();
    if (occupied.length < 2) return;

    // First hand: pick first occupied seat as dealer button
    if (this.dealerButtonSeat === -1 || this.previousBigBlindSeat === -1) {
      const firstOccupied = this.getNextOccupiedSeat(0);
      if (firstOccupied === -1) return;
      this.dealerButtonSeat = firstOccupied;

      // Initial blinds: SB is next occupied after button (or button itself in HU)
      if (occupied.length === 2) {
        // Heads-up: button = SB
        const bbSeat = this.getNextOccupiedSeat(this.dealerButtonSeat + 1);
        this.previousBigBlindSeat = bbSeat;
      } else {
        const sbSeat = this.getNextOccupiedSeat(this.dealerButtonSeat + 1);
        const bbSeat = this.getNextOccupiedSeat(sbSeat + 1);
        this.previousBigBlindSeat = bbSeat;
      }
      return;
    }

    // Heads-up rotation: button alternates between the two players
    if (occupied.length === 2) {
      const otherSeat = this.getNextOccupiedSeat(this.dealerButtonSeat + 1);
      this.dealerButtonSeat = otherSeat;
      const bbSeat = this.getNextOccupiedSeat(this.dealerButtonSeat + 1);
      this.previousBigBlindSeat = bbSeat;
      return;
    }

    // Multi-way: BB always advances by one occupied seat from previous BB.
    // From there we derive SB (the seat between old BB and new BB) and button
    // (the seat before the SB). Empty intermediate seats become dead.
    const newBBSeat = this.getNextOccupiedSeat(this.previousBigBlindSeat + 1);
    if (newBBSeat === -1) return;

    // Walk seats between previousBigBlindSeat and newBBSeat
    // Slot before newBBSeat is the SB slot. If empty -> dead SB.
    const sbSlot = (newBBSeat - 1 + MAX_SEATS) % MAX_SEATS;
    const sbOccupied = this.seats[sbSlot]?.state === 'occupied';
    this.deadSmallBlind = !sbOccupied;

    // Button slot is the seat before the SB slot.
    const buttonSlot = (sbSlot - 1 + MAX_SEATS) % MAX_SEATS;
    const buttonOccupied = this.seats[buttonSlot]?.state === 'occupied';
    this.deadButton = !buttonOccupied;

    this.dealerButtonSeat = buttonSlot;
    this.previousBigBlindSeat = newBBSeat;
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
      // TDA Rule 33: Use the BB position chosen by moveDealerButton(), then
      // derive SB. If the SB seat is empty (player busted), it's a dead SB.
      bbSeat = this.previousBigBlindSeat;
      if (this.deadSmallBlind) {
        sbSeat = -1;
      } else {
        sbSeat = (bbSeat - 1 + MAX_SEATS) % MAX_SEATS;
        // Defensive: if for some reason sbSlot points to an empty seat, mark dead
        if (this.seats[sbSeat]?.state !== 'occupied') {
          sbSeat = -1;
          this.deadSmallBlind = true;
        }
      }
    }

    // TDA Rule 6-9: Handle missed blinds — players returning with debt
    // auto-pay from their stack at the start of the hand (if they have
    // enough). Uses `deadBlindOwedChips` as the authoritative amount
    // (accumulates across multiple missed hands). Skip seats that are
    // themselves posting SB/BB this hand — they're paying live.
    for (const seatIdx of activePlayers) {
      const seat = this.seats[seatIdx];
      const owed = seat.deadBlindOwedChips || 0;
      if (owed > 0 && seatIdx !== sbSeat && seatIdx !== bbSeat) {
        const postAmount = Math.min(owed, seat.chipCount);
        if (postAmount > 0) {
          seat.chipCount -= postAmount;
          seat.totalInvestedThisHand += postAmount;
          // Dead blind doesn't count toward currentBet — it's dead money
          if (seat.chipCount === 0) seat.allIn = true;
          this.emit('blindPosted', { seatIndex: seatIdx, amount: postAmount, type: 'dead' });
          this.actionLog.push({
            seatIndex: seatIdx,
            playerName: seat.playerName,
            action: `posted dead blind ${postAmount}`,
          });
          // Track remaining debt (if seat couldn't cover the full amount
          // e.g., short stack). The unpaid remainder stays on the seat
          // and will be attempted again next hand.
          seat.deadBlindOwedChips = Math.max(0, owed - postAmount);
          if (seat.deadBlindOwedChips === 0) {
            seat.missedBlind = 'none';
          }
        }
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
      // TDA Rule 16: track last aggressor BEFORE updating currentBetToMatch,
      // otherwise the guard below (totalBet > currentBetToMatch) is always false.
      this.lastAggressorSeat = seatIndex;
      this.currentBetToMatch = totalBet;
    }

    seat.totalInvestedThisHand += allInAmount;
    seat.currentBet += allInAmount;
    seat.chipCount = 0;
    seat.allIn = true;
    seat.lastAction = PlayerAction.AllIn;
    seat.hasActedSinceLastFullRaise = true;

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
    // TDA Rule 16: reset per-street so showdown order uses final-street aggressor only
    this.lastAggressorSeat = -1;

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
    // TDA Rule 41 (Uncalled Bets): refund any uncalled bet excess from THIS
    // betting round BEFORE rolling currentBet into the pot. This is the only
    // correct moment to detect uncalled bets — once the round closes, no other
    // player can call, so the excess is definitively uncalled.
    this.refundUncalledBetThisRound();

    // Reset currentBet to 0 for all seats
    // totalInvestedThisHand is already accumulated when bets are made
    // Pots are calculated from totalInvestedThisHand
    for (const seat of this.seats) {
      if (seat.state === 'occupied') {
        seat.currentBet = 0;
      }
    }
  }

  /**
   * TDA Rule 41 (Uncalled Bets): when a betting round ends, the highest
   * currentBet may exceed the next-highest currentBet from any other player.
   * That excess is "uncalled" — no other player matched it, regardless of why
   * (they folded, they were all-in capped, etc.) — and must be returned to the
   * bettor's stack instead of staying in the pot.
   *
   * Example: A all-in 50, B bets 200, C folds.
   * → top = B (200), second = A (50). Refund 150 to B.
   * → Pot keeps 50 (A's contribution) + 50 (B's matched portion) = 100.
   *
   * Per TDA: this applies even when other players folded — the uncalled bet
   * is simply the part of B's wager that no opponent matched at the table.
   */
  protected refundUncalledBetThisRound(): void {
    // Snapshot current bets per occupied seat (regardless of fold state —
    // folders' currentBet still represents what they put in this round before
    // folding).
    const bets = this.seats
      .filter(s => s.state === 'occupied' && !s.eliminated && s.currentBet > 0)
      .map(s => ({ seat: s, bet: s.currentBet }))
      .sort((a, b) => b.bet - a.bet);

    if (bets.length === 0) return;

    const top = bets[0];
    // The "matched" amount is the highest bet from any OTHER player.
    // If no other player has any currentBet, top is entirely uncalled.
    const second = bets.length >= 2 ? bets[1].bet : 0;

    if (top.bet <= second) return; // fully called, nothing to refund

    // Don't refund a folded player — if they folded, their "raise" was just
    // dead money that stays in the pot for whoever wins.
    if (top.seat.folded) return;

    const excess = top.bet - second;
    top.seat.chipCount += excess;
    top.seat.totalInvestedThisHand -= excess;
    top.seat.currentBet -= excess;

    // Emit so clients can update the action log
    this.emit('uncalledBetReturned', {
      seatIndex: top.seat.seatIndex,
      amount: excess,
    });
    this.actionLog.push({
      seatIndex: top.seat.seatIndex,
      playerName: top.seat.playerName,
      action: `uncalled bet (${excess}) returned`,
    });
  }

  /**
   * Safety net: catches any leftover excess that the per-round refund missed
   * (shouldn't happen in normal play, but protects against engine bugs).
   * Called from determineWinners() before pot calculation.
   */
  protected refundUncalledBets(): void {
    // This is now mostly a no-op because refundUncalledBetThisRound() handles
    // the real cases per round. Kept as a safety net.
    const invested = this.seats
      .filter(s => s.state === 'occupied' && !s.eliminated && s.totalInvestedThisHand > 0 && !s.folded)
      .sort((a, b) => b.totalInvestedThisHand - a.totalInvestedThisHand);

    if (invested.length < 2) return;

    const top = invested[0];
    const second = invested[1];
    const excess = top.totalInvestedThisHand - second.totalInvestedThisHand;

    if (excess > 0) {
      console.warn(`[refundUncalledBets] Late refund of ${excess} to seat ${top.seatIndex} — per-round refund should have caught this`);
      top.chipCount += excess;
      top.totalInvestedThisHand = second.totalInvestedThisHand;
    }
  }

  protected determineWinners(): void {
    this.currentPhase = GamePhase.Showdown;

    // Refund any uncalled top-stack excess BEFORE calculating pots.
    this.refundUncalledBets();

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
      // Evaluate all non-folded hands once and cache — reused for showdownHands,
      // awardPots evaluator, and winnerInfos to avoid triple evaluation per player.
      const handResultCache = new Map<number, HandResult>();
      for (const info of nonFolded) {
        const seat = this.seats[info.seatIndex];
        const allCards = [...seat.holeCards, ...this.communityCards];
        if (allCards.length >= 5 || (!this.usesCommunityCards() && seat.holeCards.length >= 5)) {
          // Defensive: `evaluatePlayerHand` CAN return null in variant
          // subclasses under edge cases (Omaha hi-lo with no qualifying
          // low, or a bugged hole-card array). A null result here used to
          // crash the whole hand with `Cannot read properties of null`
          // which took the server process down on Railway. Skip this
          // player's showdown row if we can't evaluate — everyone else
          // still gets a proper hand, and this player falls through to
          // the "Won by fold" / unknown branch in awardPots.
          const handRes = this.evaluatePlayerHand(seat.holeCards, this.communityCards);
          if (!handRes) {
            console.warn(
              `[PokerTable.determineWinners] evaluatePlayerHand returned null for seat ${info.seatIndex} (${seat.playerName}) — skipping showdown row. holeCards=${JSON.stringify(seat.holeCards)} community=${this.communityCards.length}`
            );
            continue;
          }
          handResultCache.set(info.seatIndex, handRes);
          showdownHands.push({
            seatIndex: info.seatIndex,
            playerName: seat.playerName,
            handName: handRes.handName || 'Unknown',
            bestFiveCards: handRes.bestFiveCards || [],
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

      // Award pots using side pot manager.
      // Pass a cache-backed evaluator so awardPots never re-evaluates a hand
      // that was already computed in the loop above (fixes double evaluation).
      // Issue #1 fix: build a reverse Map<holeCards ref → seatIndex> for O(1)
      // lookup instead of iterating all cache entries with reference equality.
      const holeCardsToSeatIdx = new Map<Card[], number>();
      for (const info of seatInfos) {
        holeCardsToSeatIdx.set(info.holeCards, info.seatIndex);
      }
      const evaluator = (hole: Card[], community: Card[]): HandResult => {
        const seatIdx = holeCardsToSeatIdx.get(hole);
        if (seatIdx !== undefined && handResultCache.has(seatIdx)) {
          return handResultCache.get(seatIdx)!;
        }
        // Fallback (shouldn't be reached for known seats)
        return this.evaluatePlayerHand(hole, community);
      };
      const { winnings, perPot } = this.sidePotManager.awardPots(
        seatInfos,
        this.communityCards,
        this.dealerButtonSeat,
        evaluator
      );

      // Credit chips to each winner
      for (const [seatIdx, amount] of winnings) {
        this.seats[seatIdx].chipCount += amount;
      }

      // Build results array with correct per-pot names
      for (const potWin of perPot) {
        const seatIdx = potWin.seatIndex;
        const handResult = handResultCache.get(seatIdx) ||
          this.evaluatePlayerHand(this.seats[seatIdx].holeCards, this.communityCards);

        results.push({
          seatIndex: seatIdx,
          playerName: this.seats[seatIdx].playerName,
          amount: potWin.amount,
          handResult,
          potName: potWin.potName,
        });

        // Build winner info (aggregate chips won per seat across all pots)
        const existing = winnerInfos.find(w => w.seatIndex === seatIdx);
        if (existing) {
          existing.chipsWon += potWin.amount;
        } else {
          winnerInfos.push({
            seatIndex: seatIdx,
            playerName: this.seats[seatIdx].playerName,
            chipsWon: potWin.amount,
            handName: handResult?.handName || 'Unknown',
            bestFiveCards: handResult?.bestFiveCards || [],
          });
        }
      }
    }

    // Calculate pot breakdown for hand history.
    // Note: awardPots() internally calls calculatePots() as well. This second call
    // is intentional — it provides the named pot list for the hand history record.
    // calculatePots() now includes a consistency check (Issue #3 fix) so any
    // mismatch between pot totals and invested amounts will throw here.
    const pots = this.sidePotManager.calculatePots(seatInfos);
    // Build per-pot winner amounts from perPot details (available in multi-player path)
    // For single-player (fold) path, winnerInfos already has the right data.
    const potBreakdown = pots.map(p => {
      // Find perPot entries for this pot name
      const potEntries = (nonFolded.length > 1 && (results as any[]).length > 0)
        ? results.filter(r => r.potName === p.name)
        : [];
      const winnerAmounts: { seatIndex: number; amount: number }[] = potEntries.map(r => ({
        seatIndex: r.seatIndex,
        amount: r.amount,
      }));
      return {
        name: p.name,
        amount: p.amount,
        winners: [...new Set(potEntries.map(r => r.seatIndex))],
        winnerAmounts,
      };
    });
    // If no pots calculated (single winner by fold), create a synthetic one
    if (potBreakdown.length === 0 && winnerInfos.length > 0) {
      const totalPot = seatInfos.reduce((sum, s) => sum + s.totalInvestedThisHand, 0);
      potBreakdown.push({
        name: 'Main Pot',
        amount: totalPot,
        winners: winnerInfos.map(w => w.seatIndex),
        winnerAmounts: winnerInfos.map(w => ({ seatIndex: w.seatIndex, amount: w.chipsWon })),
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

    // Only split into side pots when at least one player is actually all-in.
    // Without an all-in, unequal contributions (SB/BB) would create false "side pots".
    const hasAllIn = seatInfos.some(s => s.allIn);
    if (!hasAllIn) {
      const total = seatInfos.reduce((sum, s) => sum + s.totalInvestedThisHand, 0);
      if (total === 0) return [];
      const eligible = seatInfos.filter(s => !s.folded).map(s => s.seatIndex);
      return [{ amount: total, eligibleSeatIndices: eligible, name: 'Main Pot' }];
    }

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
        !seat.eliminated &&
        seat.chipCount > 0 &&
        seat.holeCards.length > 0
      ) {
        return idx;
      }
    }
    return -1;
  }

  getNextActiveSeat(from: number): number {
    // Skip seats that have no ability to act:
    //   - folded / all-in / eliminated (historically handled)
    //   - chipCount <= 0 (busted mid-hand, pending auto-rebuy, etc.)
    //   - no hole cards (joined mid-hand, not dealt this round)
    // A chip-less or card-less seat getting assigned as active would
    // just burn the 30s turn timer and auto-fold — frustrating and
    // pointless. Silently skip them instead.
    for (let i = 0; i < MAX_SEATS; i++) {
      const idx = (from + i) % MAX_SEATS;
      const seat = this.seats[idx];
      if (
        seat.state === 'occupied' &&
        !seat.folded &&
        !seat.allIn &&
        !seat.eliminated &&
        seat.chipCount > 0 &&
        seat.holeCards.length > 0
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
