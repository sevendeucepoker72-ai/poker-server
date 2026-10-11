/**
 * .online R2 (S3, 2026-10-11) — the REAL economy socket handlers and helpers
 * (sliced from src/index.ts) on a real ProgressionManager, with the economy
 * settlements faked (their SQL is proven in economyPostgres.test.ts):
 *   C5   every lobby economy action pushes the account's DB-fresh progress to
 *        EVERY socket of the account — seated or not (APPUI-4);
 *   C6   claimMission without a seat; claimDailyBonus retired;
 *   C7   catalog-validated purchases / equips, catalog theme price, emotes;
 *   C8   claimVipMonthly; VIP pass record + table re-broadcast;
 *   C9   the automatic season sweep; leaderboard windows (APPUI-50);
 *   C10  getDetailedStats unseated;
 *   ECON-16 Battle Pass premium without a seat, never twice;
 *   ECON-18 every credit audited + LARGE CHIP GRANT ALERT;
 *   APPUI-14 / Addendum profile + friend request by public id;
 *   APPUI-45 / ECON-14 prediction window, bracket bets.
 */
jest.mock('../src/economy/economyDb', () => ({
  loadProgressBundle: jest.fn(async (userId: number) => (globalThis as any).__bundle(userId)),
  settleAchievementReward: jest.fn(async () => ({ status: 'already', chips: 0, stars: 0, balances: null })),
  settleLevelUps: jest.fn(async () => ({ paidLevels: [], chips: 0, stars: 0, balances: { chips: 0, stars: 0, scratchCardsAvailable: 0 } })),
}));
jest.mock('../src/auth/authManager', () => ({
  addChipsToUser: jest.fn(async () => true), addStarsToUser: jest.fn(async () => true), mergeUserStats: jest.fn(async () => {}),
}));

import { SRC, fnSrc, load, flush } from './helpers/indexSource';
import { ProgressionManager, userProgressKey, seasonXpOf } from '../src/progression/ProgressionManager';
import * as catalog from '../src/economy/catalog';
import * as denver from '../src/economy/denverTime';
import { createWindowRateLimiter } from '../src/auth/rateLimit';
import { accountDisplayName } from '../src/auth/displayName';
import { publicNameOf, PUBLIC_NAME_FALLBACK, isPublicDisplayName } from '../src/social/publicIdentity';
import { PokerTable, GamePhase } from '../src/game/PokerTable';
import { missionTemplateIdsFor } from '../src/progression/missions';

function between(start: string, end: string): string {
  const a = SRC.indexOf(start);
  if (a < 0) throw new Error(`not found: ${start}`);
  const b = SRC.indexOf(end, a);
  if (b < 0) throw new Error(`no end: ${end}`);
  return SRC.slice(a, b);
}
const ECON = between('const CURRENT_BATTLE_PASS_SEASON = ', '// R1 contract #4 — showMuckedHand');
const HANDLERS = between('  // ───── Persistence sweep: socket handlers', '  /**\n   * Deep-link from player app: "Play Online"');
const PROGRESSION_EVENTS = between('  // ========== Progression Events ==========', '  // ========== Friends (durable, Postgres)');
const THEME_SHOP = between('  // ========== Theme Shop ==========', '  // ========== Rabbit Hunt ==========');
const EMOTE = between('  // ========== Emote System ==========', '  // ========== Table Reactions ==========');
const SOCIAL = between("  socket.on('getLeaderboard'", '  // ========== Admin Events ==========');
const PROFILE = between("  socket.on('requestProfile'", '  // ========== Tournament System ==========');
const FRIENDS = between('  // ========== Friends (durable, Postgres)', '  // ===== Social Bracket tournaments');
const BRACKET_BET = between("  socket.on('placeSocialSideBet'", '  // 2026-07-07 gap-fill [24] — refund path for an ABANDONED bracket.');
const SEND_PROGRESS = fnSrc('function sendProgressToPlayer(');
const GAME_STATE = fnSrc('function getVariantInfo(') + fnSrc('function getGameStateForPlayer(');

interface Sock { id: string; emitted: Array<[string, any]>; handlers: Record<string, (...a: any[]) => any>; emit: (ev: string, d?: any) => void; on: (ev: string, fn: any) => void; join(): void }
const mkSock = (id: string): Sock => {
  const s: Sock = {
    id, emitted: [], handlers: {}, join() {},
    emit: (ev, d) => { s.emitted.push([ev, d]); },
    on: (ev, fn) => { s.handlers[ev] = fn; },
  };
  return s;
};

