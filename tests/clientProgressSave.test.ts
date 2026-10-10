/**
 * 2026-10-09 — D4: the socket `saveProgress` handler must never accept level
 * (or anything that pays out) from the client.
 *
 * Pre-existing exploit (since b5476ea6, 2026-07-07): the handler stripped only
 * userId + chips, so `saveProgress {level:1000}` ratcheted users.level to 1000
 * and the next hand paid every level achievement (~14M chips) — and a huge
 * `xp` walked the paying level-up loop, and client `stats` keys were read back
 * as server counters / boosters / identity. Now only stats.clientData passes.
 *
 * Pins:
 *   - a crafted payload (huge level/xp, achievements, chips, payout-feeding
 *     stats keys, an identity stamp) is reduced to {stats:{clientData}};
 *   - run through the REAL authManager.saveProgress, it issues an UPDATE that
 *     touches ONLY stats — no level, xp, achievements or chips column — so
 *     there is no level change and therefore no level reward;
 *   - the unsanitized payload WOULD have written level (proves the test bites);
 *   - the legitimate client payload (persistenceService._doSync) keeps its
 *     clientData round-trip.
 */

import { sanitizeClientProgressSave, PAYOUT_KEYS_FROM_CLIENT } from '../src/progression/clientProgressSave';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-jwt-secret-client-save';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authManager = require('../src/auth/authManager') as typeof import('../src/auth/authManager');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const progression = require('../src/progression/ProgressionManager') as typeof import('../src/progression/ProgressionManager');

function recordingDb() {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  return {
    queries,
    async query(text: string, params: unknown[] = []) { queries.push({ text, params }); return { rowCount: 1 }; },
  };
}

const clientData = {
  career: { stage: 3, wins: 2 },
  missions: { claimed: ['m1'] },
  settings: { sound: false },
};

/** What a cheater emits. */
const CRAFTED = {
  userId: 1,
  chips: 999_999_999,
  level: 1000,
  xp: 999_999_999,
  achievements: ['lvl_1000', 'royal_flush'],
  stats: {
    handsPlayed: 999_999, handsWon: 999_999, royalFlushHits: 9, tournamentsWon: 99, chatMessagesSent: 1e6,
    activeBoosters: { chip: { mult: 1000, expiresAt: Date.now() + 365 * 86400_000 } },
    vipExpiresAt: Date.now() + 365 * 86400_000,
    masterUserId: 'someone-elses-master-id',
    claimedBy: 1,
    clientData,
  },
};

describe('sanitizeClientProgressSave — only stats.clientData survives', () => {
  it('a crafted payload is reduced to {stats:{clientData}}; every payout field is dropped and reported', () => {
    const { data, dropped } = sanitizeClientProgressSave(CRAFTED);
    expect(data).toEqual({ stats: { clientData } });
    for (const k of PAYOUT_KEYS_FROM_CLIENT) expect(dropped).toContain(k);
    for (const k of ['handsWon', 'royalFlushHits', 'tournamentsWon', 'activeBoosters', 'vipExpiresAt', 'masterUserId', 'claimedBy']) {
      expect(dropped).toContain(`stats.${k}`);
    }
  });

  it('the REAL client payload (persistenceService._doSync: {stats:{...serverStatsEcho, clientData}}) keeps its clientData', () => {
    const { data } = sanitizeClientProgressSave({ stats: { handsPlayed: 30, handsWon: 4, clientData } });
    expect(data).toEqual({ stats: { clientData } });
  });

  it('no clientData / garbage → nothing to write', () => {
    expect(sanitizeClientProgressSave({ level: 50 }).data).toEqual({});
    expect(sanitizeClientProgressSave({ stats: { clientData: 'x' } }).data).toEqual({});
    expect(sanitizeClientProgressSave({ stats: ['a'] }).data).toEqual({});
    expect(sanitizeClientProgressSave(null).data).toEqual({});
    expect(sanitizeClientProgressSave('level=1000').data).toEqual({});
  });
});

describe('D4 regression — crafted saveProgress with a huge level → no level change, no chips', () => {
  it('through the REAL authManager.saveProgress: the only column written is stats (clientData)', async () => {
    const db = recordingDb();
    const { data } = sanitizeClientProgressSave(CRAFTED);
    expect(await authManager.saveProgress(512, data, db)).toBe(true);
    expect(db.queries).toHaveLength(1);
    const { text, params } = db.queries[0];
    expect(text).toMatch(/^UPDATE users SET stats = /);
    for (const col of ['level', 'xp', 'achievements', 'chips']) expect(text).not.toMatch(new RegExp(`\\b${col}\\s*=`));
    expect(params).toEqual([JSON.stringify({ clientData }), 512]);
    // Nothing payout-feeding rides inside the stats JSON either.
    const written = JSON.parse(String(params[0]));
    expect(Object.keys(written)).toEqual(['clientData']);
  });

  it('a payload with no clientData writes NOTHING at all', async () => {
    const db = recordingDb();
    const { data } = sanitizeClientProgressSave({ level: 1000, xp: 1e9, chips: 1e9, achievements: ['lvl_1000'] });
    expect(await authManager.saveProgress(512, data, db)).toBe(true);
    expect(db.queries).toHaveLength(0);
  });

  it('control: the UNSANITIZED payload is exactly what used to ratchet level to 1000 (the hole this closes)', async () => {
    const db = recordingDb();
    const { userId: _u, chips: _c, ...oldHandlerData } = CRAFTED; // the pre-2026-10-09 handler's strip
    await authManager.saveProgress(512, oldHandlerData as any, db);
    expect(db.queries[0].text).toContain('level = GREATEST(level, $1)');
    expect(db.queries[0].params[0]).toBe(1000);
  });

  it('no level change ⇒ no level reward: the engine pays lvl_* only when the level actually reaches it', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const pm = new progression.ProgressionManager();
      const p = pm.getOrCreateProgress('player-d4', 'Cheater'); // no userId → no DB hydrate
      // Hydrated from a row the sanitized save could not touch: level stays 3.
      Object.assign(p, { userId: 512, hydrated: true, level: 3, xp: 0, chips: 50000, achievements: [] });
      const before = p.chips;
      pm.checkAchievements('player-d4');
      expect(p.level).toBe(3);
      expect(p.chips - before).toBe(0);
      expect(p.achievements.filter((a) => a.startsWith('lvl_'))).toEqual([]);
    } finally { warn.mockRestore(); err.mockRestore(); }
  });
});
