/**
 * R1 (2026-10-11) — AUTH-4 (P0 live mint): client-supplied table configs.
 *
 * The repro: createPrivateTable { minBuyIn: -1,000,000 } made a table whose
 * invite buy-in clamp produced -10,000,000; deductChips(-10,000,000) ran
 * `chips = chips - (-10,000,000)` (a CREDIT), sitDown seated the negative stack,
 * and leaving credited 0. Every client-created table (private, club, scheduled
 * club, club challenge) is now validated; deductChips / addChipsToUser /
 * addStarsToUser refuse non-positive or fractional amounts; PokerTable.sitDown
 * refuses a non-positive fresh buy-in.
 */
import { PokerTable } from '../src/game/PokerTable';
import { validateTableConfig, validateChallengeStakes, sanitizeTableName, TABLE_CONFIG_LIMITS } from '../src/game/tableConfigValidation';
import { handlerSrc, fnSrc, slice, load, flush, JOIN_PRECHECK_SRC } from './helpers/indexSource';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authManager = require('../src/auth/authManager') as typeof import('../src/auth/authManager');

const PRIVATE_DEFAULTS = { tableName: 'Private Table', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: (bb: number) => bb * 20 };

describe('validateTableConfig', () => {
  it('THE REPRO: minBuyIn -1,000,000 is refused (stable code, nothing created)', () => {
    expect(validateTableConfig({ smallBlind: 25, bigBlind: 50, minBuyIn: -1_000_000 }, PRIVATE_DEFAULTS))
      .toMatchObject({ ok: false, code: 'invalid_table_config' });
  });

  it('every payload the poker-3d forms send is accepted unchanged', () => {
    // CreateTableModal: preset blinds, minBuyIn = bb * 20, ante 0, maxSeats 2-9.
    for (const [sb, bb] of [[5, 10], [25, 50], [50, 100], [100, 200], [250, 500], [500, 1000]]) {
      const r = validateTableConfig({ tableName: "Ann's Home Game", variant: 'omaha', smallBlind: sb, bigBlind: bb, ante: 0, minBuyIn: bb * 20, maxSeats: 6, straddle: false, bombPot: true }, PRIVATE_DEFAULTS);
      expect(r).toEqual({ ok: true, config: { tableName: "Ann's Home Game", smallBlind: sb, bigBlind: bb, ante: 0, minBuyIn: bb * 20, maxSeats: 6, variant: 'omaha' } });
    }
    // ClubsPanel defaults (table + schedule): 25 / 50, min 1,000, max 5,000.
    expect(validateTableConfig({ tableName: 'Friday', smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 5000, maxSeats: 9 },
      { tableName: '', smallBlind: 5, bigBlind: 10, minBuyIn: (bb) => bb * 20, maxBuyIn: (bb) => bb * 100 }))
      .toEqual({ ok: true, config: { tableName: 'Friday', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000, maxBuyIn: 5000, maxSeats: 9, variant: 'texas-holdem' } });
    // Absent fields take the defaults (numeric strings are numbers).
    expect(validateTableConfig({ bigBlind: '100' }, PRIVATE_DEFAULTS)).toMatchObject({ ok: true, config: { smallBlind: 25, bigBlind: 100, minBuyIn: 2000 } });
  });

  it.each([
    ['negative min buy-in', { minBuyIn: -1 }],
    ['zero min buy-in', { minBuyIn: 0 }],
    ['fractional min buy-in', { minBuyIn: 1000.5 }],
    ['NaN', { minBuyIn: NaN }],
    ['Infinity', { minBuyIn: Infinity }],
    ['a non-numeric string', { minBuyIn: 'lots' }],
    ['a boolean', { minBuyIn: true }],
    ['an object', { smallBlind: { valueOf: (): number => 25 } }],
    ['min buy-in below 10 big blinds', { bigBlind: 50, minBuyIn: 499 }],
    ['min buy-in above 1,000 big blinds', { bigBlind: 50, minBuyIn: 50_001 }],
    ['min buy-in above the absolute cap', { smallBlind: 500_000, bigBlind: 1_000_000, minBuyIn: TABLE_CONFIG_LIMITS.MAX_MIN_BUY_IN + 1 }],
    ['negative small blind', { smallBlind: -25 }],
    ['zero small blind', { smallBlind: 0 }],
    ['big blind below the small blind', { smallBlind: 100, bigBlind: 50, minBuyIn: 5000 }],
    ['big blind 1', { smallBlind: 1, bigBlind: 1, minBuyIn: 100 }],
    ['negative ante', { ante: -10 }],
    ['ante above the big blind', { ante: 51 }],
    ['max buy-in below the min', { minBuyIn: 1000, maxBuyIn: 999 }],
    ['1 seat', { maxSeats: 1 }],
    ['10 seats', { maxSeats: 10 }],
    ['an unknown variant', { variant: 'strip-poker' }],
  ])('refused: %s', (_name, input) => {
    expect(validateTableConfig(input, PRIVATE_DEFAULTS)).toMatchObject({ ok: false, code: 'invalid_table_config' });
  });

  it('the table title is printable, single-spaced and capped (40)', () => {
    expect(sanitizeTableName('  <b>Big\n\tGame</b>  ', 'x')).toBe('b Big Game /b');
    expect(sanitizeTableName('A'.repeat(100), 'x')).toHaveLength(40);
    expect(sanitizeTableName(42, 'Fallback')).toBe('Fallback');
    expect(sanitizeTableName('   ', 'Fallback')).toBe('Fallback');
  });
});