type Fn = jest.Mock<any, any>;
function world(over: Record<string, unknown> = {}) {
  const users = new Map<number, any>();
  (globalThis as any).__bundle = (uid: number) => {
    const u = users.get(uid);
    if (!u) return null;
    if (u.throwOnLoad) throw new Error('db down');
    return {
      userId: uid, displayName: u.displayName ?? `Player ${uid}`, publicId: `p${String(uid).padStart(15, '0')}`,
      chips: u.chips ?? 10000, level: u.level ?? 5, xp: u.xp ?? 0, stars: u.stars ?? 1000, stats: u.stats ?? {}, achievements: [],
      lifetimeLedger: [], loginStreak: 0, lastLoginClaimDate: u.lastLoginClaimDate ?? null, scratchCardsAvailable: u.scratch ?? 0,
      inventory: u.inventory ?? [], dailyAchievementIds: [], weeklyAchievementIds: [], missionClaims: [], spinClaimedToday: false,
      vipMonthlyClaimed: false, battlePassPremium: !!u.bpPremium, denverToday: denver.denverDateKey(), denverMonth: denver.denverMonthKey(),
    };
  };
  const pm = new ProgressionManager();
  pm.hydrateBackoffMs = [0, 0, 0];
  pm.hydrateRetryDelaysMs = [];
  const sockets = new Map<string, Sock>();
  const authSessions = new Map<string, any>();
  const playerSessions = new Map<string, any>();
  const multiTableSessions = new Map<string, any[]>();
  const reservedSeats = new Map<number, any>();
  const tables = new Map<string, PokerTable>();
  const audits: Array<{ actor: string; action: string; d: any }> = [];
  const broadcasts: string[] = [];
  const saves: Array<[number, any]> = [];
  const roomEmits: Array<[string, string, any]> = [];
  const lastEmoteTime = new Map<string, number>();
  const wallet = (uid: number) => ({ chips: users.get(uid)?.chips ?? 0, stars: users.get(uid)?.stars ?? 0, scratchCardsAvailable: 0, loginStreak: 0, lastLoginClaimDate: null });
  const fakes: Record<string, Fn> = {
    readWallet: jest.fn(async (uid: number) => wallet(uid)),
    purchaseCosmetic: jest.fn(async (uid: number, t: string, id: string, cost: number) => ({ ok: true, itemType: t, itemId: id, cost, balances: { chips: 10000, stars: 1000 - cost, scratchCardsAvailable: 0 } })),
    purchaseBundle: jest.fn(async () => ({ ok: true, granted: [['frame', 'bronze']], duplicates: 0, refund: 0, cost: 800, balances: { chips: 10000, stars: 200, scratchCardsAvailable: 0 } })),
    purchaseChipPack: jest.fn(async (_u: number, id: string, cost: number) => ({ ok: true, payout: catalog.CHIP_PACK_PAYOUT[id], cost, balances: { chips: 10000 + catalog.CHIP_PACK_PAYOUT[id], stars: 0, scratchCardsAvailable: 0 } })),
    purchaseMysteryBox: jest.fn(async () => ({ ok: true, mysteryReward: { kind: 'item', itemType: 'frame', itemId: 'silver' }, cost: 2000, balances: { chips: 10000, stars: 0, scratchCardsAvailable: 0 } })),
    purchaseBooster: jest.fn(async (_u: number, cost: number, kind: string, mult: number, ms: number) => ({ ok: true, booster: { kind, mult, expiresAt: 9e15 }, activeBoosters: { [kind]: { mult, expiresAt: 9e15 } }, cost, balances: { chips: 10000, stars: 0, scratchCardsAvailable: 0 } })),
    purchaseVipPass: jest.fn(async () => ({ ok: true, vipExpiresAt: Date.now() + 86_400_000, cost: 300, balances: { chips: 10000, stars: 700, scratchCardsAvailable: 0 } })),
    purchaseBattlePassPremium: jest.fn(async () => ({ ok: true, seasonId: 'season_1_the_river', cost: 950, balances: { chips: 10000, stars: 50, scratchCardsAvailable: 0 } })),
    equipItemTx: jest.fn(async (_u: number, t: string, id: string | null) => ({ ok: true, itemType: t, itemId: id })),
    settleDailyLogin: jest.fn(async () => ({ ok: true, day: 7, streak: 7, chips: 20000, stars: 50, baseChips: 20000, baseStars: 50, vip: false, chipBoost: 1, mysteryBox: { kind: 'chips', amount: 6000 }, lastLoginClaimDate: '2026-10-11', balances: { chips: 36000, stars: 1050, scratchCardsAvailable: 0 } })),
    settleDailySpin: jest.fn(async () => ({ ok: true, segmentId: 'chips_10000', label: '10,000 Chips', chips: 10000, stars: 0, chipBoost: 1, balances: { chips: 20000, stars: 1000, scratchCardsAvailable: 0 } })),
    settleScratchCard: jest.fn(async () => ({ ok: true, reward: { kind: 'stars', amount: 25, reason: 'duplicate_refund', itemType: 'emote', itemId: 'fire' }, chips: 0, stars: 25, label: '25 stars (you already own that emote)', balances: { chips: 10000, stars: 1025, scratchCardsAvailable: 1 } })),
    settleMissionClaim: jest.fn(async (_u: number, _d: string, _t: string, reward: any) => ({ ok: true, chips: reward.chips, stars: reward.stars, chipBoost: 1, balances: { chips: 12000, stars: 1000, scratchCardsAvailable: 0 } })),
    settleVipMonthly: jest.fn(async () => ({ ok: true, chips: 25000, balances: { chips: 35000, stars: 1000, scratchCardsAvailable: 0 } })),
    hasBattlePassPremium: jest.fn(async () => false),
    chipsWonStandings: jest.fn(async () => [
      { userId: 1, displayName: 'Alpha', rawDisplayName: 'Alpha', won: 9000, hands: 40, level: 9, stats: { handsPlayed: 100, handsWon: 30, biggestPot: 4000 } },
      { userId: 2, displayName: 'Bravo', rawDisplayName: 'Bravo', won: 5000, hands: 12, level: 3, stats: {} },
    ]),
    awardSeason: jest.fn(async (k: string) => ({ status: 'awarded', seasonKey: k, winners: [{ id: 1, display_name: '7205551234', place: 1, chips: 50000, badge: 'season_gold', won: 9000 }] })),
    publicIdsFor: jest.fn(async (ids: number[]) => new Map(ids.map((i) => [i, `p${String(i).padStart(15, '0')}`]))),
    userIdForPublicId: jest.fn(async (p: string) => { const id = /^p0+(\d+)$/.test(p) ? Number(p.replace(/^p0+/, '')) : NaN; return users.has(id) ? id : null; }),
    saveProgress: jest.fn(async (uid: number, d: any) => { saves.push([uid, d]); return true; }),
    loadInventory: jest.fn(async () => []),
    getPool: jest.fn(() => ({ query: async (_t: string, p: unknown[]) => ({ rows: users.has(p[0] as number) ? [{ level: 7, xp: 10, stats: '{"handsPlayed":40,"handsWon":10,"vpipHands":10,"pfrHands":4}', achievements: '[]' }] : [] }) })),
    getPublicNames: jest.fn(async (ids: number[]) => new Map(ids.filter((i) => users.has(i)).map((i) => [i, `Player ${i}`]))),
    findUsersByDisplayName: jest.fn(async () => []),
    sendFriendRequest: jest.fn(async () => ({ ok: true, status: 'pending' })),
    listFriends: jest.fn(async () => [{ userId: 2, username: 'Bravo', status: 'accepted' }]),
    getLeaderboard: jest.fn(async () => [{ rank: 1, username: 'Alpha', displayName: 'Alpha', chips: 1, level: 1, handsPlayed: 0, handsWon: 0, winRate: 0, biggestPot: 0, userId: 1 }]),
    placeMarketBet: jest.fn(async () => ({ ok: true, balance: 990, bet: {} })),
    placePick: jest.fn(async () => ({ ok: true })),
    assertPlayable: jest.fn(async () => null),
    sideBetRefusal: jest.fn(async () => ({ code: 'organizer_cannot_bet', error: 'The organizer cannot bet on their own bracket' })),
    deductChips: jest.fn(async () => true),
    getUserChips: jest.fn(async () => 100000),
    addBracketSideBet: jest.fn(async () => ({ ok: true })),
  };
  const scope: Record<string, unknown> = {
    ...catalog, ...denver, ...fakes,
    createWindowRateLimiter, accountDisplayName, publicNameOf, PUBLIC_NAME_FALLBACK, isPublicDisplayName, userProgressKey, seasonXpOf,
    progressionManager: pm, authSessions, playerSessions, multiTableSessions, reservedSeats, GamePhase,
    io: {
      sockets: { sockets },
      to: (target: string) => ({ emit: (ev: string, d: any) => { const so = sockets.get(target); if (so) so.emitted.push([ev, d]); else roomEmits.push([target, ev, d]); } }),
      emit: () => {},
    },
    tableManager: { getTable: (id: string) => tables.get(id) },
    isTournamentTable: () => false,
    tableKindOf: () => 'cash',
    clubTableIds: new Set<string>(),
    auditLog: (actor: string, action: string, d: any) => { audits.push({ actor, action, d }); },
    broadcastGameState: (tid: string) => { broadcasts.push(tid); },
    lastEmoteTime, seatNameForSocket: () => 'Josh',
    publicNameForUser: async (uid: number) => `Player ${uid}`,
    loadBattlePassClaims: async () => [], loadDurableProgress: async () => null, loadHandHistory: async () => [], loadCareerProgress: async () => [],
    ...over,
  };
  const code = `${ECON}\n${SEND_PROGRESS}\nfunction wire(socket) {\n${HANDLERS}\n${PROGRESSION_EVENTS}\n${THEME_SHOP}\n${EMOTE}\n${SOCIAL}\n${PROFILE}\n${FRIENDS}\n${BRACKET_BET}\n}`;
  const { exports: m, stubbed } = load(code, scope, `{ wire, pushProgressToUser, sendProgressToPlayer, auditEconomyCredit, seatAccountsOfTable,
    periodLeaderboard, seasonAwardPublicResults, sweepSeasonAwards, predictionWindowClosed, evictIdleProgress, economyStats, persistLevelXp }`);
  const connect = (sid: string, userId?: number) => {
    const s = mkSock(sid);
    sockets.set(sid, s);
    if (userId !== undefined) authSessions.set(sid, { userId, username: `u${userId}`, displayName: `Player ${userId}` });
    m.wire(s);
    const call = async (ev: string, d?: any, ack?: any) => { await s.handlers[ev](d, ack); await flush(); };
    const last = (ev: string) => [...s.emitted].reverse().find(([e]) => e === ev)?.[1];
    return { s, call, last };
  };
  return { m, pm, users, fakes, audits, broadcasts, saves, tables, authSessions, playerSessions, reservedSeats, connect, stubbed, roomEmits, lastEmoteTime };
}

