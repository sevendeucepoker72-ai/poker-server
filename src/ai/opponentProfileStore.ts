import type { OpponentSessionProfile } from './AIPlayer';

/**
 * 2026-11-12 (bots review, Short Deck reset) — THE session opponent-model store: one Map for the whole process.
 *
 * index.ts writes it through AIPlayer.recordOpponentObservation (keyed by opponentModelKey). Both bot decision
 * modules read it: src/ai/AIPlayer.ts (every variant but Short Deck) and the frozen 0dc1b96 copy in
 * src/ai/live0dc1b96/AIPlayer.ts (Short Deck, SHORT_DECK_BOTS_PLAY_LIVE). Live 0dc1b96 had one module and one Map;
 * keeping one Map here keeps that: a Short Deck bot reads the same reads of its opponents that live did (the frozen
 * copy must never get an empty private store). The type import is erased: no runtime import cycle.
 */
export const OPPONENT_PROFILE_STORE: Map<string, OpponentSessionProfile> = new Map();
