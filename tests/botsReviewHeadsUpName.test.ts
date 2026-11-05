/**
 * Bots review 2026-11-04 — the Heads-Up bot never takes the player's own name.
 *
 * Before: quickHeadsUp picked its one bot with a bare generateRandomProfile,
 * so a player whose display name is one of the BOT_NAMES drew a same-named
 * opponent in about 1 of 90 Heads-Up games (Spin & Go and All-In or Fold seed
 * their used names with the player's name; this pick did not).
 * Now: a bounded re-roll (50, as fillWithAI's) on an exact, case-sensitive
 * match. Name lists and labels are untouched.
 *
 * REAL src/index.ts handler text on a REAL 2-seat PokerTable (guest socket: no
 * buy-in path).
 */
import { PokerTable } from '../src/game/PokerTable';
import { handlerSrc, load, flush } from './helpers/indexSource';

const HU = handlerSrc('quickHeadsUp', '\n  });\n');

function world(names: string[]) {
  const tables = new Map<string, PokerTable>();
  const aiProfiles = new Map<string, Map<number, any>>();
  let picks = 0;
  const scope: Record<string, unknown> = {
    quickPlayRateLimited: () => false, blockedByMaintenance: () => false, assertPlayable: async () => null, emitPlayRefusal() {},
    buyInSocketGone: async () => false, seatNameForSocket: () => 'Mike',
    playerSessions: new Map(), authSessions: new Map(), handlePlayerLeave() {},
    tableManager: {
      createHeadsUpTable: (name: string) => {
        const t = new PokerTable({ tableId: 'hu1', tableName: name, smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 1000, maxPlayers: 2 } as any);
        tables.set('hu1', t);
        return 'hu1';
      },
      getTable: (id: string) => tables.get(id),
    },
    quickTables: new Set(), quickGameTimers: new Map(), aiProfiles,
    uuidv4: () => 'x', detachSocketFromOtherTables() {}, progressionManager: { getOrCreateProgress() {} }, ensureTableProgressListener() {},
    generateRandomProfile: () => { const n = names[Math.min(picks, names.length - 1)]; picks++; return { botName: n }; },
    registerQuickGame() {}, broadcastGameState() {}, sendProgressToPlayer() {}, scheduleAIAction() {}, quickGameTimeUp() {},
    console: { log() {}, warn() {}, error() {} },
  };
  const { exports: m, stubbed } = load(`function wire(socket) {\n  ${HU}\n}`, scope, '{ wire }');
  const handlers: Record<string, (...a: any[]) => any> = {};
  const socket: any = { id: 'S1', handlers, on: (ev: string, fn: any) => { handlers[ev] = fn; }, emit() {}, join() {}, leave() {} };
  m.wire(socket);
  return { tables, aiProfiles, socket, stubbed, picks: () => picks };
}

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('quickHeadsUp — the bot is never named after the player', () => {
  it('the first pick is the player\'s own name ("Mike"): re-rolled, seat 1 is "Rex" (0dc1b96: "Mike" vs "Mike")', async () => {
    const w = world(['Mike', 'Rex']);
    await w.socket.handlers.quickHeadsUp({ playerName: 'Mike' });
    await flush();
    const t = w.tables.get('hu1')!;
    expect(t.seats[0]).toMatchObject({ state: 'occupied', isAI: false, playerName: 'Mike' });
    expect(t.seats[1]).toMatchObject({ state: 'occupied', isAI: true, playerName: 'Rex' });
    expect(w.aiProfiles.get('hu1')!.get(1)).toEqual({ botName: 'Rex' });
    expect(w.picks()).toBe(2);
    expect([...w.stubbed].filter((s) => /generateRandomProfile|seatNameForSocket/.test(s))).toEqual([]);
  });

  it('GUARD (passes at 0dc1b96 too) — a different first pick is kept (one pick, unchanged)', async () => {
    const w = world(['Ace', 'Rex']);
    await w.socket.handlers.quickHeadsUp({ playerName: 'Mike' });
    await flush();
    expect(w.tables.get('hu1')!.seats[1].playerName).toBe('Ace');
    expect(w.picks()).toBe(1);
  });

  it('a generator that only ever answers "Mike": bounded — the bot is still seated after 51 picks (never an endless loop)', async () => {
    const w = world(['Mike']);
    await w.socket.handlers.quickHeadsUp({ playerName: 'Mike' });
    await flush();
    expect(w.picks()).toBe(51);
    expect(w.tables.get('hu1')!.seats[1]).toMatchObject({ state: 'occupied', isAI: true });
  });

  it('GUARD (passes at 0dc1b96 too) — the match is exact and case-sensitive (the sibling formats\' Set.has): "mike" is kept', async () => {
    const w = world(['mike', 'Rex']);
    await w.socket.handlers.quickHeadsUp({ playerName: 'Mike' });
    await flush();
    expect(w.tables.get('hu1')!.seats[1].playerName).toBe('mike');
    expect(w.picks()).toBe(1);
  });
});