describe('validateChallengeStakes', () => {
  it('whole chips from 100 to 10,000,000', () => {
    expect(validateChallengeStakes(100)).toEqual({ ok: true, stakes: 100 });
    expect(validateChallengeStakes('2500')).toEqual({ ok: true, stakes: 2500 });
    for (const bad of [0, -100, 99, 150.5, NaN, Infinity, 10_000_001, null, undefined, 'x', true]) {
      expect(validateChallengeStakes(bad)).toMatchObject({ ok: false, code: 'invalid_challenge_stakes' });
    }
  });
});

describe('defence in depth: authManager chip / star paths refuse bad amounts BEFORE any SQL', () => {
  const db = () => {
    const calls: Array<[string, unknown[]]> = [];
    return { calls, query: async (text: string, params?: unknown[]) => { calls.push([text, params || []]); return { rowCount: 1 }; } };
  };
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  it('deductChips: negative (the mint), zero, fractional, NaN, Infinity, non-number -> false, no query', async () => {
    for (const bad of [-10_000_000, -1, 0, 1.5, NaN, Infinity, '500' as any]) {
      const d = db();
      expect(await authManager.deductChips(7, bad, d)).toBe(false);
      expect(d.calls).toEqual([]);
    }
    expect(warn.mock.calls.some(([m]) => String(m).startsWith('[chip-amount-refused]'))).toBe(true);
    const ok = db();
    expect(await authManager.deductChips(7, 500, ok)).toBe(true);
    expect(ok.calls).toEqual([['UPDATE users SET chips = chips - $1 WHERE id = $2 AND chips >= $1', [500, 7]]]);
  });

  it('addChipsToUser: negative (an unchecked debit), fractional, NaN -> false, no query; 0 -> true, no query', async () => {
    for (const bad of [-5, 2.5, NaN, -Infinity]) {
      const d = db();
      expect(await authManager.addChipsToUser(7, bad, d)).toBe(false);
      expect(d.calls).toEqual([]);
    }
    const zero = db();
    expect(await authManager.addChipsToUser(7, 0, zero)).toBe(true);
    expect(zero.calls).toEqual([]);
    const ok = db();
    expect(await authManager.addChipsToUser(7, 1200, ok)).toBe(true);
    expect(ok.calls).toEqual([['UPDATE users SET chips = chips + $1 WHERE id = $2', [1200, 7]]]);
  });

  it('addStarsToUser: negative / fractional / NaN -> false (no pool touched); 0 -> true', async () => {
    for (const bad of [-5, 2.5, NaN]) expect(await authManager.addStarsToUser(7, bad)).toBe(false);
    expect(await authManager.addStarsToUser(7, 0)).toBe(true);
  });
});