let warn: jest.SpyInstance;
let log: jest.SpyInstance;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); log.mockRestore(); });

describe('C5 / APPUI-4 — a lobby (unseated) economy action pushes the account\'s progress to every socket of it', () => {
  it('a purchase from the lobby: the buyer\'s other tab gets playerProgress too; the payload shows the transaction\'s balances', async () => {
    const w = world();
    w.users.set(42, { stars: 1000 });
    const tab1 = w.connect('S1', 42);
    const tab2 = w.connect('S2', 42);
    await tab1.call('purchaseShopItem', { itemType: 'frame', itemId: 'bronze', cost: 1 });   // a client cost is ignored
    expect(w.fakes.purchaseCosmetic).toHaveBeenCalledWith(42, 'frame', 'bronze', 500);
    expect(tab1.last('purchaseResult')).toEqual({ success: true, itemType: 'frame', itemId: 'bronze', cost: 500 });
    for (const t of [tab1, tab2]) {
      const p = t.last('playerProgress');
      expect(p).toMatchObject({ stars: 500, owned: ['frame:bronze'] });
    }
    expect(w.playerSessions.size).toBe(0);                 // nobody is seated
  });

  it('CONTROL — the pre-R2 sendProgressToPlayer returned for an unseated socket (nothing was ever pushed)', async () => {
    const w = world();
    w.users.set(43, {});
    const t = w.connect('S1', 43);
    await w.pm.refreshUser(43, 'P');
    const PRE = "function sendProgressToPlayer(socketId) { const session = playerSessions.get(socketId); if (!session) return; io.sockets.sockets.get(socketId).emit('playerProgress', progressionManager.getClientProgress(session.playerId)); }";
    const pre = load(`${PRE}\nmodule.exports = 0;`, { playerSessions: w.playerSessions, io: { sockets: { sockets: new Map([['S1', t.s]]) } }, progressionManager: w.pm }, '{ sendProgressToPlayer }').exports;
    pre.sendProgressToPlayer('S1');
    expect(t.s.emitted.filter(([e]) => e === 'playerProgress')).toHaveLength(0);
    w.m.sendProgressToPlayer('S1');
    await flush();
    expect(t.s.emitted.filter(([e]) => e === 'playerProgress')).toHaveLength(1);
    expect(w.fakes.readWallet).toHaveBeenCalledWith(43);   // DB-fresh
  });

  it('a record that failed to load answers progress_loading and settles NOTHING (ECON-12)', async () => {
    const w = world();
    w.users.set(44, { throwOnLoad: true });
    const t = w.connect('S1', 44);
    await t.call('purchaseShopItem', { itemType: 'frame', itemId: 'bronze' });
    expect(t.last('purchaseResult')).toMatchObject({ success: false, code: 'progress_loading' });
    expect(w.fakes.purchaseCosmetic).not.toHaveBeenCalled();
    expect(t.s.emitted.filter(([e]) => e === 'playerProgress')).toHaveLength(0);
  });
});

