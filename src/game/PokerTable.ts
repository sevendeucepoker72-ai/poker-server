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
  // 2026-06-19 Phase 5: the street the action occurred on (GamePhase value
  // e.g. 'PreFlop'/'Flop'/...). Lets the client opponent-tracker compute
  // street-aware stats (3-bet%, fold-to-cbet%) from the shipped actionLog.
  street?: string;
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
  // 2026-06-19 Phase 5: full street-tagged action sequence (chronological)
  // for client-side opponent-stat tracking (3-bet%, fold-to-cbet%, AF).
  actionLog?: ActionLogEntry[];
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

  /**
   * Monotonic decision-point version (2026-07-05). Bumped by the emit()
   * override below on exactly the three events that redefine what the active
   * player is being asked to decide: 'turnChanged' (whose turn / what they
   * face), 'phaseChanged' (street), and 'handStarted' (new hand). The client
   * echoes the stateVersion it acted on; the server rejects an action whose
   * echoed version is older than the current one (a "call 100" sent against a
   * decision point that has since moved on — timeout-fold, disconnect, etc.).
   * Only-increases, so a rehydrate/restart resetting it to a lower value is
   * safe: the reject rule is `echoed < current`, so a stale-high echo just
   * fails open (accepts) rather than falsely rejecting. Persisted in the
   * snapshot so it survives a Railway restart.
   */
  public stateVersion: number = 0;

  /** TDA Rule 33 (Dead Button): track previous BB position so blinds advance
   * by exactly one occupied seat per hand even when players bust. */
  public previousBigBlindSeat: number = -1;
  /** When true, no SB is posted this hand (dead small blind). */
  public deadSmallBlind: boolean = false;
  /** When true, the button sits on an empty seat this hand (dead button). */
  public deadButton: boolean = false;

  /** Persists until next hand starts - contains showdown results for display */
  public lastHandResult: LastHandResult | null = null;

  /**
   * True only when the hand reached a genuine CONTESTED showdown (>= 2 non-folded
   * players tabled their hands). Reset each hand; set in determineWinners. Consumers
   * (getGameStateForPlayer reveal, hand-history serialize) must NOT reveal hole cards
   * for a hand won uncontested (everyone folds to one player) — that player never
   * showed and their cards must stay hidden. 2026-07-05 audit fix.
   */
  public wentToShowdown: boolean = false;

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

  /**
   * Per-table physical seat cap. Defaults to the full ring (MAX_SEATS = 9),
   * but high-hole-card variants MUST reduce it so the 52-card deck can never
   * be exhausted mid-hand: 6-card Omaha 9-handed needs 6×9 hole + 8 board/burn
   * = 62 > 52. Deck exhaustion used to spin runOutBoard() forever and freeze
   * the entire event loop (every table on the process). sitDown() enforces
   * this; getTableList() advertises it so the client renders the right count.
   * Earned 2026-07-01 .online audit.
   */
  public maxOccupiableSeats: number = MAX_SEATS;

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

  /**
   * Single choke point for stateVersion (2026-07-05). Every decision-point
   * change in the engine already flows through one of these three emits, so
   * bumping here — rather than at each of the ~5 call sites — cannot be
   * missed by a future edit and stays consistent with the single-source-of-
   * truth authority. All bumps for a given transition happen BEFORE the
   * broadcast that carries the new version to clients (the engine is
   * quiescent while waiting on the active player), so over-bumping within one
   * transition never causes a false stale-reject — only an asynchronous event
   * (timeout-fold, disconnect) can bump between broadcast and action, which is
   * exactly the case we WANT to reject.
   */
  emit(event: string | symbol, ...args: any[]): boolean {
    if (event === 'turnChanged' || event === 'phaseChanged' || event === 'handStarted') {
      this.stateVersion++;
    }
    return super.emit(event, ...args);
  }

  // ========== Seat Management ==========

  sitDown(
    seatIndex: number,
    playerName: string,
    buyIn: number,
    playerId: string,
    isAI: boolean = false,
    allowBelowMin: boolean = false
  ): boolean {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return false;
    // Deck-safety seat cap: high-hole-card variants (5/6-card Omaha) reduce
    // maxOccupiableSeats below the physical ring so the deck can't be
    // exhausted mid-hand. Reject seats beyond the cap for every join path
    // (human, AI fill, quick-play), not just the lobby-advertised count.
    if (seatIndex >= this.maxOccupiableSeats) return false;
    if (this.seats[seatIndex].state !== 'empty') return false;
    // A seat MOVE relocates an existing stack — it is not a fresh buy-in, so it
    // must NOT be blocked by minBuyIn (a player whose stack fell below the
    // minimum after losses would otherwise have their whole stack destroyed
    // when both the move and the fallback-restore sitDown fail — 2026-07-01
    // audit #5). Callers relocating a stack pass allowBelowMin=true.
    if (!allowBelowMin && buyIn < this.config.minBuyIn) return false;

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
   * Whether a seat is sitting out this hand. Exposed to subclasses (e.g.
   * SevenStudTable) that re-implement postBlinds and must apply the same
   * sit-out guard the base ante/blind loops use (_sittingOutSeats is private).
   */
  protected isSittingOut(seatIndex: number): boolean {
    return this._sittingOutSeats.has(seatIndex);
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
    // Only meaningful DURING a live hand. Between hands (HandComplete /
    // WaitingForPlayers) startNewHand() resets totalInvestedThisHand to 0, so
    // chips deducted here would leave the stack and enter no pot — destroyed.
    // Leave the debt intact (don't clearDeadBlind); it's collected
    // automatically when the next hand deals. 2026-07-01 audit #8.
    if (!this.isHandInProgress()) return { ok: false, reason: 'not_in_hand' };
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
    // 2026-10-09 — PRE-DEAL HOOK (play gate: index.ts stands up a player found
    // suspended). This is the last moment a seat can leave with NOTHING in a
    // pot — the previous hand's pots are awarded, this hand's blinds are not
    // posted yet — so a stand-up here returns the whole stack. Listeners run
    // synchronously and may stand seats up; everything below reads the seats
    // AFTER them (the start gate may then find < 2 players and return false).
    // A throwing listener must never stop the hand loop, so the emit is guarded.
    try {
      this.emit('beforeHandStart', { handNumber: this.handNumber + 1 });
    } catch (e: any) {
      console.error('[PokerTable] beforeHandStart listener threw (ignored, hand continues):', e?.message || e);
    }

    const occupiedSeats = this.seats.filter(
      s => s.state === 'occupied' && !s.eliminated && s.chipCount > 0
    );

    // 2026-06-11 audit C11/C12 (full exclusion): a SITTING-OUT player is not in
    // the hand, so they don't count toward the 2-player minimum. Without this,
    // a table with 1 active player + 1 sitting-out would start a hand in which
    // the sit-out seat is pre-folded below, leaving 1 live player — the hand
    // instantly resolves and the auto-starter loops it. Require >= 2 players
    // who are actually playing.
    const activeNonSitOut = occupiedSeats.filter(s => !this._sittingOutSeats.has(s.seatIndex));
    if (activeNonSitOut.length < 2) {
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
        // 2026-06-11 audit C11/C12 (full exclusion): a sitting-out player is
        // not in this hand — start them FOLDED so every folded-aware path
        // (turn rotation, isBettingRoundComplete, showdown) skips them. Their
        // blinds were already handled as DEAD in postBlinds (batch 5b), and the
        // start gate above guarantees >= 2 non-sit-out players, so this can't
        // produce a 1-player hand.
        seat.folded = this._sittingOutSeats.has(seat.seatIndex);
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
    this.wentToShowdown = false; // set true only on a contested showdown (>= 2 tabled)

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

    // #13 (2026-07-01 audit): if the opening actor(s) are all-in — e.g. both
    // heads-up players posted short all-in blinds, or antes busted everyone —
    // no one can act. Complete the round and run the board out to showdown
    // instead of stalling (mirrors advanceToNextStreet's post-first-actor
    // check). isBettingRoundComplete is false when at least one seat can still
    // act (e.g. HU short-SB all-in with a live BB), so this only fires when the
    // betting is genuinely closed.
    if (this.isBettingRoundComplete()) {
      this.accumulateInvestments();
      this.advanceToNextStreet();
    }

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
    // From there we derive SB (occupied seat before the new BB) and button
    // (occupied seat before the SB).
    //
    // 2026-06-11 audit C10: derive SB + button by walking OCCUPIED seats
    // backward (getPrevOccupiedSeat), NOT by raw index `(newBBSeat - 1)`.
    // The raw-index math landed on an EMPTY seat whenever seating is
    // non-contiguous (gaps from mid-table stand-ups or explicit seat picks),
    // which falsely set deadSmallBlind (no SB collected from anyone) and
    // parked the button on an empty seat — the post-button player then
    // played for free every orbit. A backward occupancy walk always lands
    // on the real player. With this, a seating GAP never produces a dead
    // blind/button (a "moving button" — the simplified, fair online
    // convention); the dead-blind flags stay false here and are reserved
    // for genuine bust handling if ever reintroduced. Contiguous seating is
    // unchanged: getPrevOccupiedSeat(newBBSeat-1) === newBBSeat-1 when that
    // seat is occupied.
    const newBBSeat = this.getNextOccupiedSeat(this.previousBigBlindSeat + 1);
    if (newBBSeat === -1) return;

    const sbSlot = this.getPrevOccupiedSeat(newBBSeat - 1 + MAX_SEATS);
    const buttonSlot = this.getPrevOccupiedSeat(sbSlot - 1 + MAX_SEATS);

    // SB/button now always reference real occupied seats; no dead blind
    // from a seating gap.
    this.deadSmallBlind = false;
    this.deadButton = false;

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
        // 2026-06-11 audit C10: backward OCCUPANCY walk, not raw `(bbSeat-1)`.
        // The raw index landed on an empty seat on non-contiguous tables and
        // then declared a dead SB, so no SB was collected — the post-button
        // player played for free. getPrevOccupiedSeat lands on the real SB.
        sbSeat = this.getPrevOccupiedSeat(bbSeat - 1 + MAX_SEATS);
        // Defensive: only a 1-handed table (no other occupied seat) yields -1.
        if (sbSeat === -1 || this.seats[sbSeat]?.state !== 'occupied') {
          sbSeat = -1;
          this.deadSmallBlind = true;
        }
      }
    }

    // 2026-06-11 audit C11/C12: a SITTING-OUT player must not post a LIVE
    // blind. markSittingOutBlinds() (run earlier in startNewHand) already
    // recorded their dead-blind DEBT for when they return; charging a live
    // blind here too would (a) drain a player who isn't in the hand and
    // (b) double-charge them (live blind + accrued debt). Treat a sit-out
    // blind position as a DEAD blind — skip the live post. currentBetToMatch
    // still ends up at the big blind below, so live players must call it.
    if (sbSeat !== -1 && this._sittingOutSeats.has(sbSeat)) {
      this.deadSmallBlind = true;
      sbSeat = -1;
    }
    if (bbSeat !== -1 && this._sittingOutSeats.has(bbSeat)) {
      bbSeat = -1;
    }

    // TDA Rule 6-9: Handle missed blinds — players returning with debt
    // auto-pay from their stack at the start of the hand (if they have
    // enough). Uses `deadBlindOwedChips` as the authoritative amount
    // (accumulates across multiple missed hands). Skip seats that are
    // themselves posting SB/BB this hand — they're paying live.
    for (const seatIdx of activePlayers) {
      const seat = this.seats[seatIdx];
      const owed = seat.deadBlindOwedChips || 0;
      // C11/C12: do NOT collect dead-blind debt from a player who is STILL
      // sitting out — their debt is paid on the first hand AFTER they return.
      // Without this, markSittingOutBlinds accrues the debt and this loop
      // immediately pays it back out, draining a sitting-out player.
      if (this._sittingOutSeats.has(seatIdx)) continue;
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
        // #8 (2026-07-01 audit): skip sitting-out seats — they're pre-folded and
        // out of the hand, so charging them the ante drains a non-participant
        // (the SB/BB/dead-blind loops all have this guard; the ante loop lacked
        // it). getActivePlayerSeats includes sit-outs (tracked separately), so
        // the explicit guard is required here.
        if (this._sittingOutSeats.has(seat)) continue;
        const anteAmount = Math.min(this.config.ante, this.seats[seat].chipCount);
        this.seats[seat].chipCount -= anteAmount;
        this.seats[seat].totalInvestedThisHand += anteAmount;
        // #4 (2026-07-01 audit): an ante that takes the player's whole stack
        // leaves them all-in — set the flag like every other deduction site
        // (SB, BB, dead-blind, postOwedBlindsNow). Without it a 0-chip seat is
        // treated as a live actor and stalls the table until the turn timer
        // force-folds it out of a pot it already anted for.
        if (this.seats[seat].chipCount === 0) this.seats[seat].allIn = true;
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
          this.seats[seat].chipCount >= 0 &&
          // C11/C12 full exclusion: don't deal to a sitting-out (pre-folded)
          // seat — they're not in the hand. (Functional exclusion is the
          // folded flag set in startNewHand; this also stops them being
          // visibly "dealt in".)
          !this.seats[seat].folded
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
    // Burn one card first — but only when the deck can still afford the burn
    // plus the cards we actually need. In near-exhausted decks (pathological
    // deep-multiway in 5/6-card Omaha) skip the burn so the last real cards
    // still reach the board instead of being wasted.
    if (this.deck.cardsRemaining() > count) {
      this.deck.dealOne();
    }

    for (let i = 0; i < count; i++) {
      const card = this.deck.dealOne();
      if (card) {
        this.communityCards.push(card);
        this.emit('communityCard', { card, total: this.communityCards.length });
      }
    }
  }

  /**
   * Rabbit hunt: reveal the community cards that WOULD have come had the hand
   * played to the river, when it ended early (everyone folded pre-river). Deals
   * the remaining streets off the committed deck order using the SAME burn rule
   * as dealCommunityCards, then rewinds the deal pointer so the deck is left
   * untouched. Returns [] for non-community games or an already-complete board.
   * MUST only be called after the hand is over — revealing mid-hand would leak
   * future board cards to players still in the pot.
   */
  computeRabbitBoard(): Card[] {
    if (!this.usesCommunityCards()) return [];
    if (this.communityCards.length >= 5) return [];

    const savedIndex = this.deck.getDealIndex();
    const board: Card[] = [];
    const dealStreet = (count: number) => {
      if (this.deck.cardsRemaining() > count) this.deck.dealOne(); // burn (same condition)
      for (let i = 0; i < count; i++) {
        const c = this.deck.dealOne();
        if (c) board.push(c);
      }
    };

    let have = this.communityCards.length;
    if (have < 3) { dealStreet(3); have = 3; } // flop
    if (have < 4) { dealStreet(1); have = 4; } // turn
    if (have < 5) { dealStreet(1); }           // river

    this.deck.setDealIndex(savedIndex); // rewind — non-mutating
    return board;
  }

  protected setFirstActivePlayer(): void {
    const activePlayers = this.getActivePlayerSeats();
    const isHeadsUp = activePlayers.length === 2;

    let first: number;
    if (this.currentPhase === GamePhase.PreFlop) {
      if (isHeadsUp) {
        // Heads-up: dealer (SB) acts first pre-flop
        first = this.dealerButtonSeat;
      } else {
        // UTG: next playing seat after the BB. 2026-06-11 audit R1: anchor
        // off previousBigBlindSeat — the seat that ACTUALLY posted the BB
        // (set by moveDealerButton) — instead of re-deriving BB by walking
        // forward from the button. On a non-contiguous / moved-button table
        // the fresh button walk could land on a different seat than the real
        // BB poster, skipping true UTG and robbing the BB of its option.
        const bbSeat = this.previousBigBlindSeat >= 0
          ? this.previousBigBlindSeat
          : this.getNextOccupiedSeat(this.getNextOccupiedSeat(this.dealerButtonSeat + 1) + 1);
        first = this.getNextPlayingSeat(bbSeat + 1);
      }
    } else {
      // Post-flop: first active player after dealer
      first = this.getNextPlayingSeat(this.dealerButtonSeat + 1);
    }

    // #13 (2026-07-01 audit): the computed opening actor may be UNABLE to act —
    // e.g. a heads-up button/SB that posted a short all-in blind, or any seat
    // that an ante busted to all-in (#4). Skip to the next seat that can
    // actually act (getNextActiveSeat excludes all-in/folded/chipless in both
    // passes) so the hand doesn't stall waiting on an all-in player until the
    // watchdog fires. Returns -1 when nobody can act (all all-in) — the callers
    // (startNewHand / advanceToNextStreet) then detect the completed round and
    // run the board out.
    if (first !== -1 && !this.canAct(this.seats[first])) {
      first = this.getNextActiveSeat(first);
    }
    this.activeSeatIndex = first;

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
      street: this.currentPhase,
    });

    this.emit('playerAction', {
      seatIndex,
      action: PlayerAction.Fold,
      amount: 0,
    });

    this.advanceTurn();
    return true;
  }

  /**
   * 2026-06-11 audit C7: mark a seat folded WITHOUT the active-seat guard
   * and WITHOUT advancing the turn. Used only when a player LEAVES the
   * table mid-hand and it is NOT their turn. We must fold them so the
   * table doesn't wedge waiting on a gone player (getNextActiveSeat skips
   * folded seats), but we must NOT advanceTurn (it isn't their turn — the
   * real actor keeps the action) and the caller must NOT tear the seat
   * down yet (their committed chips stay in the live pot until showdown;
   * see handlePlayerLeave's deferred removal + processPendingSeatRemovals).
   * If it IS their turn, callers use playerFold() instead so the turn
   * advances normally. No-ops on an empty/already-folded seat.
   */
  forceFoldSeat(seatIndex: number): boolean {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return false;
    const seat = this.seats[seatIndex];
    if (seat.state !== 'occupied' || seat.folded) return false;
    seat.folded = true;
    seat.lastAction = PlayerAction.Fold;
    seat.hasActedSinceLastFullRaise = true;
    this.actionLog.push({
      seatIndex,
      playerName: seat.playerName,
      action: 'folded (left table)',
      street: this.currentPhase,
    });
    this.emit('playerAction', { seatIndex, action: PlayerAction.Fold, amount: 0 });
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
      street: this.currentPhase,
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
      street: this.currentPhase,
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

    // 2026-06-11 audit E2 (TDA Rule 41): a player who has ALREADY acted since
    // the last FULL raise may only call or fold when a sub-minimum (short)
    // all-in puts more in front of them — that short all-in does NOT reopen the
    // betting. A full raise would have reset hasActedSinceLastFullRaise=false
    // for this seat (see below), so if it's still true while they're facing a
    // raise (currentBetToMatch > their currentBet), the action wasn't reopened
    // to them and a voluntary re-raise is illegal. (All-in is always allowed —
    // that path is playerAllIn, not here.)
    if (seat.hasActedSinceLastFullRaise && this.currentBetToMatch > seat.currentBet) {
      return false;
    }

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
      street: this.currentPhase,
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
   * UTG straddle: the first player to act preflop posts 2x the big blind as a
   * live "blind" bet. Mechanically it's a raise to 2xBB that — UNLIKE a normal
   * raise — retains the straddler's option to act again when the action returns
   * (the straddle becomes the new effective big blind, so the straddler has the
   * last say preflop). Must be the very first voluntary action of the hand
   * (no prior action, bet-to-match still the BB) so it's a genuine UTG straddle,
   * not a mid-street 2xBB open. Reuses playerRaise for all the pot / all-in /
   * turn-advance bookkeeping, then flips the option flag back on.
   */
  straddle(seatIndex: number): boolean {
    if (this.currentPhase !== GamePhase.PreFlop) return false;
    if (this.activeSeatIndex !== seatIndex) return false;
    if (this.currentBetToMatch !== this.config.bigBlind) return false;
    // Straddle must be the FIRST voluntary action of the hand (blinds are not
    // logged to actionLog, so an empty preflop log == nobody has acted yet).
    if (this.actionLog.some(a => a.street === this.currentPhase)) return false;
    const seat = this.seats[seatIndex];
    if (!seat || seat.state !== 'occupied' || seat.folded || seat.allIn) return false;
    const straddleAmount = 2 * this.config.bigBlind;
    const additional = straddleAmount - seat.currentBet;
    // Require the full straddle without going all-in (keep reopening semantics simple).
    if (additional <= 0 || additional >= seat.chipCount) return false;

    const ok = this.playerRaise(seatIndex, straddleAmount);
    if (!ok) return false;

    // The straddle's one difference from a normal raise: the straddler keeps
    // their option, so owes() re-selects them when the action comes back around.
    seat.hasActedSinceLastFullRaise = false;
    const last = this.actionLog[this.actionLog.length - 1];
    if (last && last.seatIndex === seatIndex) last.action = 'straddle';
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
    const stack = seat.chipCount;
    let allInAmount = stack;

    // Pot-limit / fixed-limit cap (2026-07-01 .online audit #9). A whole-stack
    // "all-in" that would RAISE beyond the max legal raise is not a legal bet
    // in a capped structure — the player can only put in up to the cap and
    // keeps the remainder (so they are NOT actually all-in). Previously
    // playerAllIn ignored getMaxRaise entirely, so a deep stack could shove
    // 50,000 into a 200 pot-limit pot, setting an illegal currentBetToMatch
    // that opponents had to match or fold to. No-limit getMaxRaise is Infinity
    // so this is a no-op there. Only caps a RAISE (stack exceeds the call).
    const callAmount = Math.max(0, this.currentBetToMatch - seat.currentBet);
    if (stack > callAmount) {
      const maxRaiseTotal = this.getMaxRaise(seatIndex);
      if (maxRaiseTotal !== Infinity) {
        // Never cap below the call — a player must always be able to call all-in.
        const maxAdditional = Math.max(callAmount, maxRaiseTotal - seat.currentBet);
        if (allInAmount > maxAdditional) allInAmount = maxAdditional;
      }
    }
    const trulyAllIn = allInAmount >= stack;
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
    seat.chipCount = stack - allInAmount;
    // In a capped structure the bet may have been clamped below the full stack;
    // the player keeps the remainder and is a normal (non-all-in) actor.
    seat.allIn = trulyAllIn;
    seat.lastAction = trulyAllIn ? PlayerAction.AllIn : PlayerAction.Raise;
    seat.hasActedSinceLastFullRaise = true;

    this.actionLog.push({
      seatIndex,
      playerName: seat.playerName,
      action: trulyAllIn ? `went all-in for ${totalBet}` : `raised to ${totalBet} (pot-limit cap)`,
      street: this.currentPhase,
    });

    this.emit('playerAction', {
      seatIndex,
      action: trulyAllIn ? PlayerAction.AllIn : PlayerAction.Raise,
      amount: totalBet,
    });

    this.advanceTurn();
    return true;
  }

  // ========== Turn Management ==========
  //
  // 2026-07-05 SINGLE SOURCE OF TRUTH. Every "who acts next / is the betting round
  // done / who's still in the hand" question resolves through the getters below —
  // playersInHand / actingPlayers / owes / nextActor / roundSettled. Previously these
  // were re-derived with ~6 subtly-different inline filters across advanceTurn,
  // isBettingRoundComplete, advanceToNextStreet, setFirstActivePlayer, getNextActiveSeat;
  // every historical stall was two of those disagreeing. Now they cannot disagree:
  // nextActor() and roundSettled() are both defined in terms of owes()/actingPlayers(),
  // so a stall is definable and impossible — it's just "nextActor==-1 but we didn't advance."

  /** Seats still contesting the pot this hand: dealt in, not folded, not eliminated. INCLUDES all-in. */
  protected playersInHand(): Seat[] {
    return this.seats.filter(
      s => s.state === 'occupied' && !s.folded && !s.eliminated && s.holeCards.length > 0
    );
  }

  /** Seats that can still make a betting DECISION: in the hand, not all-in, with chips + cards. */
  protected actingPlayers(): Seat[] {
    return this.seats.filter(
      s =>
        s.state === 'occupied' &&
        !s.folded &&
        !s.eliminated &&
        !s.allIn &&
        s.chipCount > 0 &&
        s.holeCards.length > 0
    );
  }

  /** Can this seat legally be handed the action right now? (The actingPlayers predicate for one seat.) */
  protected canAct(s: Seat | undefined): boolean {
    return (
      !!s &&
      s.state === 'occupied' &&
      !s.folded &&
      !s.eliminated &&
      !s.allIn &&
      s.chipCount > 0 &&
      s.holeCards.length > 0
    );
  }

  /**
   * Does the seat still OWE a decision this betting round? True if it can act AND either it
   * hasn't matched the current bet, OR it hasn't acted since the last full raise (the latter
   * gives the big blind its option and a limped-around field its check).
   */
  protected owes(seatIndex: number): boolean {
    const s = this.seats[seatIndex];
    if (!this.canAct(s)) return false;
    return s.currentBet < this.currentBetToMatch || !s.hasActedSinceLastFullRaise;
  }

  /**
   * THE next-actor authority. Walks forward from `fromExclusive`+1 and returns the first seat
   * that still owes a decision, or -1 if the round is settled. Callers pass the just-acted seat
   * (default: activeSeatIndex). To evaluate a fresh street's first actor INCLUSIVELY, callers
   * check owes(candidate) first (see advanceTurn / setFirstActivePlayer).
   */
  protected nextActor(fromExclusive: number = this.activeSeatIndex): number {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const idx = (((fromExclusive + i) % MAX_SEATS) + MAX_SEATS) % MAX_SEATS;
      if (this.owes(idx)) return idx;
    }
    return -1;
  }

  /**
   * THE round-complete authority. Settled when NO acting player owes a decision — i.e. every
   * seat that can still act has matched the bet AND acted since the last full raise. 0 acting
   * players => settled (all-in/folded). isBettingRoundComplete() is a thin alias for this.
   */
  protected roundSettled(): boolean {
    for (const s of this.actingPlayers()) {
      if (s.currentBet < this.currentBetToMatch) return false;
      if (!s.hasActedSinceLastFullRaise) return false;
    }
    return true;
  }

  /**
   * Cheap structural invariants, asserted after every transition. In tests they THROW (turning a
   * silent wedge into a minimal repro); in prod they log + emit 'invariantViolation' (never throw
   * into live gameplay). Because nextActor()/roundSettled() derive from the same owes()/actingPlayers(),
   * a violation here means a real transition bug escaped the property tests — investigate, don't paper over.
   */
  protected assertInvariants(reason: string): void {
    const problems: string[] = [];
    const live = this.isHandInProgress() && this.currentPhase !== GamePhase.Showdown;
    if (live && !this.roundSettled()) {
      // Round is open => by construction some acting player owes => nextActor must find one.
      if (this.nextActor(this.activeSeatIndex) === -1) {
        problems.push('round open but nextActor()==-1 (wedge)');
      }
      // The seated actor must actually be able to act.
      if (this.activeSeatIndex >= 0 && !this.canAct(this.seats[this.activeSeatIndex])) {
        problems.push(`activeSeatIndex ${this.activeSeatIndex} cannot act while round is open`);
      }
    }
    // No occupied seat may be "over" the current bet-to-match.
    for (const s of this.seats) {
      if (s.state === 'occupied' && s.currentBet > this.currentBetToMatch) {
        problems.push(`seat ${s.seatIndex} currentBet ${s.currentBet} > toMatch ${this.currentBetToMatch}`);
      }
    }
    if (problems.length === 0) return;
    const msg = `[assertInvariants:${reason}] ${problems.join('; ')}`;
    if (process.env.NODE_ENV === 'test') throw new Error(msg);
    try {
      this.emit('invariantViolation', {
        reason,
        problems,
        phase: this.currentPhase,
        activeSeatIndex: this.activeSeatIndex,
        currentBetToMatch: this.currentBetToMatch,
      });
      console.error(msg);
    } catch {
      /* never let observability throw into gameplay */
    }
  }

  protected advanceTurn(): void {
    // ≤1 player left IN the hand → award immediately (last player standing, or the
    // all-folded refund path). Uses the canonical playersInHand() set (dealt-in, not
    // folded/eliminated, INCLUDING all-in) — a cardless mid-hand joiner is not in the hand.
    if (this.playersInHand().length <= 1) {
      this.accumulateInvestments();
      this.determineWinners();
      return;
    }

    // THE single next-actor decision. nextActor() returns the one seat still owing a
    // decision, or -1 when the round is settled (equivalent to roundSettled()==true, since
    // both derive from owes()/actingPlayers() — they cannot disagree). No separate
    // isBettingRoundComplete + getNextActiveSeat that can wedge by disagreeing.
    const next = this.nextActor(this.activeSeatIndex);
    if (next === -1) {
      // Betting round settled — advance the street (overridable per variant: Draw/Stud).
      this.accumulateInvestments();
      this.advanceToNextStreet();
      return;
    }

    this.activeSeatIndex = next;
    this.emit('turnChanged', { seatIndex: this.activeSeatIndex });
    this.assertInvariants('advanceTurn');
  }

  /**
   * Betting-round-complete. Now a thin alias for the single authority roundSettled() so every
   * caller (base + variants + tests) agrees on ONE definition. The old inline version had its
   * own seat filter + single-player special-case; roundSettled() subsumes both exactly (0 acting
   * => settled; 1 acting who hasn't matched-or-acted => not settled; all matched+acted => settled).
   */
  protected isBettingRoundComplete(): boolean {
    return this.roundSettled();
  }

  protected advanceToNextStreet(): void {
    // Check if we need to run out the board (only 0 or 1 non-all-in, non-folded players)
    // Canonical sets (single source of truth): actingPlayers can still bet; playersInHand still
    // contest the pot (INCLUDING all-in). They are disjoint and their union is playersInHand,
    // so totalContesting = playersInHand().length. Sourcing the runout decision from the same
    // getters as nextActor()/roundSettled() means the turn loop and the street loop can't disagree.
    const activePlayers = this.actingPlayers();
    const allInPlayers = this.playersInHand().filter(s => s.allIn);
    const totalContesting = this.playersInHand().length;

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
        if (this.playersInHand().length >= 2) {
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
      const before = this.communityCards.length;
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
      // Deck-exhaustion guard: if the deal made zero progress the deck is
      // empty. Break instead of looping forever — an empty-deck runout used
      // to hang the whole event loop. The seat caps above make this
      // unreachable in practice; this is the last-resort safety net so a
      // short board proceeds to showdown rather than freezing the server.
      if (this.communityCards.length === before) break;
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
   * 2026-06-11 gameplay-audit finding C16 — DISABLED (now a no-op).
   *
   * This whole-hand "safety net" was actively WRONG and corrupted side
   * pots. It compared the top two NON-FOLDED players by
   * totalInvestedThisHand and refunded the difference to the top player.
   * But that difference is NOT necessarily an uncalled bet: in a multiway
   * pot it can be money a SINCE-FOLDED player legitimately matched in an
   * earlier betting round (real dead money that belongs in the pot).
   * Example: A bets 200, B calls 200 then folds on a later street, C is
   * all-in 100. At showdown the non-folded set is {A:200, C:100}; the net
   * refunded 100 to A — but that 100 was matched by B and should stay in
   * the pot. Result: pot short-paid, a capped short all-in scooped a side
   * pot it was ineligible for.
   *
   * The per-round refundUncalledBetThisRound() (called at the end of every
   * betting round) is the correct mechanism: it compares currentBet WITHIN
   * a round, where a folded player's contribution still counts as matched,
   * and it covers the all-in-overbet case (top.currentBet - second.currentBet
   * returned to the non-folded top). Nothing genuine reaches showdown
   * uncalled, so this whole-hand net only ever did harm. Kept as a no-op so
   * the determineWinners() / Omaha / Stud call sites don't need touching.
   */
  protected refundUncalledBets(): void {
    /* intentionally empty — see C16 note above */
  }

  /**
   * 2026-06-11 audit G2/G3: the comparator used to RANK showdown hands when
   * awarding pots (passed into SidePotManager.awardPots). Contract matches
   * compareTo — returns POSITIVE when `a` is the better (winning) hand. The
   * base game is high-hand-wins. Lowball variants (2-7 Triple Draw, Razz,
   * Badugi) override this so the best LOW hand wins the pot. They already
   * evaluate the low hand correctly via evaluatePlayerHand(); without this
   * hook awardPots ranked those low results with the HIGH comparator and
   * awarded the pot to the WORST hand.
   */
  protected getHandComparator(): (a: HandResult, b: HandResult) => number {
    return compareTo;
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

    if (nonFolded.length === 0) {
      // Degenerate ALL-FOLD (2026-07-01 audit #1). Every seat is folded at
      // resolution — reachable when blind/ante posters leave mid-hand and are
      // force-folded (their posted chips stay in the pot), then the last live
      // seat folds (manually, or via turn-timeout / AFK / disconnect auto-fold,
      // none of which guard against the actor being the last live seat).
      // No winner exists, so REFUND each seat its own stake instead of
      // destroying the pot — the reset loop below zeroes totalInvestedThisHand,
      // which previously deleted the blinds/antes outright. Chip-conserving:
      // Σ refunded === Σ invested.
      for (const s of seatInfos) {
        if (s.totalInvestedThisHand > 0) {
          this.seats[s.seatIndex].chipCount += s.totalInvestedThisHand;
        }
      }
      // Deliberately push NOTHING to `results` / winnerInfos / showdownHands:
      // nobody WON this hand, and the handResult listener's handleHandComplete
      // treats every positive-amount `results` entry as a win (bumping handsWon,
      // streaks, biggestPot, win-XP, missions, and tournament bounties). A
      // refund is not a win — the chips were credited straight back above.
      // (2026-07-01 review fix.)
    } else if (nonFolded.length === 1) {
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
      // Contested showdown: >= 2 non-folded players table their hands. Only here
      // are hole cards legitimately revealed to the table / hand history (2026-07-05).
      this.wentToShowdown = true;
      // Evaluate all non-folded hands once and cache — reused for showdownHands,
      // awardPots evaluator, and winnerInfos to avoid triple evaluation per player.
      const handResultCache = new Map<number, HandResult>();
      for (const info of nonFolded) {
        const seat = this.seats[info.seatIndex];
        const allCards = [...seat.holeCards, ...this.communityCards];
        // 2026-06-11 audit R7: non-community variants evaluate from hole cards
        // alone; Badugi has only 4 (a complete hand), so the `>= 5` gate hid
        // its showdown cards + hand name. Use `>= 4` for non-community games
        // (Badugi 4, draw 5, stud 7 all qualify).
        if (allCards.length >= 5 || (!this.usesCommunityCards() && seat.holeCards.length >= 4)) {
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
        evaluator,
        this.getHandComparator()
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
    // mismatch between pot totals and invested amounts will throw.
    // 2026-06-19: GUARD this redundant recompute. Chips are ALREADY credited
    // above (awardPots ran its own consistency check BEFORE paying — the correct
    // fail point). If this purely-for-hand-history recompute threw, it would
    // wedge the table in Showdown with chips paid and the fairness seed never
    // revealed. Fall back to a synthetic breakdown so determineWinners always
    // finishes (emits handResult/handHistory/deckSeedRevealed → HandComplete).
    let pots: any[];
    try {
      pots = this.sidePotManager.calculatePots(seatInfos);
    } catch (e) {
      console.error('[PokerTable.determineWinners] pot-breakdown recompute threw post-payment; using synthetic breakdown:', (e as Error)?.message);
      pots = [];
    }
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
          // R7: `>= 4` for non-community games so 4-card Badugi evaluates.
          const handRes = (allCards.length >= 5 || (!this.usesCommunityCards() && s.holeCards.length >= 4)) && !s.folded
            ? this.evaluatePlayerHand(s.holeCards, this.communityCards) : null;
          return {
            seatIndex: s.seatIndex,
            name: s.playerName,
            // 2026-07-05 audit fix: never expose hole cards for a hand won
            // uncontested (no showdown) — the winner never showed. Only reveal
            // non-folded hands when the hand actually reached a contested showdown.
            holeCards: (s.folded || !this.wentToShowdown) ? null : (s.holeCards.length > 0 ? [...s.holeCards] : null),
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
      // 2026-06-19 Phase 5: ship the street-tagged action sequence so the
      // client opponent-tracker can compute real 3-bet% / fold-to-cbet% / AF.
      // Copied because this.actionLog is reset when the next hand starts.
      actionLog: this.actionLog.map(a => ({ ...a })),
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

  /**
   * 2026-06-11 audit C10: backward mirror of getNextOccupiedSeat. Walks
   * DOWN from `from` (wrapping) to the first occupied, non-eliminated seat.
   * The blind/button derivation needs this to find the SB (occupied seat
   * before the BB) and button (occupied seat before the SB) on tables with
   * GAPS between occupied seats. The old code used raw index math
   * `(bbSeat - 1 + MAX_SEATS) % MAX_SEATS`, which lands on an EMPTY seat
   * whenever seating is non-contiguous and then falsely declared a dead
   * small blind / parked the button on an empty seat — so the post-button
   * player played for free every orbit. A backward occupancy walk lands on
   * the real player.
   */
  getPrevOccupiedSeat(from: number): number {
    for (let i = 0; i < MAX_SEATS; i++) {
      const idx = (from - i + MAX_SEATS * (i + 1)) % MAX_SEATS;
      const seat = this.seats[idx];
      if (seat.state === 'occupied' && !seat.eliminated && seat.chipCount >= 0) {
        return idx;
      }
    }
    return -1;
  }

  getNextPlayingSeat(from: number): number {
    // Two-pass lookup (mirrors getNextActiveSeat). Strict first: chipCount > 0
    // AND holeCards dealt. Fallback to loose so if the deal hasn't completed
    // yet OR hole cards got cleared on an intermediate street, we still find
    // a playing seat. Without the fallback, the table wedges because
    // setFirstActivePlayer (post-flop) assigns activeSeatIndex = -1 and no
    // one can act. 2026-04-22 audit observation: oscillating active-seat
    // ring across the preflop→flop boundary, suggesting this was returning
    // -1 transiently during the phase flip.
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
    // Loose fallback — preserves pre-d91ca29 behaviour
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
    // Two-pass lookup. Pass 1 applies the *strict* filter: folded/all-in/
    // eliminated excluded AND seat must have chips AND hole cards. Pass 2
    // falls back to the *loose* filter (original behaviour: just
    // occupied+non-folded+non-all-in+non-eliminated) if the strict pass
    // yields nothing.
    //
    // Why the fallback matters: the strict filter was added 2026-04-21 to
    // skip chipless/cardless seats. But on a table where EVERY
    // qualifying seat happens to have holeCards.length === 0 at the
    // moment this runs (e.g. mid-deal, pre-deal PreFlop phase, or a
    // corrupted state where only the active seat has cards), returning
    // -1 wedges the table entirely — no turn ever advances, no timer
    // ever fires the fold-fallback, and the hand sits frozen until a
    // manual intervention. Fallback keeps the game moving at the cost
    // of occasionally assigning a seat that will auto-fold on timeout
    // (the old behaviour). Better to burn one 30s timer than freeze
    // the whole table indefinitely. Fixed 2026-04-22 after live
    // gameplay audit observed a frozen Beginner's Table.
    // Strict pass uses the canonical canAct() predicate (== the actingPlayers set) so this
    // helper can never disagree with nextActor()/roundSettled().
    for (let i = 0; i < MAX_SEATS; i++) {
      const idx = (from + i) % MAX_SEATS;
      if (this.canAct(this.seats[idx])) return idx;
    }
    // Loose fallback — returns -1 only if truly no one can act.
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

  /**
   * Snapshot enough state that a restarted server can rehydrate this
   * table in the middle of a hand. Only the CORE base-class fields are
   * captured — variant-specific subclasses (Stud, Draw) should override
   * if they have extra state.
   *
   * Emits/timers/listeners are NOT serialized — the restored table
   * recreates them from a fresh EventEmitter base on rehydrate().
   */
  serializeSnapshot(): PokerTableSnapshot {
    return {
      version: 1,
      tableId: this.config.tableId,
      variantId: this.variantId,
      handNumber: this.handNumber,
      currentPhase: this.currentPhase,
      dealerButtonSeat: this.dealerButtonSeat,
      activeSeatIndex: this.activeSeatIndex,
      currentBetToMatch: this.currentBetToMatch,
      lastRaiseAmount: this.lastRaiseAmount,
      stateVersion: this.stateVersion,
      lastAggressorSeat: this.lastAggressorSeat,
      previousBigBlindSeat: this.previousBigBlindSeat,
      deadSmallBlind: this.deadSmallBlind,
      deadButton: this.deadButton,
      communityCards: this.communityCards,
      seats: this.seats.map((s) => ({
        seatIndex: s.seatIndex,
        state: s.state,
        playerName: s.playerName,
        playerId: s.playerId,
        isAI: s.isAI,
        chipCount: s.chipCount,
        currentBet: s.currentBet,
        totalInvestedThisHand: s.totalInvestedThisHand,
        holeCards: s.holeCards,
        lastAction: s.lastAction,
        folded: s.folded,
        allIn: s.allIn,
        hasActedSinceLastFullRaise: s.hasActedSinceLastFullRaise,
        eliminated: s.eliminated,
        timeBankRemaining: s.timeBankRemaining,
        missedBlind: s.missedBlind,
        deadBlindOwedChips: s.deadBlindOwedChips,
      })),
      sittingOutSeats: Array.from(this._sittingOutSeats),
      deck: this.deck.serialize(),
      actionLog: this.actionLog,
      startChips: Array.from(this.startChips.entries()),
    };
  }

  /**
   * Restore table state from a snapshot. Applies to THIS instance —
   * call after construction so subclass fields are already set up.
   * Idempotent: running twice with the same snapshot is fine.
   */
  rehydrateFromSnapshot(snap: PokerTableSnapshot): void {
    this.handNumber = snap.handNumber;
    this.currentPhase = snap.currentPhase;
    this.dealerButtonSeat = snap.dealerButtonSeat;
    this.activeSeatIndex = snap.activeSeatIndex;
    this.currentBetToMatch = snap.currentBetToMatch;
    this.lastRaiseAmount = snap.lastRaiseAmount;
    // Restore the decision-point version if the snapshot carries it (older
    // snapshots won't — a rehydrate resetting it lower is safe; see field doc).
    // rehydrate itself will re-emit phaseChanged/turnChanged during resume,
    // so seed from the snapshot then let those bumps continue monotonically.
    if (typeof snap.stateVersion === 'number') this.stateVersion = snap.stateVersion;
    this.lastAggressorSeat = snap.lastAggressorSeat;
    this.previousBigBlindSeat = snap.previousBigBlindSeat;
    this.deadSmallBlind = snap.deadSmallBlind;
    this.deadButton = snap.deadButton;
    this.communityCards = snap.communityCards || [];
    this.actionLog = snap.actionLog || [];
    this.startChips = new Map(snap.startChips || []);
    this._sittingOutSeats = new Set(snap.sittingOutSeats || []);

    // Seats — merge rather than replace so default-initialized seats
    // (from constructor) keep any fields the snapshot omits (future-
    // compatibility if we add seat properties later).
    for (const snapSeat of snap.seats || []) {
      const i = snapSeat.seatIndex;
      if (i < 0 || i >= this.seats.length) continue;
      const seat = this.seats[i];
      Object.assign(seat, snapSeat);
    }

    // Deck: rebuild from commitment + currentIndex (deterministic re-
    // shuffle preserves the exact card order without exposing the array).
    this.deck = CardDeck.deserialize(snap.deck);
  }
}

/** Serializable snapshot of a PokerTable — only core base-class state. */
export interface PokerTableSnapshot {
  version: 1;
  tableId: string;
  variantId: string;
  handNumber: number;
  currentPhase: GamePhase;
  dealerButtonSeat: number;
  activeSeatIndex: number;
  currentBetToMatch: number;
  lastRaiseAmount: number;
  /** Decision-point version — optional for backward-compat with older snapshots. */
  stateVersion?: number;
  lastAggressorSeat: number;
  previousBigBlindSeat: number;
  deadSmallBlind: boolean;
  deadButton: boolean;
  communityCards: Card[];
  seats: Array<{
    seatIndex: number;
    state: 'empty' | 'occupied' | 'sitting_out';
    playerName: string;
    playerId: string;
    isAI: boolean;
    chipCount: number;
    currentBet: number;
    totalInvestedThisHand: number;
    holeCards: Card[];
    lastAction: PlayerAction;
    folded: boolean;
    allIn: boolean;
    hasActedSinceLastFullRaise: boolean;
    eliminated: boolean;
    timeBankRemaining: number;
    missedBlind: 'none' | 'small' | 'big' | 'both';
    deadBlindOwedChips: number;
  }>;
  sittingOutSeats: number[];
  deck: { commitment: { seed: string; hash: string; handNumber: number } | null; currentIndex: number };
  actionLog: ActionLogEntry[];
  startChips: Array<[number, number]>;
}
