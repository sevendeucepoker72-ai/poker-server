import { EventEmitter } from 'events';
import { Card, Rank, Suit, cardToString } from './Card';
import { CardDeck } from './CardDeck';
import { evaluateHand, compareTo, HandResult } from './HandEvaluator';
import { SidePotManager, SeatInfo, Pot, PotWinResult } from './SidePotManager';

export const MAX_SEATS = 9;

/**
 * 2026-10-11 (.online R2, GAME-9) — fixed-limit betting is capped at a bet and
 * three raises per betting round (4 bet levels; the big blind is the pre-flop
 * bet, a Stud bring-in is not a bet — its completion is). Without a cap two
 * bots with strong hands re-raised each other 122-154 times in one round.
 */
export const FIXED_LIMIT_MAX_BET_LEVELS = 4;

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

/** F22 (2026-10-21) — a draw round has no bet to lower (its bets were rolled into the pot). */
const NO_BETTING_PHASES: readonly GamePhase[] = [GamePhase.Draw1, GamePhase.Draw2, GamePhase.Draw3];

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
  /**
   * 2026-10-21 (gameplay F1/F2/F14) — the chips of totalInvestedThisHand this
   * seat posted THIS HAND as a dead blind (its missed-blind debt, collected at
   * the deal or by Post Blinds). Dead money is in the pot but is not a bet:
   * SidePotManager builds tiers and eligibility from the live part only and
   * puts the dead part in the main pot. A bomb pot gives it back AS DEBT.
   * Reset every deal.
   */
  deadMoneyThisHand: number;
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
  /** R2 — stamped on every 'handResult' entry by emitHandCompletion (the seat's player, for the chip-velocity monitor). */
  playerId?: string;
  isAI?: boolean;
  /** R2 — = amount (this pot's win). */
  chipsWon?: number;
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

/**
 * One pot of a finished hand, for the hand result and hand history.
 * 2026-10-21 (gameplay F19 / F20 / F23) — every AWARDED pot names its winners:
 * `winners` = the distinct seats that won a share of it, `winnerAmounts` = one
 * entry per seat (its summed share — a hi-lo scooper's two halves are one
 * entry). Built by PokerTable.buildPotBreakdown.
 */
export interface PotBreakdownEntry {
  name: string;
  amount: number;
  winners: number[];
  winnerAmounts: { seatIndex: number; amount: number }[];
}

/** Complete hand result for showdown display and hand history */
export interface LastHandResult {
  handNumber: number;
  winners: WinnerInfo[];
  showdownHands: ShowdownHandInfo[];
  communityCards: Card[];
  pots: { amount: number; winners: number[]; name?: string; winnerAmounts?: { seatIndex: number; amount: number }[] }[];
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
  // 2026-10-21 (gameplay G180) — the table's variantId ('holdem', 'omaha',
  // 'omaha-5', 'omaha-hi-lo', 'short-deck', 'pineapple', 'razz', 'badugi', …):
  // the replay labels a hand by the game's own rules (an Omaha replay was
  // judged by Hold'em's any-5-of-N). Additive; persisted with the record.
  variant?: string;
}

/**
 * F22 fix-up (2026-10-21) — one increase of the bet to match within a betting
 * round (a raise, a bet, an all-in over the bet) and the betting state just
 * BEFORE it. See PokerTable._betIncreases.
 */
interface BetIncreaseRecord {
  level: number;
  lastRaiseAmount: number;
  acted: Array<[number, boolean]>;
  betLevelsThisStreet: number;
  raisesThisStreet: number;
  lastAggressorSeat: number;
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
    deadMoneyThisHand: 0,
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
   * 2026-10-11 (.online R2, GAME-9) — this betting round's VOLUNTARY bets and
   * raises (an opening bet, a raise, a straddle, a Stud completion, an all-in
   * that raises; never a blind, an ante or a bring-in). Reset every street.
   * The bots read it (a 3-bet is "2 raises this street") instead of guessing
   * from each opponent's last action, which saw one raise per opponent and
   * re-raised forever.
   */
  public raisesThisStreet: number = 0;
  /**
   * GAME-9 — bet LEVELS this betting round for the fixed-limit cap
   * (FIXED_LIMIT_MAX_BET_LEVELS): the pre-flop big blind is level 1, then each
   * full bet / raise adds one (a short all-in that is not a full raise does not).
   */
  public betLevelsThisStreet: number = 0;

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

  /**
   * 2026-10-10 (Z3) — the big blind THIS hand was dealt at, captured when the
   * hand starts. `config.bigBlind` is the table's CURRENT level: a tournament
   * blind level-up rewrites it mid-hand, so anything that reasons about the
   * hand in progress (index.ts absentTournamentSeatMayLimp) reads this one.
   * 0 = no hand dealt yet (an older snapshot, a fresh table).
   */
  public handBigBlind: number = 0;

  /** TDA Rule 33 (Dead Button): track previous BB position so blinds advance
   * by exactly one occupied seat per hand even when players bust. */
  public previousBigBlindSeat: number = -1;
  /** When true, no SB is posted this hand (dead small blind). */
  public deadSmallBlind: boolean = false;
  /** When true, the button sits on an empty seat this hand (dead button). */
  public deadButton: boolean = false;
  /**
   * 2026-10-21 (gameplay F11 / F13) — the SMALL-BLIND POSITION of the last
   * deal (a seat index; the vacated seat when that blind was dead). The next
   * hand's button goes there and its small blind to the last big blind's seat
   * (TDA dead button). -1 = not known yet.
   */
  public smallBlindSeat: number = -1;
  /** F11 — who held the last deal's SB / BB positions ('' = nobody: a dead blind). null = unknown (C10 walk). */
  private _blindHolders: { sb: string; bb: string } | null = null;
  /** F13 — who sat in each seat at the last deal ('' = empty). null = unknown. */
  private _seatHoldersAtLastDeal: string[] | null = null;
  /**
   * F13 — seats taken since the last deal that sit on the button, in the small
   * blind or between them this hand (the TDA "dead zone"): dealt out of this
   * one hand (they start folded, pay no ante). Cleared every deal.
   */
  private _dealtOutSeats: Set<number> = new Set();
  /**
   * F5 fix-up (2026-10-21) — per seat, the missed-blind debt its LIVE big
   * blind settled THIS hand (postBlinds), so a bomb pot that refunds that big
   * blind restores it (restoreRefundedDeadBlind). Cleared every deal; an entry
   * counts only for its own hand and the player it was taken from.
   */
  private _debtSettledByLiveBB: Map<number, { handNumber: number; playerId: string; owed: number; flag: Seat['missedBlind'] }> = new Map();
  /**
   * F22 fix-up (2026-10-21) — the UTG straddle posted this hand (straddle()):
   * the effective big blind pre-flop, so a fold out of turn never takes it
   * away (forcedBetOfRound), as a dead big blind stays the bet to call.
   */
  private _straddleOfHand: { handNumber: number; amount: number } | null = null;
  /**
   * F22 fix-up (2026-10-21) — every INCREASE of the bet to match in this
   * betting round, with the betting state just before it (the raise size in
   * force, who had acted since the last full raise, the bet-level and raise
   * counters, the aggressor). When a leaver's unmatched bet is lowered, the
   * increases above the new level — made only by seats now out of the hand —
   * are undone exactly (lowerBetAfterOutOfTurnFold). Cleared every betting
   * round; keyed by hand + street so a stale entry is never used.
   */
  private _betIncreases: BetIncreaseRecord[] = [];
  private _betIncreasesKey = '';

  /** Persists until next hand starts - contains showdown results for display */
  public lastHandResult: LastHandResult | null = null;

  /**
   * 2026-10-21 (gameplay F92) — the finished hand's pots in pot order (main
   * first), each with the seats that could win it and the seats that did.
   * Server-side only (never sent): the tournament bust check reads it to credit
   * a knockout to the winner of the highest pot the busted player was in — the
   * pot that took his last chips. Recorded by buildPotBreakdown (base, Omaha
   * hi-lo, Stud hi-lo); `handNumber` tells a stale record apart.
   */
  public lastHandPotEligibility: {
    handNumber: number;
    pots: Array<{ name: string; eligibleSeatIndices: number[]; winners: number[] }>;
  } | null = null;

  /**
   * True only when the hand reached a genuine CONTESTED showdown (>= 2 non-folded
   * players tabled their hands). Reset each hand; set in determineWinners. Consumers
   * (getGameStateForPlayer reveal, hand-history serialize) must NOT reveal hole cards
   * for a hand won uncontested (everyone folds to one player) — that player never
   * showed and their cards must stay hidden. 2026-07-05 audit fix.
   */
  public wentToShowdown: boolean = false;