describe('C7 / ECON-6 — the shop and equips only ever touch real catalog items', () => {
  it('unknown items / types are refused before any settlement; each kind routes to its transaction', async () => {
    const w = world();
    w.users.set(45, { stars: 100000 });
    const t = w.connect('S1', 45);
    for (const bad of [{ itemType: 'frame', itemId: 'nope' }, { itemType: 'gold_bars', itemId: 'x' }, { itemType: 'theme', itemId: '__proto__' }, {}]) {
      await t.call('purchaseShopItem', bad);
      expect(t.last('purchaseResult')).toMatchObject({ success: false, code: 'unknown_item' });
    }
    for (const f of ['purchaseCosmetic', 'purchaseBundle', 'purchaseChipPack', 'purchaseMysteryBox', 'purchaseBooster', 'purchaseVipPass']) expect(w.fakes[f]).not.toHaveBeenCalled();
    // A free wheel emote the shop also lists: refused already_owned, nothing settled (never a charge for nothing).
    await t.call('purchaseShopItem', { itemType: 'emote', itemId: 'fire' });
    expect(t.last('purchaseResult')).toMatchObject({ success: false, code: 'already_owned', itemType: 'emote', itemId: 'fire' });
    expect(w.fakes.purchaseCosmetic).not.toHaveBeenCalled();
    await t.call('purchaseShopItem', { itemType: 'mystery_box', itemId: 'premium' });
    expect(t.last('purchaseResult')).toMatchObject({ success: true, mysteryReward: { kind: 'item', itemType: 'frame', itemId: 'silver' } });
    await t.call('purchaseShopItem', { itemType: 'booster', itemId: 'chip_1p5x_1h' });
    expect(w.fakes.purchaseBooster).toHaveBeenCalledWith(45, 400, 'chip', 1.5, 3_600_000);
    expect(w.pm.userRecord(45)!.activeBoosters!.chip.mult).toBe(1.5);
    await t.call('purchaseShopItem', { itemType: 'vip_pass', itemId: 'daily' });
    expect(w.pm.vipActive(w.pm.userRecord(45))).toBe(true);
  });

  it('a whale chip pack is a LARGE CHIP GRANT (alert + durable audit); a refused purchase pushes the DB-fresh wallet', async () => {
    const w = world();
    w.users.set(46, { stars: 5000 });
    const t = w.connect('S1', 46);
    await t.call('purchaseShopItem', { itemType: 'chip_pack', itemId: 'whale' });
    expect(t.last('purchaseResult')).toMatchObject({ success: true, payout: 2_000_000 });
    expect(w.audits.filter((a) => a.action === 'SHOP_CHIP_PACK')).toHaveLength(1);
    expect(w.audits.filter((a) => a.action === 'ECON_LARGE_CREDIT')).toEqual([expect.objectContaining({ d: expect.objectContaining({ userId: 46, chips: 2_000_000 }) })]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('LARGE CHIP GRANT ALERT'))).toBe(true);
    w.fakes.purchaseCosmetic.mockResolvedValueOnce({ ok: false, code: 'not_enough_stars' });
    w.fakes.readWallet.mockClear();
    await t.call('purchaseShopItem', { itemType: 'frame', itemId: 'mythic' });
    expect(t.last('purchaseResult')).toMatchObject({ success: false, code: 'not_enough_stars', error: 'Not enough stars' });
    expect(w.fakes.readWallet).toHaveBeenCalledWith(46);
  });

  it('equipItem: not equippable / unknown refused; a free item equips without a purchase; null unequips; the seats he holds are re-broadcast', async () => {
    const w = world();
    w.users.set(47, {});
    const t = w.connect('S1', 47);
    w.playerSessions.set('S1', { tableId: 'T1', seatIndex: 2, playerId: 'player-x' });
    await t.call('equipItem', { itemType: 'emote', itemId: 'fire' });
    expect(t.last('equipResult')).toMatchObject({ success: false, code: 'not_equippable' });
    await t.call('equipItem', { itemType: 'frame', itemId: 'made_up' });
    expect(t.last('equipResult')).toMatchObject({ success: false, code: 'unknown_item' });
    await t.call('equipItem', { itemType: 'theme', itemId: 'green_felt' });
    expect(w.fakes.equipItemTx).toHaveBeenLastCalledWith(47, 'theme', 'green_felt', true);
    expect(w.pm.equippedTheme(47)).toBe('green_felt');
    expect(w.broadcasts).toContain('T1');
    await t.call('equipItem', { itemType: 'theme', itemId: null });
    expect(w.fakes.equipItemTx).toHaveBeenLastCalledWith(47, 'theme', null, false);
    expect(w.pm.equippedTheme(47)).toBeNull();
    w.fakes.equipItemTx.mockResolvedValueOnce({ ok: false, code: 'not_owned' });
    await t.call('equipItem', { itemType: 'frame', itemId: 'gold' });
    expect(t.last('equipResult')).toMatchObject({ success: false, error: 'not_owned', code: 'not_owned' });
  });

  it('purchaseTheme charges the CATALOG price; an unknown theme is refused (no `?? 400` default)', async () => {
    const w = world();
    w.users.set(48, { stars: 5000 });
    const t = w.connect('S1', 48);
    await t.call('purchaseTheme', { themeId: 'cosmic_nebula' });
    expect(w.fakes.purchaseCosmetic).toHaveBeenCalledWith(48, 'theme', 'cosmic_nebula', 1500);
    expect(t.last('themePurchased')).toEqual({ themeId: 'cosmic_nebula', cost: 1500 });
    await t.call('purchaseTheme', { themeId: 'gold' });
    expect(t.last('error')).toMatchObject({ code: 'unknown_item' });
    expect(w.fakes.purchaseCosmetic).toHaveBeenCalledTimes(1);
  });

  it('emotes: free wheel emotes always; a shop emote only when owned; VIP emotes only while VIP; locked → emoteRefused, never relayed', async () => {
    const w = world();
    w.users.set(49, { inventory: [{ itemType: 'emote', itemId: 'crown', equipped: false }] });
    const t = w.connect('S1', 49);
    await w.pm.refreshUser(49, 'P');
    w.playerSessions.set('S1', { tableId: 'T1', seatIndex: 0, playerId: 'p' });
    const tryEmote = async (id: string) => {
      w.lastEmoteTime.clear();
      w.roomEmits.length = 0;
      t.s.emitted.length = 0;
      await t.call('emote', { emoteId: id });
      return { relayed: w.roomEmits.some(([room, ev, d]) => room === 'table:T1' && ev === 'emote' && d.emoteId === id), refused: t.last('emoteRefused') };
    };
    expect(await tryEmote('gg')).toEqual({ relayed: true, refused: undefined });
    expect(await tryEmote('crown')).toEqual({ relayed: true, refused: undefined });
    expect(await tryEmote('mic_drop')).toEqual({ relayed: false, refused: { emoteId: 'mic_drop', code: 'emote_locked' } });
    expect(await tryEmote('vip_crown')).toEqual({ relayed: false, refused: { emoteId: 'vip_crown', code: 'emote_locked' } });
    w.pm.updateUser(49, (p) => { p.vipExpiresAt = Date.now() + 60_000; });
    expect(await tryEmote('vip_crown')).toEqual({ relayed: true, refused: undefined });
  });
});

