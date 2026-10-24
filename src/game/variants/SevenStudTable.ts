import { Card, Rank } from '../Card';
import { evaluateHand, HandResult, compareTo } from '../HandEvaluator';
import { evaluateRazzHand, compareRazzHands } from '../HandEvaluatorExtensions';
import { SidePotManager } from '../SidePotManager';
import {
  PokerTable,
  MAX_SEATS,
  GamePhase,
  TableConfig,
  HandWinResult,
  WinnerInfo,
  ShowdownHandInfo,
  PokerTableSnapshot,
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
    // Deck-safety cap (matches the historically advertised lobby count):
    // 8×7 = 56 > 52, so 8-handed already relies on the shared-7th-card
    // community fallback below; 9-handed would overrun it. Cap at 8.
    this.maxOccupiableSeats = 8;
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
      if (this.currentBetToMatch < complete) {
        // 2026-10-11 (R2) — facing only the (posted) bring-in, the one raise is
        // the COMPLETION to the small bet: any larger request completes to
        // exactly it, and the next raise is a full small bet more.
        // 2026-10-21 (gameplay G167) — also after a short all-in between the
        // bring-in and the completion (e.g. 40 at 25/50): the completion is
        // the round's first FULL bet. It was refused there (the base min-raise
        // read 40 + 25 = 65 while the cap was 50, so no raise could pass).
        if (totalRaiseAmount < complete) return false;
        return this.withCompletionAsFullBet(seatIndex, () => super.playerRaise(seatIndex, complete));
      }
    }
    return super.playerRaise(seatIndex, totalRaiseAmount);
  }

  /**
   * G167 — Third Street while the most anyone has put in is below the
   * completion: only the bring-in, or short all-ins between it and the
   * completion. The completion is still to be made.
   */
  private completionPending(): boolean {
    return this.currentPhase === GamePhase.ThirdStreet
      && this.currentBetToMatch > 0
      && this.currentBetToMatch < this.getCompleteAmount();
  }

  /**
   * G167 — while the completion is pending, the minimum raise IS the
   * completion (the game state's minRaise; the base would add the bring-in's
   * increment to a short all-in: 40 + 25 = 65 above the 50 cap).
   */
  getMinRaise(): number {
    if (this.completionPending()) return this.getCompleteAmount();
    return super.getMinRaise();
  }

  /**
   * G167 — All-In while the completion is pending. A stack deeper than the
   * completion is capped AT it (getMaxRaise), so the shove is the completion
   * itself: made as one (a full bet that reopens the betting and is a bet
   * level). It used to land as a non-full "raise" that reopened nothing, took
   * the bring-in's and the callers' re-raise away and left a 25-chip raise
   * increment in a 50-chip game. A stack that does not reach past the
   * completion stays a real all-in (a short one, or exactly the completion).
   * A seat the betting was not reopened to still only calls (base, TDA 41).
   */
  playerAllIn(seatIndex: number): boolean {
    if (!this.completionPending()) return super.playerAllIn(seatIndex);
    const complete = this.getCompleteAmount();
    const seat = this.seats[seatIndex];
    if (seat && this.isValidAction(seatIndex) && this.canRaise(seatIndex) && seat.chipCount + seat.currentBet > complete) {
      return this.playerRaise(seatIndex, complete);
    }
    return this.withCompletionAsFullBet(seatIndex, () => super.playerAllIn(seatIndex));
  }

  /**
   * G167 — run a bet while the completion is pending with the completion
   * counting as a FULL bet: the raise increment is set to what is left to the
   * completion (so the base marks it a full raise — everyone else's action is
   * reopened and betLevelsThisStreet counts it), then the street's real
   * increment is restored: the small bet once the completion is in, otherwise
   * the increment from before (a short all-in under the completion reopens
   * nothing). The TDA 41 lock is read against the real increment first: a
   * seat that already acted and faces only short all-ins still only calls.
   * Nothing is touched once the action ended the street or the hand.
   */
  private withCompletionAsFullBet(seatIndex: number, act: () => boolean): boolean {
    const complete = this.getCompleteAmount();
    const prev = this.lastRaiseAmount;
    const hand = this.handNumber;
    const seat = this.seats[seatIndex];
    if (seat && !this.raiseLockedFor(seat)) {
      this.lastRaiseAmount = Math.max(1, complete - this.currentBetToMatch);
    }
    const ok = act();
    if (this.handNumber === hand && this.currentPhase === GamePhase.ThirdStreet) {
      this.lastRaiseAmount = this.currentBetToMatch >= complete ? complete : prev;
    }
    return ok;
  }

  /**
   * 2026-10-11 (.online R2, GAME P3) — the bring-in is a FORCED bet. It used to
   * be optional: the low door card was handed the action at 0 to match and
   * could simply check (and the engine refused a bring-in-sized bet anyway —
   * under the one-big-blind opening minimum — so only a completion was
   * possible). Now the bring-in seat posts it when Third Street is dealt, like a
   * blind (all-in for less on a short stack), and the action starts on its left:
   * fold, call the bring-in, or complete to the small bet. The bring-in seat has
   * acted (no option of its own unless someone completes). Not a bet level for
   * the fixed-limit cap — the completion is.
   * G168 (2026-10-21): startNewHand then hands the bring-in seat the FIRST
   * decision (stay or complete) whenever someone else is left to act.
   */
  private postBringIn(seatIndex: number): number {
    const seat = this.seats[seatIndex];
    if (!seat || seat.state !== 'occupied' || seat.folded || seat.allIn) return 0;
    const amount = Math.min(this.getBringInAmount(), seat.chipCount);
    if (amount <= 0) return 0;
    seat.chipCount -= amount;
    seat.currentBet = amount;
    seat.totalInvestedThisHand += amount;
    if (seat.chipCount === 0) seat.allIn = true;
    seat.hasActedSinceLastFullRaise = true;
    this.currentBetToMatch = amount;
    // Completing to the small bet is the minimum (and, fixed limit, the only) raise.
    this.lastRaiseAmount = Math.max(1, this.getCompleteAmount() - amount);
    this.actionLog.push({ seatIndex, playerName: seat.playerName, action: `posted bring-in ${amount}` });
    this.emit('blindPosted', { seatIndex, amount, type: 'bring-in' });
    return amount;
  }

  /**
   * Fixed limit, with the Third Street exception: facing only the bring-in the
   * most anyone may put in is the completion (an "all-in" there completes).
   */
  protected getMaxRaise(_seatIndex: number): number {
    if (this.currentPhase === GamePhase.ThirdStreet && this.currentBetToMatch > 0 && this.currentBetToMatch < this.getCompleteAmount()) {
      return this.getCompleteAmount();
    }
    return this.currentBetToMatch + this.getFixedLimitBetSize();
  }

  /**
   * 2026-10-21 (gameplay F30) — the street's fixed-limit bet: the small bet
   * (one big blind) on 3rd and 4th street, the big bet (two) on 5th-7th. The
   * base resetBettingRound makes it the street's raise size, so the opening bet
   * on 5th street is exactly the big bet (a half-size bet used to be accepted).
   */
  protected getFixedLimitBetSize(): number {
    const isLateRound = [
      GamePhase.FifthStreet,
      GamePhase.SixthStreet,
      GamePhase.SeventhStreet,
    ].includes(this.currentPhase);
    return isLateRound ? this.handBB() * 2 : this.handBB();
  }

  /** F13 (2026-10-21) — Stud has no blinds: a new player is dealt into any hand (no dead zone). */
  protected dealsOutNewSeatsInDeadZone(): boolean {
    return false;
  }

  /**
   * 2026-06-11 audit C13: Stud/Razz are ANTE + BRING-IN games, not blind
   * games. The base postBlinds posted SB/BB and set currentBetToMatch =
   * bigBlind, which (a) charged two seats blinds they never owe and (b)
   * DISABLED the third-street bring-in branch in playerRaise above — that
   * branch keys on `currentBetToMatch === 0`, so a non-zero blind silently
   * routed third street through normal no-limit raise rules.
   *
   * Override to post ONLY the ante (if the table is configured with one) and
   * leave currentBetToMatch at 0. The low-door-card player (getStudFirstActor)
   * is the first actor and posts the bring-in as their action. Antes mirror
   * the base: they hit chipCount + totalInvestedThisHand only (never currentBet
   * or the pot accumulator), so the betting line still starts clean at 0.
   */
  protected postBlinds(): void {
    if (this.config.ante > 0) {
      for (const seatIdx of this.getActivePlayerSeats()) {
        // 2026-07-05 audit P1 fix: getActivePlayerSeats() includes sitting-out
        // seats (they're tracked separately), so without this guard the Stud/Razz
        // ante drained a non-participant's stack every hand — the base ante loop
        // has the identical guard (PokerTable '#8' fix); this override lacked it.
        if (this.isSittingOut(seatIdx)) continue;
        const seat = this.seats[seatIdx];
        const anteAmount = Math.min(this.config.ante, seat.chipCount);
        if (anteAmount > 0) {
          seat.chipCount -= anteAmount;
          seat.totalInvestedThisHand += anteAmount;
          if (seat.chipCount === 0) seat.allIn = true;
          this.logAntePosted(seatIdx, anteAmount);   // Sit & Go fix-all F1 (2026-10-24): antes are in the hand history
          this.emit('blindPosted', { seatIndex: seatIdx, amount: anteAmount, type: 'ante' });
        }
      }
    }
    // No SB/BB; currentBetToMatch stays 0 (reset in startNewHand) so the
    // ThirdStreet bring-in/complete validation fires.
  }

  /**
   * 2026-10-21 (gameplay F38) — Stud / Razz / Stud 8 have NO blinds, so a
   * player who sits out misses none: no missed-blind debt accrues here. The
   * base marked the would-be SB / BB seats anyway (from the button) and this
   * game never collects it (postBlinds above posts antes only): every state
   * then carried a permanent "Post Blinds: N" debt, and tapping it moved N of
   * his chips into the pot as dead money.
   */
  protected markSittingOutBlinds(): void {
    /* ante + bring-in game: nothing is ever owed for sitting out */
  }

  /** F38 — nothing is owed in a game without blinds: any stray debt is cleared, never charged. */
  postOwedBlindsNow(seatIndex: number): { ok: boolean; amount?: number; reason?: string } {
    if (seatIndex < 0 || seatIndex >= this.seats.length || this.seats[seatIndex].state === 'empty') {
      return { ok: false, reason: 'invalid_seat' };
    }
    this.clearDeadBlind(seatIndex);
    return { ok: false, reason: 'no_debt' };
  }

  /** F22 (2026-10-21) — on Third Street the bring-in is the forced bet a leaver's fold never takes away. */
  protected forcedBetOfRound(): number {
    return this.currentPhase === GamePhase.ThirdStreet ? this.getBringInAmount() : 0;
  }

  /** F22 — facing only the bring-in again, the one raise is the completion (as postBringIn sets it). */
  protected raiseIncrementAfterLoweredBet(toMatch: number): number {
    const complete = this.getCompleteAmount();
    if (this.currentPhase === GamePhase.ThirdStreet && toMatch > 0 && toMatch < complete) {
      return Math.max(1, complete - toMatch);
    }
    return super.raiseIncrementAfterLoweredBet(toMatch);
  }

  /**
   * Override: use stud/razz evaluation.
   */
  protected evaluatePlayerHand(holeCards: Card[], communityCards: Card[]): HandResult {
    // 2026-06-11 audit R5: 8-handed stud can exhaust the 52-card deck on 7th
    // street (8×7=56 > 52). When it does, dealStudCards turns a single shared
    // COMMUNITY card and every remaining player counts it as their 7th card —
    // so include it in the evaluation. For a normal hand communityCards is
    // empty, making this a no-op (the usual 7 hole cards).
    const cards = communityCards && communityCards.length > 0
      ? [...holeCards, ...communityCards]
      : holeCards;
    if (this.variant.isRazz) {
      return evaluateRazzHand(cards);
    }
    return evaluateHand(cards);
  }

  /**
   * 2026-06-11 audit G2: Razz is lowball — best low hand wins. Razz forces
   * isHiLo=false, so it runs the BASE determineWinners → awardPots path;
   * without this override that path ranked Razz hands with the HIGH
   * comparator and awarded the WORST hand. compareRazzHands returns NEGATIVE
   * when `a` is the better low, so invert to the positive-wins contract.
   * Regular Seven Card Stud is high (inherits compareTo). Stud Hi-Lo has its
   * own determineWinners override and never reaches this comparator.
   */
  protected getHandComparator(): (a: HandResult, b: HandResult) => number {
    if (this.variant.isRazz) {
      return (a: HandResult, b: HandResult) => -compareRazzHands(a, b);
    }
    return super.getHandComparator();
  }

  /**
   * 2026-06-11 audit R9: cardVisibility (which stud cards are face-up) + the
   * stud street progress are NOT base-class state. After a Railway redeploy
   * mid-hand, all up-cards rendered hidden and the bring-in / high-board logic
   * read an empty up-card set. Persist + restore them.
   */
  serializeSnapshot(): PokerTableSnapshot {
    const snap = super.serializeSnapshot();
    (snap as any).variantState = {
      cardVisibility: Array.from(this.cardVisibility.entries()),
      currentStudPhase: this.currentStudPhase,
      studStreetIndex: (this as any).studStreetIndex,
    };
    return snap;
  }

  rehydrateFromSnapshot(snap: PokerTableSnapshot): void {
    super.rehydrateFromSnapshot(snap);
    const vs = (snap as any).variantState;
    if (vs) {
      if (Array.isArray(vs.cardVisibility)) this.cardVisibility = new Map(vs.cardVisibility);
      if (vs.currentStudPhase !== undefined) this.currentStudPhase = vs.currentStudPhase;
      if (typeof vs.studStreetIndex === 'number') (this as any).studStreetIndex = vs.studStreetIndex;
    }
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

    // GAME-10 (R2) — a seat with no cards never contests the pot (as the base award).
    const seatInfos = this.seats
      .filter(s => s.state === 'occupied' && !s.eliminated && s.totalInvestedThisHand > 0)
      .map(s => ({ seatIndex: s.seatIndex, invested: s.totalInvestedThisHand, folded: s.folded || s.holeCards.length === 0, holeCards: [...s.holeCards] }));

    // Evaluate every non-folded player's high and low hands. 2026-10-21
    // (gameplay F32) — with the SHARED 7th-street card when the deck ran short
    // (8-handed: dealStudCards turns one community card everyone counts as his
    // 7th, R5): it was left out here, so a full house or a wheel made with it
    // lost the pot. communityCards is empty in every other hand (no change).
    const evaluations = seatInfos
      .filter(s => !s.folded)
      .map(s => {
        const cards = [...s.holeCards, ...this.communityCards];
        return {
          seatIndex: s.seatIndex,
          high: evaluateHand(cards),
          low: evaluateLowHand(cards),
        };
      });

    if (evaluations.length === 0) {
      super.determineWinners();
      return;
    }

    // 2026-10-11 (.online R1, APPUI-2 class) — reveal NOTHING for an
    // UNCONTESTED pot (everyone else folded): this override used to put the
    // lone winner's hole cards (down cards included) and his hand's name into
    // the hand result every player's state carries. The award below is
    // unchanged; only a CONTESTED showdown (>= 2 tabled) reveals hands — the
    // base rule, which also lets getGameStateForPlayer show the tabled seats.
    const contested = evaluations.length >= 2;
    if (contested) this.wentToShowdown = true;

    // Build pot tiers using the manager
    const pots = this.sidePotManager.calculatePots(
      this.seats.filter(s => s.state === 'occupied' && !s.eliminated).map(s => ({
        seatIndex: s.seatIndex,
        chipCount: s.chipCount,
        totalInvestedThisHand: s.totalInvestedThisHand,
        folded: s.folded || s.holeCards.length === 0,
        allIn: s.allIn,
        holeCards: s.holeCards,
        state: s.state,
      }))
    );

    const winnerInfos: WinnerInfo[] = [];
    const showdownHands: ShowdownHandInfo[] = [];
    const results: HandWinResult[] = [];

    for (const ev of contested ? evaluations : []) {
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

    // R1 — an uncontested winner's strength is not public either.
    if (!contested) {
      for (const w of winnerInfos) { w.handName = 'Won by fold'; w.bestFiveCards = []; }
    }

    this.lastHandResult = {
      handNumber: this.handNumber,
      winners: winnerInfos,
      showdownHands,
      // F32 — the shared 7th-street card, as the base result reports it (empty in a normal hand).
      communityCards: [...this.communityCards],
      // 2026-10-21 (gameplay F19 / F20 / F23) — the shared per-pot list (exact
      // pot names — a bare prefix matched 'Side Pot 10' to 'Side Pot 1' — and
      // a scooper's high + low halves summed into one entry).
      pots: this.buildPotBreakdown(pots, results, contested ? null : evaluations[0].seatIndex),
    };

    for (const seat of this.seats) {
      seat.totalInvestedThisHand = 0;
    }
    this.currentPhase = GamePhase.HandComplete;
    this.activeSeatIndex = -1;
    // 2026-10-10 — through the base completion: emits handResult AND reveals
    // this hand's deck seed (it never did — Stud hi-lo hands could not be
    // verified on /api/fairness), with startNewHand refused meanwhile (P2).
    // No handHistory record here (unchanged).
    this.emitHandCompletion(results, null);
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
    // We'll deal them here and then the game starts on ThirdStreet betting.
    // 2026-10-11 (R2, GAME P3) — never to a SITTING-OUT seat (startNewHand
    // starts it folded; the base deal skips it — this override dealt it cards).
    const activePlayers = this.seats.filter(
      s => s.state === 'occupied' && !s.eliminated && s.chipCount >= 0 && !s.folded
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
    // F1 (2026-10-10): a nested call is refused by the base class — never reset this hand's stud state for it.
    // P2: likewise a call made while the previous hand is still completing (its handResult listeners).
    if (this.isStartingHand() || this.isCompletingHand()) return super.startNewHand();
    this.cardVisibility.clear();
    this.currentStudPhase = 'ThirdStreet';
    this.studStreetIndex = 0;

    const result = super.startNewHand();
    // (R2) only a hand still waiting on its first round — an all-in-on-the-antes
    // deal the base start already ran out must not be put back on Third Street.
    if (result && this.currentPhase === GamePhase.PreFlop) {
      // Override the phase to ThirdStreet since stud starts there
      this.currentPhase = GamePhase.ThirdStreet;
      this.emit('phaseChanged', { phase: this.currentPhase });

      // The low (Razz: high) door card brings it in — a forced bet (R2).
      // 2026-10-21 (gameplay G168) — and then HE decides first: stay at the
      // bring-in (a check — what a timeout / an absent seat does, the chips
      // are already posted) or complete to the small bet (the Third Street
      // raise branch above). It used to be marked as acted with the action
      // handed to its left, so the low card could never open for the full
      // bet. If the field only calls, the round still ends with no second
      // option for him (the stud rule); a completion reopens it as usual.
      const bringInSeat = this.getStudFirstActor();
      if (bringInSeat >= 0) {
        this.postBringIn(bringInSeat);
        const next = this.nextActor(bringInSeat);
        if (next >= 0) {
          const bringer = this.seats[bringInSeat];
          if (this.canAct(bringer)) {
            bringer.hasActedSinceLastFullRaise = false;   // his decision is still to come
            this.activeSeatIndex = bringInSeat;
          } else {
            this.activeSeatIndex = next;                  // all-in on the bring-in: the action starts on its left
          }
          this.emit('turnChanged', { seatIndex: this.activeSeatIndex });
        } else {
          // Nobody else can act (all-in on the antes): the round is over.
          this.activeSeatIndex = -1;
          this.accumulateInvestments();
          this.advanceToNextStreet();
        }
      }
    }
    return result;
  }

  /**
   * Deal stud cards for a phase.
   */
  private dealStudCards(phase: VariantPhase): void {
    this.currentStudPhase = phase;
    // GAME-10 (R2) — only seats dealt into this hand get the later streets (a
    // mid-hand joiner — no ante, no Third Street cards — used to be dealt 4th-7th).
    const activePlayers = this.seats.filter(
      s => s.state === 'occupied' && !s.folded && !s.eliminated && s.holeCards.length > 0
    );

    if (phase === 'ThirdStreet') {
      // Already dealt in dealHoleCardsImpl, nothing to do
      return;
    }

    if (phase === 'SeventhStreet') {
      // 2026-06-11 audit R5: 8-handed stud can exhaust the 52-card deck before
      // every remaining player gets an individual 7th card (8×7=56 > 52). TDA:
      // when the deck can't deal one card per active player, turn a SINGLE
      // face-up community card that all remaining players share as their 7th
      // card instead (evaluatePlayerHand folds it into each hand).
      if (this.deck.cardsRemaining() < activePlayers.length) {
        const community = this.deck.dealOne();
        if (community) {
          this.communityCards.push(community);
          this.emit('communityCard', { card: community, total: this.communityCards.length });
        }
      } else {
        // 1 face-down card each
        for (const seat of activePlayers) {
          const vis = this.cardVisibility.get(seat.seatIndex) || [];
          const card = this.deck.dealOne();
          if (card) {
            seat.holeCards.push(card);
            vis.push(false);
            this.cardVisibility.set(seat.seatIndex, vis);
          }
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
   * For Razz: highest showing card (worst low; the Ace is LOW — F36) brings it in.
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
    // GAME-10 (R2) — a seat with no cards (a mid-hand joiner) is never handed the action.
    const activePlayers = this.seats.filter(
      s => s.state === 'occupied' && !s.folded && !s.allIn && !s.eliminated && s.holeCards.length > 0
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
          // Razz: highest card brings in; ties → highest suit. 2026-10-21
          // (gameplay F36) — the ACE is the LOWEST Razz card (it was compared
          // as 14, so an Ace door card was forced to bring it in): a King brings it in.
          const vA = this.orderRank(cardA.rank);
          const vB = this.orderRank(cardB.rank);
          if (vA > vB) {
            target = seat;
          } else if (vA === vB && suitA > suitB) {
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

    // 4th+ street: the best EXPOSED poker hand acts first (Stud), or the
    // lowest exposed board (Razz). 2026-06-11 audit R4: this previously
    // compared only the single highest face-up card, so a split pair showing
    // (e.g. 8-8) did NOT act before a player showing a lone Ace — wrong per
    // TDA (a pair showing beats ace-high). Score the up-cards as a partial
    // poker hand (trips > pair > high card, then kickers) and pick the max
    // (Stud) / min (Razz).
    let target = activePlayers[0];
    let bestScore = this.scoreExposedBoard(this.getFaceUpCards(target.seatIndex));
    for (const seat of activePlayers) {
      const score = this.scoreExposedBoard(this.getFaceUpCards(seat.seatIndex));
      if (this.variant.isRazz ? score < bestScore : score > bestScore) {
        target = seat;
        bestScore = score;
      }
    }
    return target.seatIndex;
  }

  /**
   * Score a set of exposed (face-up) cards as a partial poker hand for Stud
   * action order. The made tier dominates (quads 6 > trips 4 > two pair 3 >
   * pair 2 > high card 1), then the ranks group by group (count desc, rank
   * desc: top pair, second pair, kicker …). Lets the BEST board act first
   * (Stud) or the LOWEST act first (Razz) — not just the single highest card.
   * Not a full hand evaluator; only a total order over boards (at most 4 up
   * cards, so no full house; straights / flushes do not count for the order).
   * 2026-10-21 (gameplay F37) — two pair is its own tier: it scored as the
   * top pair alone, so A-A-2-3 showing acted before K-K-5-5. (F36) Razz
   * counts the Ace LOW (A-2 showing is the best Razz board, not ace-high).
   */
  private scoreExposedBoard(cards: Card[]): number {
    if (!cards || cards.length === 0) return 0;
    const counts = new Map<number, number>();
    for (const c of cards) {
      const v = this.orderRank(c.rank);
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    const groups = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
    const top = groups[0][1];
    const pairs = groups.filter(([, n]) => n === 2).length;
    const tier = top >= 4 ? 6 : top === 3 ? 4 : pairs >= 2 ? 3 : top === 2 ? 2 : 1;
    let score = tier * 1e12;
    for (let i = 0; i < groups.length && i < 4; i++) {
      score += groups[i][0] * Math.pow(20, 3 - i);
    }
    return score;
  }

  /**
   * F36 (2026-10-21) — a card's rank for Stud ACTION ORDER: the Ace is low (1)
   * in Razz (ace-to-five), high (14) in Seven Card Stud and Stud 8 (where the
   * Ace counts high for the bring-in and the high board).
   */
  private orderRank(rank: number): number {
    return this.variant.isRazz && rank === Rank.Ace ? 1 : rank;
  }
}