  /**
   * 2026-10-11 (.online R1, ECON-1 / TABLEUI-1) — the all-in insurance
   * DECISION WINDOW. runOutBoard() deals every remaining board card in the same
   * tick the betting closes, so "all-in and called, board not complete" (the
   * only moment insurance may be offered — R1 contract #1) never existed long
   * enough for anyone to accept. index.ts installs `runoutHoldDecider`; when the
   * betting closes with board cards to come, runOutBoard asks it ONCE per hand
   * whether to HOLD the runout. While held the hand stays on its street with NO
   * actor (activeSeatIndex -1, so every action, turn timer and auto-act is a
   * no-op) until index.ts calls releaseRunoutHold() (accept / decline / the
   * window's timer). A second runOutBoard() while held (the wedge watchdog's
   * advanceTurn fallback) releases it too, so a lost timer can never wedge the
   * table. No decider installed (every engine test, every variant table the
   * decider declines) = unchanged behaviour.
   */
  public runoutHoldDecider: ((table: PokerTable) => boolean) | null = null;
  private _runoutHeld = false;
  private _runoutHoldAskedForHand = -1;

  /** Is the runout held for an insurance decision right now? */
  isRunoutHeld(): boolean {
    return this._runoutHeld;
  }

  /** End the insurance hold: deal the rest of the board and settle the hand. False when nothing was held. */
  releaseRunoutHold(): boolean {
    if (!this._runoutHeld) return false;
    this.runOutBoard();
    return true;
  }

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

  /**
   * 2026-10-21 (gameplay F110) — the table's own MAXIMUM buy-in, when it has
   * one (a club table's Max Buy-In, stored in club_tables and validated to be at
   * least minBuyIn). null = none: a join / rebuy / top-up is capped at the
   * 10 x minBuyIn heuristic only. Set by the server when it creates the table;
   * the cap the server applies is the smaller of the two.
   */
  public maxBuyInSetting: number | null = null;

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
    // P2 (2026-10-10) — a hand-completion emit from ANY determineWinners (the
    // Omaha / Stud hi-lo overrides emit their own) runs with startNewHand
    // refused, so its listeners can never start the next hand underneath it.
    if ((event === 'handResult' || event === 'handHistory') && !this._completingHand) {
      let out = false;
      this.whileCompletingHand(() => { out = super.emit(event, ...args); });
      return out;
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
    // 2026-10-11 (.online R1, AUTH-4) — a stack is never negative, NaN or
    // infinite, and a fresh buy-in is a positive whole number of chips, whatever
    // the table's minBuyIn says. A private table created with minBuyIn
    // -1,000,000 seated a NEGATIVE buy-in (its deductChips(-n) had credited the
    // wallet) — a mint. A relocation (allowBelowMin) may carry a busted 0.
    if (typeof buyIn !== 'number' || !Number.isFinite(buyIn) || buyIn < 0) return false;
    if (!allowBelowMin && (buyIn <= 0 || !Number.isInteger(buyIn))) return false;
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
    // 2026-10-11 (.online R2, GAME-10) — a seat taken while a hand is IN
    // PROGRESS is not in that hand: it paid no blind or ante and holds no cards.
    // It used to count as a live player — an uncontested winner's cards were
    // revealed ("showdown" against the cardless joiner), Stud dealt him the
    // later streets and gave him the action, a draw round waited for his draw.
    // He sits folded until the next startNewHand deals him in.
    seat.folded = this.isHandInProgress();
    seat.allIn = false;
    seat.holeCards = [];
    seat.currentBet = 0;
    seat.totalInvestedThisHand = 0;
    seat.lastAction = PlayerAction.None;
    // A brand-new player at this seat must not inherit any missed-blind
    // state from the previous occupant. Without this reset, a seat
    // vacated by a sitting-out player would charge the next occupant
    // dead-blind debt on their first hand.
    seat.missedBlind = 'none';
    seat.deadBlindOwedChips = 0;
    seat.deadMoneyThisHand = 0;
    this._debtSettledByLiveBB.delete(seatIndex);   // F5 fix-up — never the previous occupant's
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
   * Updates the status flag (`missedBlind`) AND the chip debt
   * (`deadBlindOwedChips`).
   *
   * 2026-10-21 (gameplay F6) — the debt is ONE set at most, however long the
   * player was away (the standard missed-blind rule): a missed small blind
   * owes the SB, a missed big blind the BB, both the SB + BB. It used to add a
   * SB + BB for every orbit sat out (225 after 12 hands at 25/50; a short
   * stack back from a long sit-out was put all-in on dead money unseen).
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
    // Accumulate chip debt. Small = smallBlind, Big = bigBlind — capped at
    // the one set the flag names (F6).
    const delta = blindType === 'big' ? this.config.bigBlind : this.config.smallBlind;
    seat.deadBlindOwedChips = Math.min(this.missedBlindSetChips(seat.missedBlind), (seat.deadBlindOwedChips || 0) + delta);
  }