describe('C6 — missions are claimed WITHOUT a seat; claimDailyBonus is retired', () => {
  it('a complete mission of TODAY pays once through the ledger settlement, grants its XP (saved now — ECON-9) and answers missionClaimed', async () => {
    const w = world();
    w.users.set(50, {});
    const t = w.connect('S1', 50);
    await w.pm.refreshUser(50, 'P');
    const today = denver.denverDateKey();
    const [tid] = missionTemplateIdsFor(50, today);
    const rec = w.pm.userRecord(50)!;
    rec.missionDay!.progress[tid] = 999;
    await t.call('claimMission', { missionId: `${today}:${tid}` });
    expect(w.fakes.settleMissionClaim).toHaveBeenCalledWith(50, today, tid, expect.objectContaining({ chips: expect.any(Number), stars: expect.any(Number) }));
    expect(t.last('missionClaimed')).toMatchObject({ missionId: `${today}:${tid}`, templateId: tid, reward: expect.objectContaining({ xp: expect.any(Number) }) });
    expect(w.saves.some(([uid, d]) => uid === 50 && typeof d.xp === 'number' && typeof d.level === 'number')).toBe(true);
    expect(w.audits.some((a) => a.action === 'MISSION_REWARD')).toBe(true);
    await t.call('claimMission', { missionId: `${today}:${tid}` });
    expect(t.last('missionClaimError')).toMatchObject({ code: 'already_claimed' });
    expect(w.fakes.settleMissionClaim).toHaveBeenCalledTimes(1);
    await t.call('claimMission', { missionId: '2020-01-01:play_10' });
    expect(t.last('missionClaimError')).toMatchObject({ code: 'mission_expired' });
    expect(w.playerSessions.size).toBe(0);
  });

  it('claimDailyBonus pays nothing any more (stable code)', async () => {
    const w = world();
    w.users.set(51, {});
    const t = w.connect('S1', 51);
    await t.call('claimDailyBonus');
    expect(t.last('error')).toMatchObject({ code: 'daily_bonus_retired' });
    expect(w.audits).toEqual([]);
  });

  it('getDailyMissions / getProgress answer an unseated socket (C5 payload with missions)', async () => {
    const w = world();
    w.users.set(52, {});
    const t = w.connect('S1', 52);
    await t.call('getDailyMissions');
    expect(t.last('dailyMissions')).toHaveLength(3);
    await t.call('getProgress');
    expect(t.last('playerProgress').missions).toHaveLength(3);
  });
});

describe('daily rewards (ECON-4 / APPUI-36 / APPUI-37 / APPUI-38)', () => {
  it('claimDailyLogin: the settlement\'s result (Day 7 Mystery Box included) is answered, audited, mirrored into the record', async () => {
    const w = world();
    w.users.set(53, {});
    const t = w.connect('S1', 53);
    await t.call('claimDailyLogin');
    expect(t.last('dailyLoginClaimed')).toMatchObject({ success: true, day: 7, streak: 7, chips: 20000, stars: 50, mysteryBox: { kind: 'chips', amount: 6000 }, lastLoginClaimDate: '2026-10-11' });
    expect(t.last('playerProgress')).toMatchObject({ loginStreak: 7, lastLoginClaimDate: '2026-10-11' });
    expect(w.audits.some((a) => a.action === 'DAILY_LOGIN_REWARD' && a.d.chips === 20000)).toBe(true);
    w.fakes.settleDailyLogin.mockResolvedValueOnce({ ok: false, code: 'already_claimed' });
    await t.call('claimDailyLogin');
    expect(t.last('dailyLoginClaimed')).toMatchObject({ success: false, code: 'already_claimed', lastLoginClaimDate: '2026-10-11', streak: 7 });
  });

  it('getSpinWheel sends the REAL prize table; the claim names the landed segment', async () => {
    const w = world();
    w.users.set(54, {});
    const t = w.connect('S1', 54);
    await t.call('getSpinWheel');
    expect(t.last('spinWheelConfig').segments.map((s: any) => s.id)).toEqual(catalog.SPIN_WHEEL_SEGMENTS.map((s) => s.id));
    await t.call('claimDailySpinServer');
    expect(t.last('dailySpinClaimed')).toMatchObject({ success: true, segmentId: 'chips_10000', reward: { chips: 10000, stars: 0 } });
  });

  it('scratch card: {kind, amount} (+ the legacy chips/stars/item/label keys) and the new count', async () => {
    const w = world();
    w.users.set(55, {});
    const t = w.connect('S1', 55);
    await t.call('claimScratchCard');
    expect(t.last('scratchCardRevealed')).toMatchObject({ success: true, scratchCardsAvailable: 1, reward: { kind: 'stars', amount: 25, stars: 25, reason: 'duplicate_refund', label: '25 stars (you already own that emote)' } });
  });
});

describe('C8 / ECON-16 — VIP monthly bonus; Battle Pass premium from the lobby, never twice', () => {
  it('claimVipMonthly pays through its settlement; a refusal keeps its code', async () => {
    const w = world();
    w.users.set(56, {});
    const t = w.connect('S1', 56);
    await t.call('claimVipMonthly');
    expect(t.last('vipMonthlyClaimed')).toMatchObject({ success: true, chips: 25000, monthKey: denver.denverMonthKey() });
    expect(w.fakes.settleVipMonthly).toHaveBeenCalledWith(56, denver.denverMonthKey(), 25000);
    expect(t.last('playerProgress').vip.monthlyClaimed).toBe(true);
    w.fakes.settleVipMonthly.mockResolvedValueOnce({ ok: false, code: 'vip_required' });
    await t.call('claimVipMonthly');
    expect(t.last('vipMonthlyClaimed')).toMatchObject({ success: false, code: 'vip_required' });
  });

  it('purchaseBattlePass works with NO seat (it answered "Not in a session"), is remembered, and a second purchase is already_owned (no second charge)', async () => {
    const w = world();
    w.users.set(57, { stars: 2000 });
    const t = w.connect('S1', 57);
    const acks: any[] = [];
    await t.call('purchaseBattlePass', {}, (a: any) => acks.push(a));
    expect(acks[0]).toEqual({ success: true, seasonId: 'season_1_the_river', cost: 950 });
    expect(w.fakes.purchaseBattlePassPremium).toHaveBeenCalledWith(57, 'season_1_the_river', 950);
    expect(t.last('playerProgress').battlePassPremium).toBe(true);
    w.fakes.purchaseBattlePassPremium.mockResolvedValueOnce({ ok: false, code: 'already_owned' });
    await t.call('purchaseBattlePass', {}, (a: any) => acks.push(a));
    expect(acks[1]).toMatchObject({ success: false, code: 'already_owned' });
  });
});

