/**
 * Bots review fix round 2 (2026-11-05, critic) — /api/health gates EVERY Railway deploy
 * (railway.json healthcheckPath, 120 s): a deployment goes live only on a 200.
 *
 * The bots review added sections to the body (crashSafety.gameTimers, economy.botFlow
 * / handRewards, engine.seatTeardown.lastHumanBotStrips / botStacks.humansTookFromBots
 * + liveChips / joinSeats / commentary, r2Play.quickGames.byFormat / clubTables) and
 * the handler was never executed: a throw while building any of them (liveBotChips()
 * walks every table) reached the handler's catch and answered 503 'unhealthy' — the
 * new build would never have gone live. Now each of those sections is built by
 * healthSection: a throw, or a value JSON cannot carry, answers { error } for that
 * section alone (counted in healthSectionErrors, logged once per section) and the
 * 200 stands. The DB ping still answers 503 — that gate is wanted.
 *
 * The REAL route and helper are sliced from src/index.ts and executed with a fake
 * Express app; the body goes through JSON as Express sends it.
 *
 * Fails on d1ec56a: there is no healthSection there (the slice throws), and the same
 * handler with a throwing liveBotChips answers 503 (see CONTROL (4)).
 */
import { slice, load } from './helpers/indexSource';

const HELPER = slice('const healthSectionStats = { errors: 0 };', '\n}\n');
const ROUTE = slice("app.get('/api/health', async (_req, res) => {", '\n});\n');

interface Opts { liveBotChips?: () => number; botFlowFormats?: any; joinSeatStats?: any; dbFails?: boolean }
function health(opts: Opts = {}) {
  let handler: ((req: unknown, res: unknown) => Promise<void>) | null = null;
  const errors: string[] = [];
  const formats = opts.botFlowFormats ?? new Map([['cash:texas-holdem', { hands: 3, humanNet: -50, humanWon: 20, humanLost: 70, accountNet: -50, guestNet: 0 }]]);
  const scope: Record<string, unknown> = {
    app: { get: (p: string, h: any) => { if (p === '/api/health') handler = h; } },
    getPool: () => ({ query: async () => { if (opts.dbFails) throw new Error('connect ECONNREFUSED'); return { rows: [{ '?column?': 1 }] }; } }),
    pingRedis: async () => 'PONG',
    setTimeout: () => 0,
    pruneBrokenTournamentTables() {}, deployedCommitOf: () => null,
    tableManager: { getTableList: () => [{ tableId: 'T1' }, { tableId: 'T2' }], getAllTableIds: () => ['T1', 'T2'], getTable: () => undefined },
    gameTimerGuardStats: { actionThrows: 0, drawThrows: 0, autoStartThrows: 0, heartbeatThrows: 0, turnClockThrows: 0, drawClockThrows: 0, lastAt: null },
    // fix round 4 — the hands held in Showdown now
    heldShowdownsNow: () => [{ tableId: 'T1', handNumber: 7, since: '2026-11-08T00:00:00.000Z', reason: 'unreadable_stakes' }],
    botFlowStats: { since: '2026-11-05T00:00:00.000Z', formats },
    handRewardStats: { xpSkipped: 1, xpReduced: 0, scratchTicksSkipped: 1, walksNotCounted: 0, scratchAwarded: 2, scratchCapped: 0, capNotices: 0 },
    IDLE_HANDS_REWARD_LIMIT: 30, SCRATCH_CARDS_PER_DAY: 10, HAND_XP_FULL_PER_DAY: 1000,
    scratchCapColumnState: { alterFailed: false, alterFailures: 0, uncappedTicks: 0, lastError: null },
    seatTeardownStats: { deferred: 0, stoodUp: 1, allInKept: 0, foldedOnClock: 0, foldedOutOfTurn: 0, awardedUncontested: 0, departureKept: 0, lastHumanBotStrips: 2 },
    pendingSeatRemovalAfterHand: new Map(),
    botStackStats: { reloads: 0, minted: 100, caps: 0, burned: 0, fixedRosterReloadsSkipped: 0, seatedChips: 1000, seatedBy: { ring: 1000, quick: 0 }, removedChips: 0, removedBy: {} },
    BOT_STACK_CAP_BUYINS: 0,
    liveBotChips: opts.liveBotChips ?? (() => 1150),
    joinSeatStats: opts.joinSeatStats ?? { plannedBotTaken: 1, plannedBotLost: 0, preCheckRefused: 0 },
    TABLE_COMMENTARY_MIN_INTERVAL_MS: 60000, tableCommentaryStats: { calls: 0, delivered: 0, emptyReplies: 0, failed: 0, skippedNoAudience: 3 },
    quickGameStats: { started: 2, ended: 1, byFormat: { headsUp: { started: 1, humanWins: 0 }, spinGo: { started: 1, humanWins: 1 } } },
    quickGames: new Map([['Q1', {}]]),
    clubTableRuntimeStats: { recreated: 0, refusedInvalid: 0, closedUnbound: 0, recreateSkippedNotMember: 0, idleDealsSkipped: 4 },
    console: { log() {}, warn() {}, error: (m: unknown) => errors.push(String(m)) },
  };
  load(`${HELPER}\n${ROUTE}`, scope, '{}');
  const call = async () => {
    let status = 200;
    let body: any = null;
    const res = { json: (b: unknown) => { body = b; }, status: (c: number) => ({ json: (b: unknown) => { status = c; body = b; } }) };
    await handler!({}, res);
    return { status, body: JSON.parse(JSON.stringify(body)) };   // as Express sends it
  };
  return { call, errors, scope };
}

