/**
 * R1 (2026-10-11) — AUTH-5 / ECON-2 (P0): claimBattlePassTier trusted the
 * CLIENT's seasonId as its claim key. The tier unlock is cumulative XP (it
 * never resets), so any new seasonId re-claimed every tier: ~32,500 chips +
 * 4,000 XP per made-up season. The handler now uses the server constant
 * CURRENT_BATTLE_PASS_SEASON for the claim key (and getDurableState for the
 * claims it shows), ignores the client's seasonId, and rate-limits claims per
 * account. Real handler source (sliced from src/index.ts) on an in-memory
 * claim ledger.
 */
import { slice, handlerSrc, load, flush, SRC } from './helpers/indexSource';
import { createWindowRateLimiter } from '../src/auth/rateLimit';

const SEASON = slice('const CURRENT_BATTLE_PASS_SEASON = ', ';\n');
const BP_REWARD = slice('  const bpReward = (tierId: number', '\n  };\n');
const HANDLER = handlerSrc('claimBattlePassTier', '\n  });\n');

function world(handler = HANDLER) {
  const ledger = new Set<string>();
  const chips: Array<[number, number]> = [];
  const stars: Array<[number, number]> = [];
  const xp: Array<[string, number]> = [];
  const progress = { hydrated: true, chips: 0, stars: 0 };
  const scope: Record<string, unknown> = {
    createWindowRateLimiter,
    ensureHydrated: async () => ({ userId: 42, playerId: 'player-42' }),
    progressionManager: {
      getProgress: () => progress,
      getSeasonXp: () => 50 * 500,                         // every tier unlocked
      addXP: (pid: string, n: number) => { xp.push([pid, n]); },
    },
    dbClaimBattlePassTier: async (uid: number, season: string, tier: number, track: string) => {
      const key = `${uid}|${season}|${tier}|${track}`;
      if (ledger.has(key)) return false;
      ledger.add(key);
      return true;
    },
    addChipsToUser: async (uid: number, n: number) => { chips.push([uid, n]); return true; },
    addStarsToUser: async (uid: number, n: number) => { stars.push([uid, n]); return true; },
    dbGrantItem: async () => true, loadInventory: async () => [], auditLog() {}, sendProgressToPlayer() {},
    // R2 (ECON-17): the claim row + reward settle in ONE transaction; here the fakes run on a pass-through client.
    withEconomyTx: async (fn: (tx: unknown) => Promise<unknown>) => fn(undefined),
  };
  const code = `${SEASON}\nconst battlePassClaimLimiter = createWindowRateLimiter(110, 60_000);\nfunction wire(socket) {\n${BP_REWARD}\n${handler}\n}`;
  const { exports: m } = load(code, scope, '{ wire, CURRENT_BATTLE_PASS_SEASON }');
  const emitted: Array<[string, any]> = [];
  const handlers: Record<string, (d?: any) => any> = {};
  m.wire({ id: 'S1', emit: (ev: string, d: any) => emitted.push([ev, d]), on: (ev: string, fn: any) => { handlers[ev] = fn; } });
  const claim = async (d: any) => { await handlers.claimBattlePassTier(d); await flush(); return emitted[emitted.length - 1][1]; };
  return { m, ledger, chips, stars, xp, emitted, claim };
}

describe('claimBattlePassTier: one server season — a client seasonId never re-opens a claimed tier', () => {
  it('tier 10 pays once; the same tier under made-up seasonIds is already_claimed and pays nothing', async () => {
    const w = world();
    expect(await w.claim({ seasonId: 'season_1_the_river', tierId: 10, track: 'free' })).toMatchObject({ success: true, tierId: 10 });
    for (const forged of ['season_2_hack', 'x', '', undefined, 'season_1_the_river ']) {
      expect(await w.claim({ seasonId: forged, tierId: 10, track: 'free' })).toMatchObject({ success: false, error: 'already_claimed' });
    }
    expect(w.chips).toEqual([[42, 2000]]);                      // 10 * 200, once
    expect([...w.ledger]).toEqual([`42|${w.m.CURRENT_BATTLE_PASS_SEASON}|10|free`]);
  });

  it('CONTROL — the pre-R1 line (client seasonId as the key) pays the same tier again for every new seasonId', async () => {
    const pre = HANDLER.replace('const seasonId = CURRENT_BATTLE_PASS_SEASON;', "const seasonId = data?.seasonId || 'season_1_the_river';");
    expect(pre).not.toBe(HANDLER);
    const w = world(pre);
    for (const season of ['season_1_the_river', 'season_2_hack', 'season_3_hack']) {
      expect(await w.claim({ seasonId: season, tierId: 10, track: 'free' })).toMatchObject({ success: true });
    }
    expect(w.chips).toEqual([[42, 2000], [42, 2000], [42, 2000]]);
  });

  it('rate limit: a full Claim-all (100 emits) passes; the 111th claim in a minute is refused rate_limited (no ledger write)', async () => {
    const w = world();
    let ok = 0, limited = 0;
    for (let i = 0; i < 111; i++) {
      const r = await w.claim({ tierId: (i % 50) + 1, track: i < 50 ? 'free' : 'premium' });
      if (r.error === 'rate_limited') limited++; else ok++;
    }
    expect(ok).toBe(110);
    expect(limited).toBe(1);
  });

  it('wiring: the client seasonId is read nowhere in the claim; getDurableState shows the server season\'s claims', () => {
    expect(HANDLER).toContain('const seasonId = CURRENT_BATTLE_PASS_SEASON;');
    expect(HANDLER).not.toContain('data?.seasonId ||');
    expect(HANDLER.indexOf('battlePassClaimLimiter.hit(String(ctx.userId))')).toBeLessThan(HANDLER.indexOf('dbClaimBattlePassTier('));
    expect(handlerSrc('getDurableState', '\n  });\n')).toContain('loadBattlePassClaims(ctx.userId, CURRENT_BATTLE_PASS_SEASON)');
    expect(SRC).toContain("const CURRENT_BATTLE_PASS_SEASON = 'season_1_the_river';");
  });
});

describe('createWindowRateLimiter', () => {
  it('max per window per key, resets after the window, bounded memory', () => {
    const l = createWindowRateLimiter(2, 1000, 3);
    expect([l.hit('a', 0), l.hit('a', 10), l.hit('a', 20)]).toEqual([true, true, false]);
    expect(l.hit('b', 20)).toBe(true);                         // keys are independent
    expect(l.hit('a', 1000)).toBe(true);                       // new window
    for (const k of ['c', 'd', 'e', 'f']) l.hit(k, 5000);      // past maxKeys: expired windows pruned
    expect(l.size()).toBeLessThanOrEqual(4);
  });
});