describe('C10 — getDetailedStats answers an unseated socket from the account record', () => {
  it('lobby socket → detailedStats with the HUD numbers (it returned nothing → "PFR 0.0%" fake leak)', async () => {
    const w = world();
    w.users.set(58, { stats: { handsPlayed: 100, vpipHands: 30, pfrHands: 10 } });
    const t = w.connect('S1', 58);
    await t.call('getDetailedStats');
    expect(t.last('detailedStats')).toMatchObject({ vpip: 30, pfr: 10, handsTracked: 100, hydrated: true });
  });
});

describe('leaderboards (APPUI-50 / C9) and public ids (APPUI-14 / Addendum)', () => {
  it('daily / weekly / season rank by chips WON in the Denver window (season = the award ranking + seasonEndsAt); isYou; no account ids', async () => {
    const w = world();
    const t = w.connect('S1', 1);
    await t.call('getLeaderboard', { period: 'season' });
    const d = t.last('leaderboardData');
    const range = denver.monthDateRange(denver.denverMonthKey())!;
    expect(w.fakes.chipsWonStandings).toHaveBeenLastCalledWith(range.first, range.last, 50);
    expect(d).toMatchObject({ period: 'season', seasonKey: denver.denverMonthKey(), seasonEndsAt: denver.nextDenverMonthStartMs(), windowStart: range.first });
    expect(d.entries.map((e: any) => [e.displayName, e.chipsWon, e.isYou, e.publicId])).toEqual([['Alpha', 9000, true, 'p000000000000001'], ['Bravo', 5000, false, 'p000000000000002']]);
    expect(d.entries.every((e: any) => !('userId' in e))).toBe(true);
    await t.call('getLeaderboard', { period: 'daily' });
    expect(w.fakes.chipsWonStandings).toHaveBeenLastCalledWith(denver.denverDateKey(), denver.denverDateKey(), 50);
    await t.call('getLeaderboard', { period: 'weekly' });
    const wk = denver.denverWeekRange();
    expect(w.fakes.chipsWonStandings).toHaveBeenLastCalledWith(wk.first, wk.last, 50);
    await t.call('getLeaderboard', { period: 'alltime' });
    expect(t.last('leaderboardData').entries[0]).toMatchObject({ username: 'Alpha', publicId: 'p000000000000001', isYou: true });
  });

  it('requestProfile BY publicId (exact): isYou for the viewer\'s own; an unknown id is notFound', async () => {
    const w = world();
    w.users.set(60, {}); w.users.set(61, {});
    const t = w.connect('S1', 60);
    await t.call('requestProfile', { publicId: 'p000000000000061' });
    expect(t.last('profileData')).toMatchObject({ publicId: 'p000000000000061', displayName: 'Player 61', isYou: false, level: 7, totalHands: 40, wins: 10, vpip: 25, pfr: 10 });
    await t.call('requestProfile', { publicId: 'p000000000000060' });
    expect(t.last('profileData')).toMatchObject({ isYou: true });
    await t.call('requestProfile', { publicId: 'p000000000000999' });
    expect(t.last('profileData')).toMatchObject({ notFound: true });
  });

  it('sendFriendRequest BY publicId; the friends list carries publicIds; the request names the sender by public name + id', async () => {
    const w = world();
    w.users.set(62, {}); w.users.set(63, {});
    const a = w.connect('S1', 62);
    const b = w.connect('S2', 63);
    await a.call('sendFriendRequest', { publicId: 'p000000000000063' });
    expect(w.fakes.sendFriendRequest).toHaveBeenCalledWith(62, 63);
    expect(b.last('friendRequestReceived')).toEqual({ from: 'Player 62', fromPublicId: 'p000000000000062' });
    await a.call('sendFriendRequest', { publicId: 'p000000000000999' });
    expect(a.last('friendError')).toMatchObject({ code: 'friend_not_found' });
    await a.call('getFriends');
    expect(a.last('friendsList').friends[0]).toMatchObject({ userId: 2, username: 'Bravo', displayName: 'Bravo', publicId: 'p000000000000002' });
  });
});

describe('APPUI-45 — prediction markets only for the hand in progress, pre-flop; ECON-14 bracket bets', () => {
  const tableAt = (w: ReturnType<typeof world>) => {
    const t = new PokerTable({ tableId: 'PT', tableName: 'PT', smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 400 } as any);
    t.sitDown(0, 'A', 1000, 'pa', false);
    t.sitDown(1, 'B', 1000, 'pb', true);
    t.sitDown(2, 'C', 1000, 'pc', true);
    w.tables.set('PT', t);
    return t;
  };
  it('open pre-flop of the CURRENT hand; closed after the flop, after an all-in, for another hand number, between hands', async () => {
    const w = world();
    const t = tableAt(w);
    expect(w.m.predictionWindowClosed('PT', 0, 'market')).toMatchObject({ code: 'prediction_hand_closed' });   // no hand yet
    expect(t.startNewHand()).toBe(true);
    const hn = t.handNumber;
    expect(w.m.predictionWindowClosed('PT', hn, 'market')).toBeNull();
    expect(w.m.predictionWindowClosed('PT', hn - 1, 'market')).toMatchObject({ code: 'prediction_hand_closed' });
    (t as any).currentPhase = GamePhase.Flop;
    expect(w.m.predictionWindowClosed('PT', hn, 'market')).toMatchObject({ code: 'prediction_street_closed' });
    expect(w.m.predictionWindowClosed('PT', hn, 'pick')).toBeNull();
    (t as any).currentPhase = GamePhase.River;
    expect(w.m.predictionWindowClosed('PT', hn, 'pick')).toMatchObject({ code: 'prediction_street_closed' });
    (t as any).currentPhase = GamePhase.PreFlop;
    t.seats[1].allIn = true;
    expect(w.m.predictionWindowClosed('PT', hn, 'market')).toMatchObject({ code: 'prediction_street_closed' });
    // An all-in seat that has since been marked sitting out still closes it.
    t.seats[1].state = 'sitting_out';
    expect(w.m.predictionWindowClosed('PT', hn, 'market')).toMatchObject({ code: 'prediction_street_closed' });
    t.seats[1].allIn = false;
    expect(w.m.predictionWindowClosed('PT', hn, 'market')).toBeNull();
  });

  it('placeSocialSideBet: a refusal (organizer / player / closed) is answered BEFORE any escrow', async () => {
    const w = world();
    const t = w.connect('S1', 64);
    await t.call('placeSocialSideBet', { bracketId: 'abcd', target: 'Alice', amount: 500 });
    expect(t.last('socialBracketError')).toMatchObject({ code: 'organizer_cannot_bet' });
    expect(w.fakes.sideBetRefusal).toHaveBeenCalledWith('ABCD', 64, ['Player 64']);
    expect(w.fakes.deductChips).not.toHaveBeenCalled();
  });
});