describe('PokerTable.sitDown refuses a non-positive / non-whole fresh buy-in (a relocation may carry a busted 0)', () => {
  const mk = (minBuyIn = 1000) => new PokerTable({ tableId: 't', tableName: 't', smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn } as any);
  it('fresh buy-ins', () => {
    const t = mk(-1_000_000);                                   // a legacy table with the mint config
    for (const bad of [-10_000_000, -1, 0, 1000.5, NaN, Infinity]) expect([bad, t.sitDown(0, 'x', bad, 'p', false)]).toEqual([bad, false]);
    expect(mk().sitDown(0, 'x', 1000, 'p', false)).toBe(true);
  });
  it('relocations (allowBelowMin)', () => {
    expect(mk().sitDown(0, 'x', 0, 'p', false, true)).toBe(true);
    expect(mk().sitDown(0, 'x', 37, 'p', false, true)).toBe(true);
    expect(mk().sitDown(0, 'x', -1, 'p', false, true)).toBe(false);
    expect(mk().sitDown(0, 'x', NaN, 'p', false, true)).toBe(false);
  });
});

describe('the handlers (real src/index.ts source)', () => {
  function socketOf(id = 'S1') {
    const emitted: Array<[string, any]> = [];
    const handlers: Record<string, (d?: any) => any> = {};
    return { id, emitted, handlers, emit: (ev: string, d: any) => { emitted.push([ev, d]); }, on: (ev: string, fn: any) => { handlers[ev] = fn; }, join() {}, leave() {} };
  }
  const errorCodes = (s: any) => s.emitted.filter(([ev]: [string]) => ev === 'error' || ev === 'joinError').map(([, d]: [string, any]) => d.code);

  it('createPrivateTable: the repro payload is refused and creates nothing; a normal one is created with the validated numbers (tableKind private)', async () => {
    const created: any[] = [];
    const privateTableIds = new Set<string>();
    const code = `function wire(socket) {\n${handlerSrc('createPrivateTable', '\n  });\n')}\n}`;
    const { exports: m } = load(code, {
      assertPlayable: async () => null, emitPlayRefusal() {}, validateTableConfig, privateTableIds, bombPotPending: new Map(),
      tableManager: { createVariantTable: (cfg: any, variant: string) => { created.push({ cfg, variant }); return 'abcdef12-0000'; }, getTable: () => undefined },
      log: { warn() {} },
      // R2 (C12): creation rate limit + live-table cap + the invite code helper.
      privateTableCreateLimiter: { hit: () => true }, privateTableMeta: new Map(), MAX_LIVE_PRIVATE_TABLES_PER_ACCOUNT: 2,
      privateInviteCode: (id: string) => id.slice(0, 8).toUpperCase(),
    }, '{ wire }');
    const s = socketOf();
    m.wire(s);
    await s.handlers.createPrivateTable({ tableName: 'Mint', variant: 'texas-holdem', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: -1_000_000, maxSeats: 6 });
    expect(errorCodes(s)).toEqual(['invalid_table_config']);
    expect(created).toEqual([]);
    await s.handlers.createPrivateTable({ tableName: 'Home', variant: 'texas-holdem', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000, maxSeats: 6 });
    expect(created).toEqual([{ cfg: { tableName: 'Home', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 }, variant: 'texas-holdem' }]);
    expect(privateTableIds.has('abcdef12-0000')).toBe(true);
    expect(s.emitted).toContainEqual(['privateTableCreated', { tableId: 'abcdef12-0000', inviteCode: 'ABCDEF12' }]);
  });

  it('THE REPRO end to end on a pre-fix table (minBuyIn -1,000,000): joinTable with the REAL deductChips + sitDown mints nothing and seats nobody; control: the pre-R1 deduct + sitDown credit 1,000,000 and seat a -1,000,000 stack', async () => {
    const run = async (deduct: (uid: number, n: number) => Promise<boolean>, preR1SitDown = false) => {
      const wallet = new Map<number, number>([[7, 5000]]);
      const table = new PokerTable({ tableId: 'mint', tableName: 'm', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: -1_000_000 } as any);
      if (preR1SitDown) {
        // The pre-R1 sitDown: only `buyIn < minBuyIn` was refused.
        (table as any).sitDown = (i: number, name: string, buyIn: number, pid: string) => {
          if (buyIn < table.config.minBuyIn) return false;
          Object.assign(table.seats[i], { state: 'occupied', playerName: name, chipCount: buyIn, playerId: pid });
          return true;
        };
      }
      const code = `${JOIN_PRECHECK_SRC}\nfunction wire(socket) {\n${handlerSrc('joinTable', '\n    })(); }\n  );')}\n}`;
      const { exports: m } = load(code, {
        tableManager: { getTable: (id: string) => (id === 'mint' ? table : undefined) },
        playerSessions: new Map(), authSessions: new Map([['S1', { userId: 7, username: 'u7' }]]),
        // 2026-10-21 (gameplay F143) — the join pre-check reads the extra-table sessions / reservations.
        multiTableSessions: new Map(), reservedSeats: new Map(),
        MAX_SEATS: 9, aiProfiles: new Map(), ipSeatedSlots: new Map(), clientIp: '10.0.0.1',
        ensureChipsForBuyIn: async () => wallet.get(7)!,
        deductChips: async (uid: number, n: number) => {
          // The wallet SQL: UPDATE users SET chips = chips - $1 WHERE id = $2 AND chips >= $1
          const ok = await deduct(uid, n);
          if (ok) wallet.set(uid, wallet.get(uid)! - n);
          return ok;
        },
        addChipsToUser: async (uid: number, n: number) => { wallet.set(uid, wallet.get(uid)! + n); return true; },
        uuidv4: () => 'u1',
      }, '{ wire }');
      const s = socketOf();
      m.wire(s);
      s.handlers.joinTable({ tableId: 'mint', playerName: 'u7', seatIndex: 0, buyIn: 0 });
      await flush();
      return { wallet: wallet.get(7), seated: table.seats.filter((x) => x.state === 'occupied').length, stack: table.seats[0].chipCount, emitted: s.emitted };
    };
    // REAL authManager.deductChips against an SQL-faithful fake db.
    const realDeduct = (uid: number, n: number) => authManager.deductChips(uid, n, {
      query: async (_t: string, p?: unknown[]) => ({ rowCount: 5000 >= (p![0] as number) ? 1 : 0 }),
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fixed = await run(realDeduct);
    // The sitDown guard alone also stops it: the negative "deduct" is refunded when the seat is refused.
    const sitDownOnly = await run(async (_uid, n) => 5000 >= n);
    warn.mockRestore();
    expect([fixed.wallet, fixed.seated]).toEqual([5000, 0]);
    expect(fixed.emitted).toContainEqual(['error', { message: 'Could not deduct chips — try again' }]);
    expect([sitDownOnly.wallet, sitDownOnly.seated]).toEqual([5000, 0]);
    // CONTROL — the pre-R1 deductChips (no amount check, same SQL) and sitDown.
    const control = await run(async (_uid, n) => 5000 >= n, true);
    expect(control.wallet).toBe(5000 + 1_000_000);
    expect([control.seated, control.stack]).toEqual([1, -1_000_000]);
  });

  it('createClubTable / scheduleClubTable: a bad config is refused before anything is stored; a good one is stored validated', async () => {
    const stored: any[] = [];
    const scheduled: any[] = [];
    const code = `${fnSrc('function validateScheduledTableConfig(')}\nfunction wire(socket) {\n${handlerSrc('createClubTable', '\n  });\n')}\n${handlerSrc('scheduleClubTable', '\n  });\n')}\n}`;
    const { exports: m } = load(code, {
      validateTableConfig, authSessions: new Map([['S1', { userId: 7, username: 'u7' }]]),
      createClubTable: async (_uid: number, _club: number, cfg: any) => { stored.push(cfg); return { success: false, error: 'stop here' }; },
      scheduleTable: async (_club: number, _uid: number, cfg: any) => { scheduled.push(cfg); return { success: true }; },
    }, '{ wire }');
    const s = socketOf();
    m.wire(s);
    await s.handlers.createClubTable({ clubId: 1, config: { tableName: 'Bad', smallBlind: 25, bigBlind: 50, minBuyIn: -1_000_000 } });
    await s.handlers.scheduleClubTable({ clubId: 1, config: { tableName: 'Bad', minBuyIn: -5 }, scheduledTime: '2026-10-12T20:00', recurring: false });
    expect(errorCodes(s)).toEqual(['invalid_table_config', 'invalid_table_config']);
    expect(stored).toEqual([]);
    expect(scheduled).toEqual([]);
    await s.handlers.createClubTable({ clubId: 1, config: { tableName: 'Friday', smallBlind: 25, bigBlind: 50, minBuyIn: 1000, maxBuyIn: 5000 } });
    await s.handlers.scheduleClubTable({ clubId: 1, config: { tableName: 'Sunday', smallBlind: 25, bigBlind: 50, minBuyIn: 1000 }, scheduledTime: '2026-10-12T20:00', recurring: false });
    expect(stored).toEqual([{ tableName: 'Friday', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000, maxBuyIn: 5000, variant: 'texas-holdem' }]);
    expect(scheduled).toEqual([{ tableName: 'Sunday', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000, variant: 'texas-holdem' }]);
  });

  it('a scheduled table stored with a bad config never becomes a table (null, nothing created)', async () => {
    const created: any[] = [];
    // F104 (2026-10-21): a scheduled table fires as a REAL club table — its club_tables row
    // (clubTableForScheduledTable) and that row's runtime table (the club-table block).
    const code = fnSrc('function validateScheduledTableConfig(')
      + slice('// ========== Club tables survive a redeploy (R2, CLUBS-4) ==========', '\n  return job;\n}\n')
      + fnSrc('async function createTableFromScheduledConfig(');
    const clubTableIds = new Set<string>();
    const rows: any[] = [];
    const { exports: m } = load(code, {
      validateTableConfig, clubTableIds, getClubInfo: async () => ({ club: { name: 'C' } }), clubIdByTable: new Map(),
      clubTableForScheduledTable: async (_sid: number, clubId: number, cfg: any) => { const r = { id: rows.length + 1, clubId, ...cfg, isActive: true }; rows.push(r); return r; },
      updateClubTableId: async () => {},
      tableManager: { getTable: () => undefined, createTable: (cfg: any) => { created.push(cfg); return 'tid-1'; }, createVariantTable: (cfg: any) => { created.push(cfg); return 'tid-2'; } },
    }, '{ createTableFromScheduledConfig }');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await m.createTableFromScheduledConfig({ id: 1, clubId: 1 }, { minBuyIn: -1_000_000 })).toBeNull();
    warn.mockRestore();
    expect(created).toEqual([]);
    expect(rows).toEqual([]);
    expect(await m.createTableFromScheduledConfig({ id: 1, clubId: 1 }, { tableName: 'Sun', smallBlind: 25, bigBlind: 50, minBuyIn: 1000 })).toBe('tid-1');
    expect(created).toEqual([{ tableName: '[C] Sun', smallBlind: 25, bigBlind: 50, ante: 0, minBuyIn: 1000 }]);
    expect(clubTableIds.has('tid-1')).toBe(true);
  });

  it('club challenges: bad stakes are refused at create; a stored bad challenge is closed at accept without a table', async () => {
    const createdChallenges: any[] = [];
    const resolved: any[] = [];
    const tables: any[] = [];
    const code = `function wire(socket) {\n${handlerSrc('createClubChallenge', '\n  });\n')}\n${handlerSrc('acceptClubChallenge', '\n  });\n')}\n}`;
    const { exports: m } = load(code, {
      assertPlayable: async () => null, emitPlayRefusal() {}, validateChallengeStakes,
      authSessions: new Map([['S1', { userId: 7, username: 'u7' }]]),
      createChallenge: async (_c: number, _a: number, _b: number, stakes: number) => { createdChallenges.push(stakes); return { success: true }; },
      acceptChallenge: async () => ({ success: true, challenge: { id: 9, clubId: 1, challengerId: 3, challengedId: 7, stakes: -1_000_000 } }),
      resolveChallenge: async (id: number, winner: number | null) => { resolved.push([id, winner]); },
      tableManager: { createTable: (cfg: any) => { tables.push(cfg); return 'ct'; } },
    }, '{ wire }');
    const s = socketOf();
    m.wire(s);
    await s.handlers.createClubChallenge({ clubId: 1, challengedId: 3, stakes: -1_000_000 });
    await s.handlers.createClubChallenge({ clubId: 1, challengedId: 3, stakes: 0 });
    await s.handlers.createClubChallenge({ clubId: 1, challengedId: 3, stakes: 500 });
    expect(createdChallenges).toEqual([500]);
    await s.handlers.acceptClubChallenge({ challengeId: 9 });
    expect(resolved).toEqual([[9, null]]);
    expect(tables).toEqual([]);
    expect(errorCodes(s)).toEqual(['invalid_challenge_stakes', 'invalid_challenge_stakes', 'invalid_challenge_stakes']);
  });
});