describe('/api/health — the bots-review sections are built fail-safe; the deploy gate stays a 200', () => {
  it('(1) normal: 200 with every new field present and sane', async () => {
    const h = health();
    const { status, body } = await h.call();
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.crashSafety.gameTimers).toMatchObject({ turnClockThrows: 0, drawClockThrows: 0, autoStartThrows: 0 });
    expect(body.crashSafety.heldShowdowns).toEqual([{ tableId: 'T1', handNumber: 7, since: '2026-11-08T00:00:00.000Z', reason: 'unreadable_stakes' }]);   // fix round 4
    expect(body.economy.botFlow).toEqual({ since: '2026-11-05T00:00:00.000Z', totalHumanNet: -50, totalAccountNet: -50, formats: { 'cash:texas-holdem': expect.objectContaining({ hands: 3, humanNet: -50 }) } });
    expect(body.economy.handRewards).toMatchObject({ idleHandsLimit: 30, scratchCardsPerDay: 10, handXpFullPerDay: 1000, scratchAwarded: 2,
      scratchCapColumns: { alterFailed: false, alterFailures: 0, uncappedTicks: 0, lastError: null } });
    expect(body.engine.seatTeardown).toMatchObject({ lastHumanBotStrips: 2, pendingTables: 0 });
    expect(body.engine.botStacks).toMatchObject({ liveChips: 1150, humansTookFromBots: 1000 + 100 - 0 - 0 - 1150, capBuyIns: 0 });
    expect(body.engine.joinSeats).toEqual({ plannedBotTaken: 1, plannedBotLost: 0, preCheckRefused: 0 });
    expect(body.engine.commentary).toEqual({ keyConfigured: !!process.env.ANTHROPIC_API_KEY, minIntervalMs: 60000, calls: 0, delivered: 0, emptyReplies: 0, failed: 0, skippedNoAudience: 3 });
    expect(body.r2Play.quickGames).toMatchObject({ live: 1, byFormat: { spinGo: { started: 1, humanWins: 1 } } });
    expect(body.r2Play.clubTables).toMatchObject({ idleDealsSkipped: 4 });
    expect(body.healthSectionErrors).toBe(0);
    expect(h.errors).toEqual([]);
  });

  it('(2) liveBotChips throws: still 200 — engine.botStacks answers { error }, every other section intact; counted; logged once per section', async () => {
    const h = health({ liveBotChips: () => { throw new TypeError("Cannot read properties of undefined (reading 'seats')"); } });
    const first = await h.call();
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('ok');
    expect(first.body.engine.botStacks).toEqual({ error: "health section engine.botStacks failed: Cannot read properties of undefined (reading 'seats')" });
    expect(first.body.engine.joinSeats).toEqual({ plannedBotTaken: 1, plannedBotLost: 0, preCheckRefused: 0 });
    expect(first.body.economy.botFlow.totalHumanNet).toBe(-50);
    expect(first.body.healthSectionErrors).toBe(1);
    const second = await h.call();
    expect(second.status).toBe(200);
    expect(second.body.healthSectionErrors).toBe(2);
    expect(h.errors.filter((l) => l.startsWith('[health-section-error] '))).toHaveLength(1);
    expect(JSON.parse(h.errors[0].slice('[health-section-error] '.length))).toMatchObject({ section: 'engine.botStacks' });
  });

  it('(3) a broken bot-flow map and a value JSON cannot carry (a BigInt): those sections answer { error }; the response is still a 200', async () => {
    const h = health({
      botFlowFormats: { values: () => { throw new Error('formats is not a Map'); } },
      joinSeatStats: { plannedBotTaken: BigInt(1), plannedBotLost: 0, preCheckRefused: 0 },
    });
    const { status, body } = await h.call();
    expect(status).toBe(200);
    expect(body.economy.botFlow).toEqual({ error: 'health section economy.botFlow failed: formats is not a Map' });
    expect(body.engine.joinSeats.error).toMatch(/^health section engine\.joinSeats failed: .*BigInt/);
    expect(body.engine.botStacks.liveChips).toBe(1150);
    expect(body.healthSectionErrors).toBe(2);
  });

  it('(4) CONTROL — the DB ping failing still answers 503 (that gate keeps a deploy with no DB from going live)', async () => {
    const h = health({ dbFails: true });
    const { status, body } = await h.call();
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'unhealthy', error: 'connect ECONNREFUSED' });
  });

  it('(5) the d1ec56a handler shape with the same throwing liveBotChips answers 503: what the deploy gate would have seen', async () => {
    // The route with every healthSection(...) wrapper unwrapped back to its bare expression = d1ec56a's sections.
    const bare = ROUTE.replace(/healthSection\('[^']+', \(\) => ((?:[^()]|\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*)\)/g, '$1');
    expect(bare).not.toContain('healthSection(');
    let handler: any = null;
    const h = health({ liveBotChips: () => { throw new TypeError('boom'); } });
    load(`${HELPER}\n${bare}`, { ...h.scope, app: { get: (p: string, f: any) => { if (p === '/api/health') handler = f; } } }, '{}');
    let status = 200;
    let body: any = null;
    await handler({}, { json: (b: unknown) => { body = b; }, status: (c: number) => ({ json: (b: unknown) => { status = c; body = b; } }) });
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'unhealthy', error: 'boom' });
  });
});