describe('K2 contract — names the economy screens are built against', () => {
  it('getDurableState answers durableState with the account\'s own saved clientData (or null)', async () => {
    const saved = { settings: { sound: false, fourColor: true } };
    const w = world({
      loadDurableProgress: async () => ({ stars: 5, loginStreak: 2, lastLoginClaimDate: '2026-10-10', scratchCardsAvailable: 1, handsSinceLastScratch: 0, customization: {}, preferences: {}, clientData: saved }),
    });
    w.users.set(90, {});
    const t = w.connect('S90', 90);
    await t.call('getDurableState', {});
    expect(t.last('durableState')).toMatchObject({ clientData: saved, battlePassPremium: false, loginStreak: 2, scratchCardsAvailable: 1 });
    const w2 = world();
    w2.users.set(91, {});
    const t2 = w2.connect('S91', 91);
    await t2.call('getDurableState', {});
    expect(t2.last('durableState').clientData).toBeNull();
  });

  it('player search rows: publicId, isYou:true on the searcher\'s own row (absent on others), never an account id or chips', async () => {
    const w = world({
      searchUsers: async () => [{ id: 92, displayName: 'Josh', level: 4 }, { id: 93, displayName: 'Joshua', level: 9 }],
      playerSearchLimiter: createWindowRateLimiter(30, 30_000),
    });
    w.users.set(92, {});
    const t = w.connect('S92', 92);
    await t.call('searchPlayers', { query: 'jo' });
    const rows = t.last('playerSearchResults').results;
    expect(rows).toEqual([
      { id: 'r0', username: 'Josh', displayName: 'Josh', level: 4, publicId: 'p000000000000092', isYou: true },
      { id: 'r1', username: 'Joshua', displayName: 'Joshua', level: 9, publicId: 'p000000000000093' },
    ]);
    expect('isYou' in rows[1]).toBe(false);
  });

  it('leaderboard rows (all-time and the chips-won windows): publicId + isYou, no userId', async () => {
    const w = world();
    w.users.set(1, {});
    const t = w.connect('S1', 1);
    for (const period of ['alltime', 'season']) {
      await t.call('getLeaderboard', { period });
      const d = t.last('leaderboardData');
      expect(d.period).toBe(period);
      expect(d.entries[0]).toMatchObject({ publicId: 'p000000000000001', isYou: true });
      for (const e of d.entries) expect(e).not.toHaveProperty('userId');
      if (period === 'season') expect(d).toEqual(expect.objectContaining({ seasonEndsAt: expect.any(Number), windowEndsAt: expect.any(Number) }));
    }
  });
});

describe('leaveSocialBracket (K3 contract) — the closed bracket panel leaves that bracket room only', () => {
  it('leaves bracket:<ID> (upper-cased, like every bracket room); nothing for a missing id; a failing leave never throws', async () => {
    const BRACKET_ROOM = between('  const bracketRoom = ', "  socket.on('createSocialBracket'");
    const LEAVE = between("  socket.on('leaveSocialBracket'", "  socket.on('socialBracketEliminate'");
    const { exports: m, stubbed } = load(`function wire(socket) {\n${BRACKET_ROOM}\n${LEAVE}\n}`, {}, '{ wire }');
    const handlers: Record<string, (d?: any) => void> = {};
    const left: string[] = [];
    m.wire({ on: (ev: string, fn: any) => { handlers[ev] = fn; }, leave: (room: string) => { left.push(room); } });
    handlers.leaveSocialBracket({ bracketId: 'abcd' });
    handlers.leaveSocialBracket({});
    handlers.leaveSocialBracket(undefined);
    handlers.leaveSocialBracket({ bracketId: '   ' });
    expect(left).toEqual(['bracket:ABCD']);
    m.wire({ on: (ev: string, fn: any) => { handlers[ev] = fn; }, leave: () => Promise.reject(new Error('adapter down')) });
    expect(() => handlers.leaveSocialBracket({ bracketId: 'x1' })).not.toThrow();
    await flush();
    expect([...stubbed]).toEqual([]);
  });
});

describe('C9 — the automatic season award sweep', () => {
  it('awards the PREVIOUS Denver month; the winners are told and pushed; names are public; an already-awarded season is a no-op', async () => {
    const w = world();
    w.users.set(1, {});
    const t = w.connect('S1', 1);
    await w.pm.refreshUser(1, 'P');
    await w.m.sweepSeasonAwards('sweep');
    await flush();
    expect(w.fakes.awardSeason).toHaveBeenCalledWith(denver.previousDenverMonthKey(), 'sweep');
    expect(t.last('seasonRewardAwarded')).toEqual({ seasonKey: denver.previousDenverMonthKey(), place: 1, chips: 50000, badge: 'season_gold', chipsWon: 9000 });
    const award = w.audits.find((a) => a.action === 'SEASON_LEADERBOARD_AWARD')!;
    expect(award.d.displayName).toBe('Player');                    // a phone-like display name is never shown
    expect(w.pm.userRecord(1)!.owned!.has('badge:season_gold')).toBe(true);
    w.fakes.awardSeason.mockResolvedValueOnce({ status: 'already_awarded', seasonKey: 'x', winners: [] });
    t.s.emitted.length = 0;
    await w.m.sweepSeasonAwards('sweep');
    expect(t.s.emitted.filter(([e]) => e === 'seasonRewardAwarded')).toEqual([]);
    expect(w.m.economyStats.seasonAwards).toBe(1);
  });
});