  /** F6 — the most a missed-blind flag can owe: the one SB / BB / SB + BB it names. */
  protected missedBlindSetChips(flag: Seat['missedBlind']): number {
    const sb = this.config.smallBlind;
    const bb = this.config.bigBlind;
    return flag === 'both' ? sb + bb : flag === 'big' ? bb : flag === 'small' ? sb : 0;
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
    let sbSeat: number | undefined = isHeadsUp ? btn : orderedFromButton[0];
    let bbSeat: number | undefined = isHeadsUp ? orderedFromButton[0] : orderedFromButton[1];
    // 2026-10-21 (gameplay F11) — the positions moveDealerButton actually chose
    // (the same seats as the walk above on a standing table; after a big blind
    // left, the dead-button rule puts the small blind on that vacated seat).
    if (!isHeadsUp && this.previousBigBlindSeat >= 0 && this.smallBlindSeat >= 0) {
      sbSeat = this.smallBlindSeat;
      bbSeat = this.previousBigBlindSeat;
    }

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
   *                           | 'not_in_hand' | 'in_hand' (F4: dealt into this hand)
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
    // 2026-10-21 (gameplay F4) — never from a seat DEALT INTO this hand: a live
    // player could pick the hand (after seeing his cards) to add dead money,
    // and a stack equal to the debt went "all-in" on the clock without
    // calling, freezing the hand until the watchdog. His debt stays on the
    // seat and is collected at a later deal (postBlinds). A seat sitting this
    // hand out (folded, no cards) may still post — the Post Blinds flow.
    if (!seat.folded && seat.holeCards.length > 0) return { ok: false, reason: 'in_hand' };
    const owed = seat.deadBlindOwedChips || 0;
    if (owed <= 0) return { ok: false, reason: 'no_debt' };
    if (seat.chipCount < owed) return { ok: false, reason: 'insufficient_chips' };

    seat.chipCount -= owed;
    seat.totalInvestedThisHand += owed;
    seat.deadMoneyThisHand = (seat.deadMoneyThisHand || 0) + owed;   // F1 — dead, not a bet
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

  /**
   * 2026-10-10 (F1) — true while startNewHand runs, its 'beforeHandStart'
   * listeners included. Those listeners run synchronously and can reach code
   * that starts hands (index.ts: a tournament disqualification → elimination →
   * table rebalance → "restart hands on tables that were waiting"), which
   * called startNewHand on THIS table while it was still inside its own: the
   * hand was started twice, and the outer start then reset the inner hand's
   * posted blinds (seat.currentBet / totalInvestedThisHand = 0 — chips gone).
   * A hand can never be started twice now: a nested call is refused (false).
   */
  private _startingHand = false;
  /** F1 — set by a 'beforeHandStart' listener (vetoHandStart): do not deal this hand. */
  private _handStartVeto: string | null = null;
  /** F1 — startNewHand calls refused because the same table was already inside one. Should stay 0 (/api/health). */
  static reentrantStartsRefused = 0;

  /**
   * 2026-10-10 (P2) — true while the hand that just ended is being COMPLETED:
   * determineWinners (or a variant's override) is emitting 'handResult' /
   * 'handHistory' and, in the base class, revealing the finished hand's deck
   * seed. Those listeners run synchronously and reach code that starts hands
   * (index.ts: a bust → TournamentManager 'playerEliminated' → table rebalance
   * → "restart hands on tables that were waiting"). A hand started there
   * replaced the deck commitment BEFORE determineWinners revealed it, so the
   * NEW hand's seed was published (the unauthenticated /api/fairness
   * endpoints) while the finished hand's was never revealed. startNewHand is
   * refused while this is set (counted below); the next hand comes from the
   * normal hand-boundary scheduler.
   */
  private _completingHand = false;
  /** P2 — startNewHand calls refused because the table was still completing its previous hand. Should stay 0 (/api/health). */
  static completingHandStartsRefused = 0;

  /** F1 — is this table inside startNewHand right now (e.g. in its 'beforeHandStart' listeners)? */
  isStartingHand(): boolean {
    return this._startingHand;
  }

  /** P2 — is this table still completing its previous hand (inside its own 'handResult' / 'handHistory' emits)? */
  isCompletingHand(): boolean {
    return this._completingHand;
  }

  /** P2 — run `fn` (the hand-completion emits) with startNewHand refused on this table. Re-entrant. */
  protected whileCompletingHand(fn: () => void): void {
    const outer = this._completingHand;
    this._completingHand = true;
    try {
      fn();
    } finally {
      this._completingHand = outer;
    }
  }

  /**
   * F1 — called by a 'beforeHandStart' listener: the hand being started must
   * NOT be dealt (index.ts: the tournament rebalance that listener ran broke
   * this very table — its players now sit at other tables). startNewHand then
   * returns false before anything is reset or posted. A no-op outside
   * startNewHand.
   */
  vetoHandStart(reason: string): void {
    if (this._startingHand && this._handStartVeto === null) this._handStartVeto = reason;
  }

  startNewHand(): boolean {
    if (this._startingHand) {
      PokerTable.reentrantStartsRefused++;
      console.warn(`[PokerTable] ${JSON.stringify({
        event: 'start_new_hand_reentrant_refused', tableId: this.config.tableId,
        handNumber: this.handNumber, phase: this.currentPhase,
      })}`);
      return false;
    }
    // P2 — never start the next hand from inside the previous hand's
    // completion (its 'handResult' listeners): its seed is not revealed yet.
    if (this._completingHand) {
      PokerTable.completingHandStartsRefused++;
      console.warn(`[PokerTable] ${JSON.stringify({
        event: 'start_new_hand_while_completing_refused', tableId: this.config.tableId,
        handNumber: this.handNumber, phase: this.currentPhase,
      })}`);
      return false;
    }
    this._startingHand = true;
    this._handStartVeto = null;
    try {
      return this.startNewHandOnce();
    } finally {
      this._startingHand = false;
      this._handStartVeto = null;
    }
  }

  private startNewHandOnce(): boolean {
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

    // F1 — a listener vetoed this deal (nothing has been reset or posted yet).
    if (this._handStartVeto !== null) {
      console.warn(`[PokerTable] ${JSON.stringify({
        event: 'hand_start_vetoed', tableId: this.config.tableId, reason: this._handStartVeto,
      })}`);
      return false;
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
        seat.deadMoneyThisHand = 0;
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
    this.handBigBlind = this.config.bigBlind;   // Z3: this hand's level (a mid-hand level-up changes config only)
    this.lastAggressorSeat = -1;
    this.actionLog = [];
    this._debtSettledByLiveBB.clear();   // F5 fix-up — this hand's record only
    this._straddleOfHand = null;          // F22 fix-up
    this.clearBetIncreases();             // F22 fix-up — a new betting round
    this.wentToShowdown = false; // set true only on a contested showdown (>= 2 tabled)
    this._runoutHeld = false;    // R1 insurance window — never carried into a new hand

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
    // F13 (2026-10-21) — a seat taken since the last deal and sitting in the
    // dead zone (button .. small blind) waits this one hand out: no cards, no ante.
    for (const i of this._dealtOutSeats) this.seats[i].folded = true;

    // Missed-blinds refactor: BEFORE posting blinds, mark any sitting-out
    // seats whose "natural" position this hand would be SB or BB. The
    // debt accumulates against their deadBlindOwedChips so they owe the
    // proper amount when they sit back in. Seats that are active this
    // hand won't be marked here — they'll post live blinds in postBlinds.
    this.markSittingOutBlinds();

    // Post blinds
    this.postBlinds();
    // GAME-9 — this round's counters: the posted big blind is the pre-flop bet
    // (a blind-less Stud deal starts at 0 — its bring-in is not a bet).
    this.raisesThisStreet = 0;
    this.betLevelsThisStreet = this.currentBetToMatch > 0 ? 1 : 0;

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
    this._dealtOutSeats = new Set();
    // F11 / F13 — the last deal's blind holders and seat occupants (read before
    // this deal records its own).
    const blindHolders = this._blindHolders;
    const lastHolders = this._seatHoldersAtLastDeal;

    const occupied = this.getActivePlayerSeats();
    if (occupied.length < 2) return;

    // F13 — nobody from the last deal is still in his seat (an emptied table
    // that filled up again): a fresh table, its rotation starts over (no dead
    // blinds, nobody dealt out for joining).
    const freshTable = lastHolders !== null && !lastHolders.some((h, i) => h !== '' && this.holderIdOf(this.seats[i]) === h);

    // First hand: pick first occupied seat as dealer button
    if (this.dealerButtonSeat === -1 || this.previousBigBlindSeat === -1 || freshTable) {
      const firstOccupied = this.getNextOccupiedSeat(0);
      if (firstOccupied === -1) return;
      this.dealerButtonSeat = firstOccupied;

      // Initial blinds: SB is next occupied after button (or button itself in HU)
      if (occupied.length === 2) {
        // Heads-up: button = SB
        const bbSeat = this.getNextOccupiedSeat(this.dealerButtonSeat + 1);
        this.previousBigBlindSeat = bbSeat;
        this.smallBlindSeat = this.dealerButtonSeat;
      } else {
        const sbSeat = this.getNextOccupiedSeat(this.dealerButtonSeat + 1);
        const bbSeat = this.getNextOccupiedSeat(sbSeat + 1);
        this.previousBigBlindSeat = bbSeat;
        this.smallBlindSeat = sbSeat;
      }
      this.recordBlindHolders();
      return;
    }

    // Heads-up: the big blind moves one seat on from the LAST big blind and the
    // other player is the button / small blind. 2026-10-21 (gameplay F10, TDA
    // 34) — it used to move the button on from the old button, so when the
    // button left or busted 3-handed the previous big blind posted it again.
    // In steady heads-up this still alternates the button.
    if (occupied.length === 2) {
      const newBB = this.getNextOccupiedSeat(this.previousBigBlindSeat + 1);
      if (newBB === -1) return;
      this.dealerButtonSeat = this.getNextOccupiedSeat(newBB + 1);
      this.previousBigBlindSeat = newBB;
      this.smallBlindSeat = this.dealerButtonSeat;
      this.recordBlindHolders();
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
    // for genuine bust handling (reintroduced below, F11). Contiguous seating is
    // unchanged: getPrevOccupiedSeat(newBBSeat-1) === newBBSeat-1 when that
    // seat is occupied.
    const prevBB = this.previousBigBlindSeat;
    const prevSB = this.smallBlindSeat;
    const newBBSeat = this.getNextOccupiedSeat(prevBB + 1);
    if (newBBSeat === -1) return;

    let sbSlot = this.getPrevOccupiedSeat(newBBSeat - 1 + MAX_SEATS);
    let buttonSlot = this.getPrevOccupiedSeat(sbSlot - 1 + MAX_SEATS);

    // SB/button now always reference real occupied seats; no dead blind
    // from a seating gap.
    this.deadSmallBlind = false;
    this.deadButton = false;

    // 2026-10-21 (gameplay F11 / F13) — TDA DEAD BUTTON when a blind seat
    // changed hands since the last deal: the small blind is the last big
    // blind's seat and the button the last small blind's seat. On a standing
    // table these are exactly the seats the walk above found. They differ when
    //  F11: the last big blind left / busted — the walk moved the small blind
    //       back onto the last small blind (he paid it twice) and left the
    //       button where it was. Now: no small blind this hand (dead), the
    //       button moves to the last small blind;
    //  F13: a player sat down between the last small and big blind — the walk
    //       gave HIM the button (dealt in without posting) and the old small
    //       blind never got it. Now the old small blind gets the button and a
    //       seat taken since the last deal on the button, in the small blind or
    //       between them is dealt out of this one hand (TDA: never dealt in there).
    // Not known yet (a fresh table) or not a clean rotation (heads-up becoming
    // 3-handed, the button seat would be the new big blind) → the walk, as before.
    const strict =
      blindHolders !== null && lastHolders !== null &&
      prevSB >= 0 && prevSB !== prevBB && prevSB !== newBBSeat &&
      !this.seatStrictlyBetween(newBBSeat, prevSB, prevBB);
    if (strict) {
      sbSlot = prevBB;
      buttonSlot = prevSB;
    }

    // F13 fix-up (2026-10-21) — the dead zone applies to BOTH derivations. The
    // walk above is still used when the rotation is not a clean step (a
    // heads-up table gaining a third player: the last small blind is the new
    // big blind; a 3-handed table whose button left), and there it put a
    // newcomer on the button, dealt in without posting. A seat taken since the
    // last deal on the button, in the small blind or between them sits this one
    // hand out, down to a 2-handed hand between the established players (the
    // start gate already plays heads-up); see dealtOutNewcomers.
    if (lastHolders !== null && this.dealsOutNewSeatsInDeadZone()) {
      this._dealtOutSeats = this.dealtOutNewcomers(buttonSlot, sbSlot, lastHolders);
    }

    // F11 / F13 fix-up — the blinds follow who is really dealt in. The small
    // blind is dead only when nobody plays its seat: the last big blind left or
    // busted (empty / eliminated), or the newcomer who took that seat is dealt
    // out. A newcomer the table cannot deal out (fewer than 2 would be left)
    // posts it, as the walk made him before F11. (It used to be dead whenever
    // the seat changed hands, so such a newcomer was dealt in free and nobody
    // posted a small blind.) The button is dead when nobody plays it.
    const playsSeat = (i: number): boolean => {
      const s = this.seats[i];
      return !!s && s.state === 'occupied' && !s.eliminated && !this._dealtOutSeats.has(i);
    };
    this.deadSmallBlind = !playsSeat(sbSlot);
    this.deadButton = !playsSeat(buttonSlot);

    this.dealerButtonSeat = buttonSlot;
    this.previousBigBlindSeat = newBBSeat;
    this.smallBlindSeat = sbSlot;
    this.recordBlindHolders();
  }

  /** F11 / F13 — the identity a seat is remembered by between deals ('' = nobody). */
  private holderIdOf(s: Seat | undefined): string {
    if (!s || s.state !== 'occupied' || s.eliminated) return '';
    return s.playerId || s.playerName || `#${s.seatIndex}`;
  }

  /** F11 — is seat `i` still held by the player remembered there (`holder`, '' = nobody)? */
  private seatHeldBy(i: number, holder: string): boolean {
    if (i < 0 || i >= MAX_SEATS || !holder) return false;
    return this.holderIdOf(this.seats[i]) === holder;
  }

  /**
   * F13 fix-up (2026-10-21) — the seats taken since the last deal (`lastHolders`)
   * that sit on the button, in the small blind or between them (the TDA dead
   * zone, `buttonSlot` .. `sbSlot` clockwise): dealt out of this one hand.
   * At least 2 seats are always left dealt in: if dealing every such newcomer
   * out would leave fewer, the one in the small blind is kept (he posts it);
   * if that is still not enough, nobody is dealt out. (S2 kept 3 dealt in, so a
   * heads-up table gaining a third player, or a 3-handed table whose button
   * left, dealt the newcomer in on the button without posting.) The big blind
   * is never in the zone: a newcomer there posts it and plays.
   */
  private dealtOutNewcomers(buttonSlot: number, sbSlot: number, lastHolders: string[]): Set<number> {
    const isNew = (i: number): boolean => {
      const s = this.seats[i];
      return !!s && s.state === 'occupied' && !s.eliminated && !this.seatHeldBy(i, lastHolders[i] || '');
    };
    const out = new Set<number>();
    if (buttonSlot < 0 || sbSlot < 0) return out;
    for (let k = 0; k < MAX_SEATS; k++) {
      const i = (buttonSlot + k) % MAX_SEATS;
      if (isNew(i)) out.add(i);
      if (i === sbSlot) break;
    }
    if (out.size === 0) return out;
    const dealtInWithout = (o: Set<number>): number => this.seats.filter(s =>
      s.state === 'occupied' && !s.eliminated && s.chipCount > 0 &&
      !this._sittingOutSeats.has(s.seatIndex) && !o.has(s.seatIndex)).length;
    if (dealtInWithout(out) >= 2) return out;
    out.delete(sbSlot);
    if (out.size > 0 && dealtInWithout(out) >= 2) return out;
    return new Set();
  }

  /**
   * F13 fix-up (2026-10-21) — was this seat dealt out of the hand in progress
   * (or the last one dealt) for joining in the dead zone? Cleared at the next
   * deal. getGameStateForPlayer sends it per seat (`dealtOut`).
   */
  isDealtOut(seatIndex: number): boolean {
    if (this.currentPhase === GamePhase.WaitingForPlayers) return false;
    const s = this.seats[seatIndex];
    return !!s && s.state === 'occupied' && this._dealtOutSeats.has(seatIndex);
  }

  /** F13 — is `x` strictly between `from` and `to`, going clockwise? */
  private seatStrictlyBetween(x: number, from: number, to: number): boolean {
    const d = (a: number) => (((a - from) % MAX_SEATS) + MAX_SEATS) % MAX_SEATS;
    return d(x) > 0 && d(x) < d(to);
  }

  /** F11 / F13 — remember this deal's blind holders and seat occupants for the next deal. */
  private recordBlindHolders(): void {
    this._blindHolders = {
      sb: this.deadSmallBlind ? '' : this.holderIdOf(this.seats[this.smallBlindSeat]),
      bb: this.holderIdOf(this.seats[this.previousBigBlindSeat]),
    };
    this._seatHoldersAtLastDeal = this.seats.map(s => this.holderIdOf(s));
  }

  /**
   * F13 — does this game keep a seat taken since the last deal out of the hand
   * while it sits in the dead zone? Blind games do; Stud (antes + bring-in, no
   * blinds to skip) overrides it to false.
   */
  protected dealsOutNewSeatsInDeadZone(): boolean {
    return true;
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

    // 2026-10-21 (gameplay F5) — a player back in time for his BIG BLIND owes
    // nothing more (standard rule: post the missed blinds, OR wait for the big
    // blind): the live BB he posts below settles the debt. It used to be kept
    // (this hand was only skipped below) and taken as dead money two hands
    // later. bbSeat is already -1 for a big blind that is still sitting out,
    // so a debt that is still growing is never wiped here.
    // F5 fix-up (2026-10-21): what was settled is remembered for THIS hand, so a
    // bomb pot that refunds that big blind puts the debt back
    // (restoreRefundedDeadBlind) — before, the refund forgave both.
    if (bbSeat !== -1 && (this.seats[bbSeat].deadBlindOwedChips || 0) > 0) {
      const bb = this.seats[bbSeat];
      this._debtSettledByLiveBB.set(bbSeat, {
        handNumber: this.handNumber, playerId: bb.playerId, owed: bb.deadBlindOwedChips, flag: bb.missedBlind,
      });
      this.clearDeadBlind(bbSeat);
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
      if (this._sittingOutSeats.has(seatIdx) || this._dealtOutSeats.has(seatIdx)) continue;   // F13: not in this hand either
      if (owed > 0 && seatIdx !== sbSeat && seatIdx !== bbSeat) {
        // F1 fix-up (2026-10-21) — never take dead money that leaves the seat
        // no LIVE chips: a stack no bigger than the debt (at most one SB + BB,
        // F6) went in whole as dead money, all-in with nothing live — dealt
        // cards he could only lose with (the dead pot was his own chips; he
        // could never win a chip of anyone else's). He plays this hand with his
        // stack and keeps the debt: collected at a later deal once his stack
        // covers it with chips to spare, or settled by his big blind (F5).
        if (seat.chipCount <= owed) continue;
        const postAmount = Math.min(owed, seat.chipCount);
        if (postAmount > 0) {
          seat.chipCount -= postAmount;
          seat.totalInvestedThisHand += postAmount;
          seat.deadMoneyThisHand = (seat.deadMoneyThisHand || 0) + postAmount;   // F1 — dead, not a bet
          // Dead blind doesn't count toward currentBet — it's dead money
          if (seat.chipCount === 0) seat.allIn = true;
          this.emit('blindPosted', { seatIndex: seatIdx, amount: postAmount, type: 'dead' });
          this.actionLog.push({
            seatIndex: seatIdx,
            playerName: seat.playerName,
            action: `posted dead blind ${postAmount}`,
          });
          // Track remaining debt. Since the F1 fix-up the whole debt is posted
          // (a stack that cannot cover it with chips to spare is skipped
          // above), so this is 0; kept as the defensive bookkeeping.
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
        if (this._sittingOutSeats.has(seat) || this._dealtOutSeats.has(seat)) continue;   // F13: a dealt-out newcomer antes nothing
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
   * 2026-10-21 (gameplay F12 / F41) — the largest legal raise-to total for a
   * seat (pot-limit / fixed-limit caps; Infinity = no limit). A public read of
   * the variant's protected getMaxRaise for the game state.
   */
  maxRaiseFor(seatIndex: number): number {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return Infinity;
    return this.getMaxRaise(seatIndex);
  }

  /**
   * 2026-10-21 (gameplay F91) — the big blind of the hand IN PROGRESS. A
   * tournament level-up (and the quick / Spin & Go turbo) rewrites
   * config.bigBlind mid-hand; the opening-bet minimum and every later
   * street's min-raise of the hand being played stay at the level it was
   * dealt at (TDA: a new level starts with the next hand). 0 (no hand dealt
   * yet / an older snapshot) falls back to the table's current level.
   */
  protected handBB(): number {
    return this.handBigBlind > 0 ? this.handBigBlind : this.config.bigBlind;
  }

  /**
   * 2026-10-21 (gameplay F30) — a FIXED-LIMIT game's bet size on the current
   * street: the small bet (one big blind) by default. Stud (5th-7th street)
   * and Triple Draw / Badugi (after the first draw) override it with the big
   * bet. Every bet and raise on the street is exactly this much (resetBettingRound
   * makes it the street's raise size, getMaxRaise caps at it).
   */
  protected getFixedLimitBetSize(): number {
    return this.handBB();
  }

  /**
   * 2026-10-21 (gameplay F3 / F7, TDA 41 / 47) — is this seat locked to call or
   * fold because the betting was NOT reopened to it? Only a seat that has acted
   * since the last full raise and now faces LESS than a full raise (short
   * all-ins). lastRaiseAmount only moves on a full raise (which also clears the
   * flag), so what such a seat faces is exactly the short all-ins since it
   * acted: several of them that add up to a full raise reopen the betting.
   */
  protected raiseLockedFor(seat: Seat): boolean {
    if (!seat.hasActedSinceLastFullRaise) return false;
    const facing = this.currentBetToMatch - seat.currentBet;
    return facing > 0 && facing < this.lastRaiseAmount;
  }

  /**
   * 2026-10-21 (gameplay F12 / F3) — may this seat RAISE (or bet) right now,
   * whether or not it is its turn? In the hand, not all-in, a betting round
   * (not a draw, not a held runout), the betting reopened to it (TDA 41 / 47),
   * fixed limit not capped, and more chips than the call. playerAllIn turns a
   * shove into a call when this is false; the game state sends it as `canRaise`.
   */
  canRaise(seatIndex: number): boolean {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return false;
    if (!this.isHandInProgress() || this.currentPhase === GamePhase.Showdown) return false;
    if (NO_BETTING_PHASES.includes(this.currentPhase) || this.isRunoutHeld()) return false;
    const seat = this.seats[seatIndex];
    if (!seat || seat.state !== 'occupied' || seat.folded || seat.allIn || seat.eliminated) return false;
    if (this.raiseLockedFor(seat)) return false;
    if (this.isRaiseCapped()) return false;
    return seat.chipCount > this.currentBetToMatch - seat.currentBet;
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
    this.lowerBetAfterOutOfTurnFold(seat);
    return true;
  }

  /**
   * 2026-10-21 (gameplay F22) — a seat folded OUT OF TURN (its player left)
   * that held the TOP bet nobody still in the hand has matched: that bet is
   * dead money now (it stays in the pot, layered by SidePotManager), not a bet
   * anyone faces. The bet to match drops to the highest bet still live, so the
   * player on the clock may check instead of calling a hand that no longer
   * exists — before, a check was refused, and folding (also the turn timer's
   * answer to a bet) handed a short all-in the leaver's chips and the main pot.
   * The round's FORCED bet stays the bet (the big blind pre-flop, as postBlinds
   * keeps it for a dead BB; a UTG straddle; Stud's bring-in). The min-raise
   * follows. Fix-up: the betting state goes back to what it was before the
   * void raise(s) — who may still act or raise, the min-raise, the fixed-limit
   * counters — while the seat on the clock keeps its turn. The decision point
   * changed, so stateVersion moves (a stale "call" is refused).
   */
  private lowerBetAfterOutOfTurnFold(folded: Seat): void {
    if (!this.isHandInProgress() || this.currentPhase === GamePhase.Showdown) return;
    if (NO_BETTING_PHASES.includes(this.currentPhase)) return;
    const top = this.currentBetToMatch;
    if (top <= 0 || folded.currentBet < top) return;
    const live = this.playersInHand();
    if (live.length === 0) return;
    const floor = Math.min(top, this.forcedBetOfRound());
    const highestLive = Math.max(floor, ...live.map(s => s.currentBet));
    if (highestLive >= top) return;
    // F22 fix-up (2026-10-21) — every increase above highestLive was made by a
    // seat now out of the hand (a live seat that had matched one would hold
    // it, and nobody live can have acted on one without matching it, folding
    // or going all-in), so the betting goes back EXACTLY to the state before
    // the first of them: the raise size then in force (TDA 40), who had acted
    // since the last full raise (TDA 41 — a seat that acted before the void
    // raise and now faces only a short all-in is locked to call / fold again;
    // the void raise had reopened it), the bet-level / raise counters (fixed
    // limit: every void level, not just one) and the aggressor.
    const before = this.popBetIncreasesAbove(highestLive);
    this.currentBetToMatch = highestLive;
    if (before) {
      this.lastRaiseAmount = this.bettingStructure === 'fixed-limit'
        ? this.raiseIncrementAfterLoweredBet(highestLive)
        : Math.max(this.raiseUnitOfRound(), before.lastRaiseAmount);
      this.raisesThisStreet = before.raisesThisStreet;
      this.betLevelsThisStreet = before.betLevelsThisStreet;
      const acted = new Map(before.acted);
      for (const s of this.seats) {
        if (s.state !== 'occupied' || s.folded || s.allIn || !acted.has(s.seatIndex)) continue;
        s.hasActedSinceLastFullRaise = acted.get(s.seatIndex) === true;
      }
      // The seat on the clock keeps its turn (as before: it may check now).
      const onClock = this.seats[this.activeSeatIndex];
      if (onClock && this.canAct(onClock) && !this.owes(onClock.seatIndex)) onClock.hasActedSinceLastFullRaise = false;
      const aggr = before.lastAggressorSeat;
      this.lastAggressorSeat = aggr >= 0 && this.seats[aggr] && !this.seats[aggr].folded ? aggr : -1;
    } else {
      // No record of the increase (a rehydrated hand): the original F22 approximation.
      this.lastRaiseAmount = this.raiseIncrementAfterLoweredBet(highestLive);
      if (this.raisesThisStreet > 0) this.raisesThisStreet--;
      this.betLevelsThisStreet = highestLive > 0 ? Math.max(0, this.betLevelsThisStreet - 1) : 0;
      if (this.lastAggressorSeat === folded.seatIndex) this.lastAggressorSeat = -1;
    }
    this.stateVersion++;
  }

  /** F22 fix-up — record an increase of the bet to match to `level`, with the betting state just before it. */
  private noteBetIncrease(level: number): void {
    const key = `${this.handNumber}|${this.currentPhase}`;
    if (this._betIncreasesKey !== key) {
      this._betIncreases = [];
      this._betIncreasesKey = key;
    }
    this._betIncreases.push({
      level,
      lastRaiseAmount: this.lastRaiseAmount,
      acted: this.seats.filter(s => s.state === 'occupied').map(s => [s.seatIndex, s.hasActedSinceLastFullRaise] as [number, boolean]),
      betLevelsThisStreet: this.betLevelsThisStreet,
      raisesThisStreet: this.raisesThisStreet,
      lastAggressorSeat: this.lastAggressorSeat,
    });
  }

  /** F22 fix-up — drop this round's increases above `level`; the state before the earliest dropped one (null: none recorded). */
  private popBetIncreasesAbove(level: number): BetIncreaseRecord | null {
    if (this._betIncreasesKey !== `${this.handNumber}|${this.currentPhase}`) {
      this.clearBetIncreases();
      return null;
    }
    let earliest: BetIncreaseRecord | null = null;
    while (this._betIncreases.length > 0 && this._betIncreases[this._betIncreases.length - 1].level > level) {
      earliest = this._betIncreases.pop()!;
    }
    return earliest;
  }

  private clearBetIncreases(): void {
    this._betIncreases = [];
    this._betIncreasesKey = '';
  }

  /** F22 fix-up — the UTG straddle posted this hand (0 = none). */
  protected straddleOfHand(): number {
    return this._straddleOfHand && this._straddleOfHand.handNumber === this.handNumber ? this._straddleOfHand.amount : 0;
  }

  /** F22 fix-up — the round's smallest full raise: a big blind, and pre-flop after a straddle the straddle (straddle(): the new effective big blind). */
  protected raiseUnitOfRound(): number {
    const bb = this.handBigBlind || this.config.bigBlind;
    return this.currentPhase === GamePhase.PreFlop ? Math.max(bb, this.straddleOfHand()) : bb;
  }

  /**
   * F22 — the forced bet of this betting round no fold can take away: the big
   * blind pre-flop — the UTG straddle once one was posted (fix-up: it is the
   * effective big blind, and a dead big blind stays the bet too) — (Stud
   * overrides: the bring-in).
   */
  protected forcedBetOfRound(): number {
    if (this.currentPhase !== GamePhase.PreFlop) return 0;
    return Math.max(this.handBigBlind || this.config.bigBlind, this.straddleOfHand());
  }

  /** F22 — the min-raise increment once the bet to match was lowered to `toMatch`: never above the live bet, never under a big blind (pre-flop after a straddle: the straddle). */
  protected raiseIncrementAfterLoweredBet(toMatch: number): number {
    // F30 (2026-10-21) — fixed limit: the street's bet size, whatever was lowered.
    if (this.bettingStructure === 'fixed-limit') return this.getFixedLimitBetSize();
    return Math.max(this.raiseUnitOfRound(), Math.min(this.lastRaiseAmount, toMatch));
  }

  /**
   * 2026-10-11 (.online R2, GAME-15 / GAME-16) — after a seat was folded OUT OF
   * TURN (forceFoldSeat: its player left), award the hand at once when at most
   * one player is left in it — the same rule advanceTurn applies after a fold
   * on the clock. Before, the last player had to act first: a human facing the
   * leaver's bet had to CALL to collect (folding refunded everyone), and an
   * all-in hand waited out the insurance window. Clears a held runout (the
   * window has nothing left to decide). False — nothing done — while two or
   * more players are still in the hand.
   */
  awardIfUncontested(): boolean {
    if (!this.isHandInProgress() || this.currentPhase === GamePhase.Showdown) return false;
    if (this.playersInHand().length > 1) return false;
    this._runoutHeld = false;
    this.activeSeatIndex = -1;
    this.accumulateInvestments();
    this.determineWinners();
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
    // to them and a voluntary re-raise is illegal. 2026-10-21 (gameplay F7, TDA
    // 47): unless the short all-ins it now faces ADD UP to a full raise — then
    // the betting is reopened (raiseLockedFor). The same lock now holds for a
    // shove (playerAllIn turns it into a call — F3).
    if (this.raiseLockedFor(seat)) {
      return false;
    }

    // GAME-9 — fixed limit: once the round holds a bet and three raises the
    // only options left are call or fold (executeAIAction falls back to a call).
    if (this.isRaiseCapped()) return false;

    const minRaise = this.getMinRaise();

    // TDA: Opening bet must be at least one big blind (F91: the big blind the
    // hand was dealt at — a mid-hand level-up does not raise it).
    if (this.currentBetToMatch === 0 && totalRaiseAmount < this.handBB()) {
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

    if (totalRaiseAmount > this.currentBetToMatch) this.noteBetIncrease(totalRaiseAmount);   // F22 fix-up

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
      this.betLevelsThisStreet++;   // GAME-9
    }

    seat.chipCount -= additionalChips;
    seat.currentBet = totalRaiseAmount;
    seat.totalInvestedThisHand += additionalChips;
    seat.lastAction = PlayerAction.Raise;
    seat.hasActedSinceLastFullRaise = true;
    this.currentBetToMatch = totalRaiseAmount;
    this.raisesThisStreet++;        // GAME-9

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
  /**
   * 2026-10-11 (.online R2, TABLEUI-19 / contract C11) — may this seat straddle
   * RIGHT NOW? Every precondition straddle() enforces, readable without acting:
   * index.ts stamps it into the seat's own game state as `isFirstActor` (the
   * client's Straddle button was gated on that key, which was never sent).
   * Pre-flop, this seat on the clock, nothing above the big blind, nobody has
   * acted yet, a real UTG (three or more players dealt in — heads-up there is
   * none), and the seat can post 2 BB without going all-in.
   */
  canStraddle(seatIndex: number): boolean {
    if (this.currentPhase !== GamePhase.PreFlop) return false;
    if (this.activeSeatIndex !== seatIndex) return false;
    if (this.currentBetToMatch !== this.handBB()) return false;   // F91: this hand's big blind
    // Straddle must be the FIRST voluntary action of the hand (blinds are
    // logged without a street, so no pre-flop entry == nobody has acted yet).
    if (this.actionLog.some(a => a.street === this.currentPhase)) return false;
    if (this.isRaiseCapped()) return false;
    const seat = this.seats[seatIndex];
    if (!seat || seat.state !== 'occupied' || seat.folded || seat.allIn || seat.holeCards.length === 0) return false;
    const dealtIn = this.seats.filter(s => s.state === 'occupied' && !s.folded && !s.eliminated && s.holeCards.length > 0).length;
    if (dealtIn < 3) return false;
    const additional = 2 * this.handBB() - seat.currentBet;
    // Require the full straddle without going all-in (keep reopening semantics simple).
    return additional > 0 && additional < seat.chipCount;
  }

  straddle(seatIndex: number): boolean {
    if (!this.canStraddle(seatIndex)) return false;
    const seat = this.seats[seatIndex];
    const straddleAmount = 2 * this.handBB();

    const ok = this.playerRaise(seatIndex, straddleAmount);
    if (!ok) return false;

    // The straddle's one difference from a normal raise: the straddler keeps
    // their option, so owes() re-selects them when the action comes back around.
    seat.hasActedSinceLastFullRaise = false;
    // 2026-10-21 (gameplay F8) — the straddle is the new effective big blind,
    // so a full raise over it is a straddle more (min-raise 4 BB, not 3 BB),
    // and a short all-in under a straddle no longer reopens the betting.
    // Fixed limit keeps its one-small-bet raise (min = max there).
    if (this.bettingStructure !== 'fixed-limit') this.lastRaiseAmount = straddleAmount;
    // F22 fix-up — and a FORCED bet: a fold out of turn never lowers the bet
    // below it (forcedBetOfRound), as a dead big blind stays the bet to call.
    this._straddleOfHand = { handNumber: this.handNumber, amount: straddleAmount };
    const last = this.actionLog[this.actionLog.length - 1];
    if (last && last.seatIndex === seatIndex) last.action = 'straddle';
    return true;
  }

  /**
   * 2026-10-11 (.online R2, GAME-12) — turn the hand that was JUST dealt into a
   * BOMB POT: every dealt-in seat puts the same `ante` in (the blinds / antes
   * it posted are returned first — a bomb pot is an equal wager), there is no
   * pre-flop betting, and the flop comes off THIS table's own deck through its
   * own dealCommunityCards (burn rule, Short Deck's 36 cards, variant hooks).
   * index.ts (activateBombPotIfPending) used to pull three cards off the base
   * 52-card deck itself and flip the phase by hand: Short Deck flopped cards it
   * does not contain, Stud and Draw tables got a community flop. index.ts only
   * asks this of Hold'em / Omaha cash tables (bombPotAllowedAt).
   * Returns false — and changes nothing — unless the hand is pre-flop with no
   * board and nobody has acted yet.
   */
  applyBombPot(ante: number): boolean {
    if (this.currentPhase !== GamePhase.PreFlop || this.communityCards.length > 0) return false;
    if (this.actionLog.some(a => a.street === GamePhase.PreFlop)) return false;
    if (!Number.isFinite(ante) || ante <= 0) return false;
    for (const seat of this.seats) {
      if (seat.state !== 'occupied' || seat.eliminated) continue;
      // 2026-10-21 (gameplay F14) — a dead blind returned with the rest is
      // still OWED: restore it as debt (collected at the next normal deal).
      // It used to be refunded with the debt already cleared — the missed
      // blinds of a player whose first hand back was a bomb pot were forgiven.
      this.restoreRefundedDeadBlind(seat);
      // Return what was posted this hand (blinds, antes, a dead blind).
      seat.chipCount += seat.totalInvestedThisHand;
      seat.totalInvestedThisHand = 0;
      seat.currentBet = 0;
      seat.allIn = false;
      if (seat.folded || seat.holeCards.length === 0) continue;   // sitting out: not in the bomb pot
      const posted = Math.min(ante, seat.chipCount);
      seat.chipCount -= posted;
      seat.totalInvestedThisHand = posted;
      // A stack the ante takes whole is all-in (never auto-folded out of a pot it paid into).
      if (seat.chipCount === 0) seat.allIn = true;
    }
    // Straight to the flop: a fresh betting round, dealt by this table.
    this.currentPhase = GamePhase.Flop;
    this.resetBettingRound();
    this.dealCommunityCardsForPhase(GamePhase.Flop);
    this.emit('phaseChanged', { phase: this.currentPhase });
    this.setFirstActivePlayer();
    // Nobody (or a single player) left who can bet: run the board out, as
    // advanceToNextStreet does — never leave a table without an actor.
    if (this.actingPlayers().length <= 1) {
      this.accumulateInvestments();
      this.runOutBoard();
    }
    return true;
  }

  /**
   * F14 (2026-10-21) — the dead blind a seat posted this hand goes back on its
   * debt (the caller refunds the chips with the rest of what was posted), and
   * its 'posted dead blind N' log line goes too: that post never counted.
   */
  private restoreRefundedDeadBlind(seat: Seat): void {
    // F5 fix-up (2026-10-21) — the debt his LIVE big blind settled this hand
    // (postBlinds) comes back too: that big blind is refunded with the rest, so
    // he would otherwise pay neither the big blind nor the debt.
    const settled = this._debtSettledByLiveBB.get(seat.seatIndex);
    this._debtSettledByLiveBB.delete(seat.seatIndex);
    if (settled && settled.handNumber === this.handNumber && settled.playerId === seat.playerId && settled.owed > 0) {
      const cur = seat.missedBlind;
      const flag: Seat['missedBlind'] = cur === 'none' ? settled.flag
        : settled.flag === 'none' || settled.flag === cur ? cur : 'both';
      seat.missedBlind = flag;
      seat.deadBlindOwedChips = Math.min(this.missedBlindSetChips(flag), (seat.deadBlindOwedChips || 0) + settled.owed);
    }
    const dead = seat.deadMoneyThisHand || 0;
    seat.deadMoneyThisHand = 0;
    if (dead <= 0) return;
    seat.deadBlindOwedChips = (seat.deadBlindOwedChips || 0) + dead;
    if (seat.missedBlind === 'none') {
      const { smallBlind: sb, bigBlind: bb } = this.config;
      seat.missedBlind = seat.deadBlindOwedChips >= sb + bb ? 'both' : seat.deadBlindOwedChips >= bb ? 'big' : 'small';
    }
    const at = this.actionLog.findIndex(a => a.seatIndex === seat.seatIndex && a.action.startsWith('posted dead blind '));
    if (at >= 0) this.actionLog.splice(at, 1);
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
    // GAME-9 — fixed limit capped (a bet and three raises): an "all-in" that
    // would raise is only a call now (a covered player keeps the rest).
    // 2026-10-21 (gameplay F3, TDA 41) — likewise when the betting was NOT
    // reopened to this seat (it acted, then only short all-ins came in): the
    // shove used to be accepted as a full re-raise (it reset everyone's flags
    // and forced the callers to call the whole stack again). Raise refused it,
    // All-In did not. canRaise covers both (and an all-in for no more than the
    // call is unchanged — that is a call).
    if (stack > callAmount && !this.canRaise(seatIndex)) {
      return callAmount > 0 ? this.playerCall(seatIndex) : this.playerCheck(seatIndex);
    }
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
      this.noteBetIncrease(totalBet);   // F22 fix-up
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
        this.betLevelsThisStreet++;   // GAME-9 — only a FULL raise is a bet level
      }
      // TDA Rule 16: track last aggressor BEFORE updating currentBetToMatch,
      // otherwise the guard below (totalBet > currentBetToMatch) is always false.
      this.lastAggressorSeat = seatIndex;
      this.currentBetToMatch = totalBet;
      this.raisesThisStreet++;        // GAME-9
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
    // No occupied seat still in the hand may be "over" the current bet-to-match
    // (F22, 2026-10-21: a seat folded out of turn can be — its bet is dead
    // money once nobody live faces it, see lowerBetAfterOutOfTurnFold).
    for (const s of this.seats) {
      if (s.state === 'occupied' && !s.folded && s.currentBet > this.currentBetToMatch) {
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
    // 2026-10-21 (gameplay F91 / F30) — the street's opening bet / raise size:
    // the big blind the HAND was dealt at (a mid-hand level-up applies from the
    // next hand); fixed limit: that street's bet size (the big bet on Stud
    // 5th-7th and Triple Draw / Badugi after the second draw (F39) — it was always the
    // small bet, so half-size and odd-size bets and raises were accepted there).
    this.lastRaiseAmount = this.bettingStructure === 'fixed-limit' ? this.getFixedLimitBetSize() : this.handBB();
    this.raisesThisStreet = 0;      // GAME-9
    this.betLevelsThisStreet = 0;
    // TDA Rule 16: reset per-street so showdown order uses final-street aggressor only
    this.lastAggressorSeat = -1;
    this.clearBetIncreases();       // F22 fix-up

    for (const seat of this.seats) {
      if (seat.state === 'occupied') {
        seat.currentBet = 0;
        seat.lastAction = PlayerAction.None;
        seat.hasActedSinceLastFullRaise = false;
      }
    }
  }

  protected runOutBoard(): void {
    // 2026-10-11 (R1) — the insurance decision window (see runoutHoldDecider).
    if (this._runoutHeld) {
      this._runoutHeld = false; // released (index.ts) or the watchdog's fallback: run out now
    } else if (
      this.runoutHoldDecider &&
      this._runoutHoldAskedForHand !== this.handNumber &&
      this.communityCards.length < 5
    ) {
      this._runoutHoldAskedForHand = this.handNumber;
      let hold = false;
      try {
        hold = this.runoutHoldDecider(this) === true;
      } catch (e: any) {
        console.error('[PokerTable] runoutHoldDecider threw (ignored, board runs out):', e?.message || e);
      }
      if (hold) {
        this._runoutHeld = true;
        this.activeSeatIndex = -1;
        // The betting is over: nobody may OWE a decision while held. The
        // closed street's bets are already in the pot (accumulateInvestments),
        // but currentBetToMatch still held the all-in amount — a watchdog
        // advanceTurn would have handed the caller a phantom bet to call
        // (or fold!). With nothing to match, nextActor() finds nobody and the
        // fallback goes straight to the runout.
        this.currentBetToMatch = 0;
        for (const s of this.seats) if (s.state === 'occupied') s.currentBet = 0;
        // Nobody acts: index.ts's turn timer is disarmed by this turnChanged
        // (armTurnTimer arms nothing for seat -1) and stateVersion moves on.
        this.emit('turnChanged', { seatIndex: -1 });
        this.emit('runoutHeld', { handNumber: this.handNumber });
        return;
      }
    }
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

    // GAME-10 (R2) — a seat holding NO cards never contests the pot (a mid-hand
    // joiner — sitDown folds him, this is the second lock): counted as folded,
    // it can neither turn an uncontested pot into a "showdown" that reveals the
    // winner's cards nor win a pot with the board alone.
    const seatInfos: SeatInfo[] = this.seats
      .filter(s => s.state === 'occupied' && !s.eliminated)
      .map(s => ({
        seatIndex: s.seatIndex,
        chipCount: s.chipCount,
        totalInvestedThisHand: s.totalInvestedThisHand,
        folded: s.folded || s.holeCards.length === 0,
        allIn: s.allIn,
        holeCards: s.holeCards,
        state: s.state,
        deadMoney: s.deadMoneyThisHand,   // F1/F2 — dead blinds go to the main pot
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
        // Sort clockwise from the first seat left of the dealer (R2: the button shows last).
        const order = SidePotManager.orderClockwiseFromDealer(showdownHands.map(h => h.seatIndex), this.dealerButtonSeat, MAX_SEATS);
        showdownHands.sort((a, b) => order.indexOf(a.seatIndex) - order.indexOf(b.seatIndex));
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
    // Per-pot winners (F19, 2026-10-21: a hand won by fold names its winner too —
    // the old `nonFolded.length > 1` guard left every fold-won pot winnerless).
    const potBreakdown = this.buildPotBreakdown(pots, results, nonFolded.length === 1 ? nonFolded[0].seatIndex : null);
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
          // 2026-07-05 audit fix: never expose hole cards for a hand won
          // uncontested (no showdown) — the winner never showed. Only reveal
          // non-folded hands when the hand actually reached a contested showdown.
          // 2026-10-11 (.online R1, TABLEUI-6): nor their STRENGTH — the hand
          // name was computed for every non-folded seat, so the replay of an
          // uncontested pot said "Two Pair, Kings and 7s" next to hidden cards
          // (888 of 8,463 stored records). Masked cards = no hand name.
          const shown = !s.folded && this.wentToShowdown && s.holeCards.length > 0;
          const allCards = [...s.holeCards, ...this.communityCards];
          // R7: `>= 4` for non-community games so 4-card Badugi evaluates.
          const handRes = shown && (allCards.length >= 5 || (!this.usesCommunityCards() && s.holeCards.length >= 4))
            ? this.evaluatePlayerHand(s.holeCards, this.communityCards) : null;
          return {
            seatIndex: s.seatIndex,
            name: s.playerName,
            holeCards: shown ? [...s.holeCards] : null,
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
      variant: this.variantId,   // G180 (2026-10-21)
    };

    // Reset totalInvestedThisHand
    for (const seat of this.seats) {
      seat.totalInvestedThisHand = 0;
      seat.deadMoneyThisHand = 0;
    }

    this.currentPhase = GamePhase.HandComplete;
    this.activeSeatIndex = -1;

    this.emitHandCompletion(results, handHistory);
    this.emit('phaseChanged', { phase: this.currentPhase });
  }

  /**
   * 2026-10-21 (gameplay F19 / F20 / F23) — THE per-pot winner list of a
   * finished hand, shared by the base determineWinners and the Omaha / Stud
   * hi-lo overrides. `loneWinner` = the one seat left when everyone else
   * folded: he wins every pot whole. Otherwise a pot's results are those named
   * exactly `name`, `name (High)` or `name (Low)` (never a bare prefix: 'Side
   * Pot 1' is not 'Side Pot 10'), summed per seat in first-appearance order.
   * Nobody won (the all-fold refund): no results, so every pot stays empty.
   */
  protected buildPotBreakdown(
    pots: Array<{ name: string; amount: number; eligibleSeatIndices?: number[] }>,
    results: Array<{ seatIndex: number; amount: number; potName: string }>,
    loneWinner: number | null,
  ): PotBreakdownEntry[] {
    const breakdown = pots.map(p => {
      const bySeat = new Map<number, number>();
      if (loneWinner !== null && loneWinner >= 0) {
        if (p.amount > 0) bySeat.set(loneWinner, p.amount);
      } else {
        const names = new Set([p.name, `${p.name} (High)`, `${p.name} (Low)`]);
        for (const r of results) {
          if (!r || !names.has(r.potName)) continue;
          bySeat.set(r.seatIndex, (bySeat.get(r.seatIndex) || 0) + r.amount);
        }
      }
      const winnerAmounts = [...bySeat].map(([seatIndex, amount]) => ({ seatIndex, amount }));
      return { name: p.name, amount: p.amount, winners: winnerAmounts.map(w => w.seatIndex), winnerAmounts };
    });
    // F92 — who could win each pot, kept beside the (unchanged) public breakdown.
    this.lastHandPotEligibility = {
      handNumber: this.handNumber,
      pots: pots.map((p, i) => ({
        name: p.name,
        eligibleSeatIndices: Array.isArray(p.eligibleSeatIndices) ? [...p.eligibleSeatIndices] : [],
        winners: [...breakdown[i].winners],
      })),
    };
    return breakdown;
  }

  /**
   * The ONE way a finished hand is announced — the base determineWinners AND
   * the Omaha / Stud hi-lo overrides (2026-10-10). Before this the hi-lo
   * overrides emitted 'handResult' themselves and never revealed the deck
   * seed: their hand's commitment was broadcast at hand start but its seed was
   * never published, so /api/fairness could not verify a single hi-lo hand
   * (`hiLoSeedRevealed` — the fairness rule: every committed hand is revealed).
   * P2 (2026-10-10): the commitment of the hand that JUST ENDED is read before
   * any listener runs — it is the one revealed, whatever a listener does — and
   * no listener may start the next hand while this one is completing
   * (startNewHand is refused until the seed below has been revealed).
   * `handHistory` null = a variant that records none (Stud hi-lo).
   */
  protected emitHandCompletion(results: HandWinResult[], handHistory: HandHistoryRecord | null): void {
    const commitment = this.deck.revealSeed();
    // 2026-10-11 (.online R2, GAME P3) — every result entry names WHO won it:
    // `playerId`, `isAI` and `chipsWon` (= amount, per pot). The anti-cheat
    // chip-velocity monitor (index.ts handResult listener) reads those three
    // and never ran — no entry carried them. Additive; nothing else changes.
    results = results.map((r) => {
      const seat = this.seats[r.seatIndex];
      return { ...r, playerId: seat?.playerId || '', isAI: !!seat?.isAI, chipsWon: r.amount };
    });
    this.whileCompletingHand(() => {
      this.emit('handResult', { results, handNumber: this.handNumber });
      if (handHistory) this.emit('handHistory', handHistory);
      // Reveal seed so players can verify the shuffle was fair
      if (commitment) {
        this.emit('deckSeedRevealed', { seed: commitment.seed, hash: commitment.hash, handNumber: commitment.handNumber });
      }
    });
  }

  // ========== Utility Methods ==========

  protected isValidAction(seatIndex: number): boolean {
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) return false;
    if (this.activeSeatIndex !== seatIndex) return false;
    if (this.currentPhase === GamePhase.WaitingForPlayers) return false;
    if (this.currentPhase === GamePhase.HandComplete) return false;
    if (this.currentPhase === GamePhase.Showdown) return false;
    // 2026-10-21 (gameplay F28 / F29) — a draw round has no betting: the seat
    // that closed the betting round before it stays activeSeatIndex through the
    // draw, and its call / raise / all-in / fold used to be accepted there
    // (chips into the pot mid-draw, a phantom turn, a fold that wedged the
    // round). Draws go through FiveCardDrawTable.playerDraw; a leaver through
    // forceFoldSeat.
    if (NO_BETTING_PHASES.includes(this.currentPhase)) return false;

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

  /**
   * GAME-9 — a FIXED-LIMIT betting round that already holds a bet and three
   * raises (FIXED_LIMIT_MAX_BET_LEVELS): nobody may raise again this round.
   * No-limit / pot-limit are never capped here (the bots cap their own
   * re-raising — AIPlayer).
   */
  isRaiseCapped(): boolean {
    return this.bettingStructure === 'fixed-limit' && this.betLevelsThisStreet >= FIXED_LIMIT_MAX_BET_LEVELS;
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
        deadMoney: s.deadMoneyThisHand,   // F1/F2
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
      handBigBlind: this.handBigBlind,
      stateVersion: this.stateVersion,
      lastAggressorSeat: this.lastAggressorSeat,
      previousBigBlindSeat: this.previousBigBlindSeat,
      deadSmallBlind: this.deadSmallBlind,
      deadButton: this.deadButton,
      // F11 / F13 (2026-10-21) — the dead-button memory of the last deal.
      smallBlindSeat: this.smallBlindSeat,
      blindHolders: this._blindHolders,
      seatHoldersAtLastDeal: this._seatHoldersAtLastDeal,
      dealtOutSeats: Array.from(this._dealtOutSeats),
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
        deadMoneyThisHand: s.deadMoneyThisHand,
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
    // Z3 — older snapshots lack it: 0 (absentTournamentSeatMayLimp then reads config.bigBlind).
    this.handBigBlind = typeof snap.handBigBlind === 'number' ? snap.handBigBlind : 0;
    // Restore the decision-point version if the snapshot carries it (older
    // snapshots won't — a rehydrate resetting it lower is safe; see field doc).
    // rehydrate itself will re-emit phaseChanged/turnChanged during resume,
    // so seed from the snapshot then let those bumps continue monotonically.
    if (typeof snap.stateVersion === 'number') this.stateVersion = snap.stateVersion;
    this.lastAggressorSeat = snap.lastAggressorSeat;
    this.previousBigBlindSeat = snap.previousBigBlindSeat;
    this.deadSmallBlind = snap.deadSmallBlind;
    this.deadButton = snap.deadButton;
    // F11 / F13 — older snapshots lack them: unknown (the C10 walk until a deal records them).
    this.smallBlindSeat = typeof snap.smallBlindSeat === 'number' ? snap.smallBlindSeat : -1;
    this._blindHolders = snap.blindHolders ?? null;
    this._seatHoldersAtLastDeal = Array.isArray(snap.seatHoldersAtLastDeal) ? snap.seatHoldersAtLastDeal : null;
    this._dealtOutSeats = new Set(snap.dealtOutSeats || []);
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
  /** Z3 — the big blind the hand was dealt at (optional: older snapshots). */
  handBigBlind?: number;
  /** Decision-point version — optional for backward-compat with older snapshots. */
  stateVersion?: number;
  lastAggressorSeat: number;
  previousBigBlindSeat: number;
  deadSmallBlind: boolean;
  deadButton: boolean;
  /** F11 / F13 (2026-10-21) — optional: older snapshots lack them. */
  smallBlindSeat?: number;
  blindHolders?: { sb: string; bb: string } | null;
  seatHoldersAtLastDeal?: string[] | null;
  dealtOutSeats?: number[];
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
    /** F1 (2026-10-21) — optional: older snapshots lack it (rehydrate keeps the seat's 0). */
    deadMoneyThisHand?: number;
  }>;
  sittingOutSeats: number[];
  deck: { commitment: { seed: string; hash: string; handNumber: number } | null; currentIndex: number };
  actionLog: ActionLogEntry[];
  startChips: Array<[number, number]>;
}