describe('seat cosmetics in the table state (C7 / C8)', () => {
  it('every seat carries cosmetics {frame,title,cardBack,badge,vip} (null / false when none) + publicId; each player gets myTheme', async () => {
    const w = world();
    w.users.set(70, { stats: { vipExpiresAt: Date.now() + 60_000 }, inventory: [{ itemType: 'frame', itemId: 'gold', equipped: true }, { itemType: 'theme', itemId: 'royal_gold', equipped: true }, { itemType: 'title', itemId: 'royal', equipped: true }] });
    await w.pm.refreshUser(70, 'P');
    const t = new PokerTable({ tableId: 'CT', tableName: 'CT', smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 400 } as any);
    t.sitDown(0, 'Josh', 1000, 'player-70', false);
    t.sitDown(1, 'Bot', 1000, 'ai-1', true);
    w.authSessions.set('S70', { userId: 70 });
    w.playerSessions.set('S70', { tableId: 'CT', seatIndex: 0, playerId: 'player-70', playerName: 'Josh' });
    const scope: Record<string, unknown> = {
      playerSessions: w.playerSessions, multiTableSessions: new Map(), reservedSeats: new Map(), authSessions: w.authSessions,
      progressionManager: w.pm, turnStartedAtMap: new Map(), TURN_TIMEOUT_MS: 30000, bombPotActive: new Map(), dealersChoiceState: new Map(),
      MAX_SEATS: 9, GamePhase, cardToString: (c: any) => `${c.rank}${c.suit}`, tournamentIdOfTable: () => null, insuranceQuoteForSeat: () => null,
      tableKindOf: () => 'cash', rebuyAllowedAt: () => true, PokerTable,
    };
    const g = load(`${ECON.slice(ECON.indexOf('function seatAccountsOfTable('), ECON.indexOf('/** Re-send the table state'))}\n${GAME_STATE}`, scope, '{ getGameStateForPlayer }').exports;
    const s: any = g.getGameStateForPlayer(t, 0);
    expect(s.seats[0].cosmetics).toEqual({ frame: 'gold', title: 'royal', cardBack: null, badge: null, vip: true });
    expect(s.seats[0].publicId).toBe('p000000000000070');
    expect(s.seats[1].cosmetics).toEqual({ frame: null, title: null, cardBack: null, badge: null, vip: false });
    expect(s.seats[1].publicId).toBeNull();
    expect(s.seats[5].cosmetics).toEqual({ frame: null, title: null, cardBack: null, badge: null, vip: false });
    expect(s.myTheme).toBe('royal_gold');
    expect(g.getGameStateForPlayer(t, 1).myTheme).toBeNull();
    expect(g.getGameStateForPlayer(t, -1).myTheme).toBeNull();
    // A SITTING-OUT seat is still his seat: it keeps its look.
    t.seats[0].state = 'sitting_out';
    expect(g.getGameStateForPlayer(t, 1).seats[0].cosmetics).toEqual({ frame: 'gold', title: 'royal', cardBack: null, badge: null, vip: true });
  });
});

describe('ECON-18 — every economy credit is audited; at / above the threshold it raises the alert', () => {
  it('auditEconomyCredit: below → one audit row; at the threshold → + ECON_LARGE_CREDIT + the alert line; nothing for zero', () => {
    const w = world();
    w.m.auditEconomyCredit(5, 'X', 999_999, 0);
    expect(w.audits.map((a) => a.action)).toEqual(['X']);
    w.m.auditEconomyCredit(5, 'Y', 1_000_000, 3);
    expect(w.audits.map((a) => a.action)).toEqual(['X', 'Y', 'ECON_LARGE_CREDIT']);
    w.m.auditEconomyCredit(5, 'Z', 0, 0);
    expect(w.audits).toHaveLength(3);
    expect(SRC).toContain("'ECON_LARGE_CREDIT', 'SEASON_LEADERBOARD_AWARD',");
  });

  it('wiring: every economy credit path in index.ts goes through auditEconomyCredit', () => {
    for (const action of ['SHOP_CHIP_PACK', 'SHOP_MYSTERY_BOX', 'DAILY_LOGIN_REWARD', 'DAILY_SPIN_REWARD', 'SCRATCH_CARD_REWARD', 'BATTLE_PASS_REWARD',
      // (The Spin & Go prize is S1's: r2-tourney settles it through its prize ledger.)
      'MISSION_REWARD', 'VIP_MONTHLY_BONUS', 'CAREER_REWARD', 'SEASON_REWARD', 'CLUB_REFERRAL_REWARD', 'BRACKET_SIDEBET_WIN',
      'ACHIEVEMENT_REWARD', 'LEVEL_UP_REWARD']) {
      expect([action, SRC.includes(`'${action}'`)]).toEqual([action, true]);
    }
  });
});

describe('P3 — progress records are evicted when their account is gone', () => {
  it('evictIdleProgress keeps accounts with a live socket or a reservation', async () => {
    const w = world();
    w.users.set(80, {}); w.users.set(81, {}); w.users.set(82, {});
    let clock = Date.now();
    w.pm.now = () => clock;
    w.connect('S80', 80);
    await w.pm.refreshUser(80, 'A'); await w.pm.refreshUser(81, 'B'); await w.pm.refreshUser(82, 'C');
    w.reservedSeats.set(82, { tableId: 'T', seatIndex: 0 });
    clock += 31 * 60_000;
    w.m.evictIdleProgress();
    expect([80, 81, 82].map((u) => !!w.pm.userRecord(u))).toEqual([true, false, true]);
  });
});

describe('harness integrity', () => {
  it('every economy handler ran on REAL code: no identifier it uses was silently stubbed', async () => {
    const w = world();
    w.users.set(90, { stars: 100000 });
    const t = w.connect('S1', 90);
    w.playerSessions.set('S1', { tableId: 'T1', seatIndex: 0, playerId: 'p' });
    for (const [ev, d] of [['purchaseShopItem', { itemType: 'frame', itemId: 'bronze' }], ['purchaseShopItem', { itemType: 'chip_pack', itemId: 'small' }],
      ['equipItem', { itemType: 'theme', itemId: 'green_felt' }], ['claimDailyLogin'], ['claimDailySpinServer'], ['claimScratchCard'], ['claimVipMonthly'],
      ['purchaseBattlePass', {}], ['purchaseTheme', { themeId: 'royal_gold' }], ['equipTheme', { themeId: 'royal_gold' }], ['getDetailedStats'], ['emote', { emoteId: 'gg' }],
      ['getLeaderboard', { period: 'season' }], ['getShopCatalog'], ['getSpinWheel'], ['getBattlePass'], ['getLoginRewards'], ['getProgress'], ['getDailyMissions'],
      ['getAchievements'], ['getDurableState']] as Array<[string, any]>) {
      await t.call(ev, d, () => {});
    }
    expect([...w.stubbed].filter((n) => !n.includes('.'))).toEqual([]);
  });
});
