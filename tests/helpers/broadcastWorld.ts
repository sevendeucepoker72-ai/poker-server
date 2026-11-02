/**
 * 2026-11-02 (.online tournament broadcast) — a broadcast WORLD for tests: a
 * running online qualifier on the REAL TournamentManager and REAL PokerTables
 * ("Qualifier Table 1..N"), its qualifierTournaments registry entry (master
 * ids, local ids, a seat package) and the BroadcastWorldFull view index.ts
 * builds — with a fake opt-out cache (per local id: true / false / unknown).
 */
import { PokerTable } from '../../src/game/PokerTable';
import { TournamentManager } from '../../src/game/TournamentManager';
import type { BroadcastWorldFull } from '../../src/broadcast/wire';
import type { HandForHandView } from '../../src/broadcast/broadcastSnapshot';
import type { QualifierRegView } from '../../src/broadcast/eventKey';

export const DEFAULT_NAMES = [
  'John Smith', 'Mary Ann Lee', 'Zed', '720-555-1234', 'Opt Out Guy', 'Unknown Person', 'Averyveryverylongname Smith', 'Kim Park',
];

export interface BroadcastTestWorld {
  tm: TournamentManager;
  tid: string;
  qualId: string;
  qt: QualifierRegView & { players: any[] };
  qualifiers: Map<string, any>;
  tables: Map<string, PokerTable>;
  tableIds: string[];
  tableOf: Map<string, string>;
  players: Array<{ playerId: string; masterId: string; localUserId: number; name: string }>;
  optOuts: Map<number, boolean>;
  hfh: Map<string, HandForHandView>;
  clock: { value: Record<string, unknown> | null };
  engineIds: Set<string>;
  world: BroadcastWorldFull;
  /** Seat a player id's seat as busted (0 chips, eliminated) and eliminate him in the engine. */
  bust(playerId: string, eliminatorId?: string): void;
}

export function qualifierWorld(o: { names?: string[]; tables?: number; seatPackage?: Record<number, number> | null; startingStack?: number } = {}): BroadcastTestWorld {
  const names = o.names || DEFAULT_NAMES;
  const nTables = o.tables ?? 2;
  const stack = o.startingStack ?? 5000;
  const tm = new TournamentManager();
  const tid = tm.createTournament({
    name: 'Qualifier Tournament', buyIn: 0, prizePool: 0, maxPlayers: 40, startInterval: 0,
    blindLevels: [{ sb: 25, bb: 50, ante: 0, duration: 720 }, { sb: 50, bb: 100, ante: 0, duration: 720 }], startingChips: stack,
  } as any);
  const players = names.map((name, i) => ({ playerId: `user-${101 + i}`, masterId: `m-0000-${101 + i}`, localUserId: 101 + i, name }));
  players.forEach((p, i) => tm.registerPlayer(tid, p.playerId, p.name, `s${i}`, undefined, p.masterId));
  if (!tm.startTournament(tid)) throw new Error('tournament did not start');
  const tables = new Map<string, PokerTable>();
  const tableIds: string[] = [];
  const tableOf = new Map<string, string>();
  for (let k = 0; k < nTables; k++) {
    const id = `QT${k + 1}`;
    tables.set(id, new PokerTable({ tableId: id, tableName: `Qualifier Table ${k + 1}`, smallBlind: 25, bigBlind: 50, minBuyIn: stack, maxBuyIn: stack, maxPlayers: 9 } as any));
    tableIds.push(id);
    tableOf.set(id, tid);
  }
  players.forEach((p, i) => {
    const id = tableIds[i % nTables];
    const seat = Math.floor(i / nTables);
    tables.get(id)!.sitDown(seat, p.name, stack, p.playerId, false);
    tm.setPlayerTable(tid, p.playerId, id);
  });
  tm.setTableIds(tid, tableIds.slice());
  const qualId = 'Q-weekly-1';
  const qt: any = {
    qualifierType: 'weekly', qualifierName: 'Sunday Weekly Qualifier', scheduledAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    startingStack: stack, masterQualifierId: qualId, status: 'running', tournamentId: tid, finishedAt: null, results: null,
    seatPackage: o.seatPackage === undefined ? { 1: 3, 2: 2, 3: 1 } : o.seatPackage,
    players: players.map((p) => ({ playerId: p.playerId, masterPlayerId: p.masterId, localUserId: p.localUserId, playerName: p.name, phone: '', socketId: '' })),
  };
  const qualifiers = new Map<string, any>([[qualId, qt]]);
  const optOuts = new Map<number, boolean>();
  players.forEach((p) => {
    if (p.name === 'Opt Out Guy') optOuts.set(p.localUserId, true);
    else if (p.name !== 'Unknown Person') optOuts.set(p.localUserId, false);
  });
  const hfh = new Map<string, HandForHandView>();
  const clock = { value: null as Record<string, unknown> | null };
  const engineIds = new Set<string>([tid]);
  const world: BroadcastWorldFull = {
    now: () => Date.now(),
    qualifiers: () => qualifiers.entries(),
    tournament: (id) => tm.getTournament(id),
    isQualifierEngineTournament: (id) => engineIds.has(id),
    table: (id) => tables.get(id) as any,
    tournamentIdOfTable: (id) => tableOf.get(id),
    clockOf: () => clock.value,
    handForHandOf: (id) => hfh.get(id) ?? null,
    payoutTableOf: (id) => { const t = tm.getTournament(id); return t ? tm.payoutTableOf(t) : null; },
    lateEntryClosedAtBubble: (id) => tm.lateEntryClosedAtBubble(id),
    optOut: (ids) => (ids.userId !== undefined && ids.userId !== null ? optOuts.get(ids.userId) : undefined),
    sitGoTournaments: () => [],
    // 2026-11-02 (broadcast P2-S3) — the featured-table frame's view (index.ts: tableManager.getTable).
    frameTable: (id) => tables.get(id),
    turnOf: () => null,
    sittingOutOf: () => null,
  };
  const bust = (playerId: string, eliminatorId?: string) => {
    for (const t of tables.values()) {
      const s = t.seats.find((x) => x.playerId === playerId && x.state === 'occupied');
      if (s) { s.chipCount = 0; s.eliminated = true; }
    }
    tm.eliminatePlayer(tid, playerId, eliminatorId);
  };
  return { tm, tid, qualId, qt, qualifiers, tables, tableIds, tableOf, players, optOuts, hfh, clock, engineIds, world, bust };
}

const SHOW_PHASES = new Set(['Showdown', 'HandComplete']);
/**
 * 2026-11-02 (P2-S3) — the deep scan for PUBLIC payloads that MAY carry a table
 * frame (snapshots, bc:frame {kind:'table'}, producer states): the only cards
 * allowed are a frame's `board`, and a seat's `holeCards` when that frame is a
 * CONTESTED showdown (Showdown / HandComplete, handResult present) and the seat
 * is listed in handResult.showdownSeats, did not fold and did not muck. Every
 * other card object, and every id / seed / deck / name key, is a problem.
 */
export function deepScanBroadcast(payload: unknown, forbiddenStrings: string[] = []): string[] {
  const BANNED_KEYS = new Set(['yourCards', 'yourSeat', 'seed', 'playerId', 'masterUserId', 'userId', 'phone', 'publicId', 'communityCards', 'deck', 'burn', 'burnCards', 'localUserId', 'masterPlayerId', 'playerName', 'bestFiveCards', 'showdownHands']);
  const problems: string[] = [];
  const isCard = (c: any) => !!c && typeof c === 'object' && 'rank' in c && 'suit' in c && Object.keys(c).length === 2
    && Number.isInteger(c.rank) && c.rank >= 2 && c.rank <= 14 && Number.isInteger(c.suit) && c.suit >= 0 && c.suit <= 3;
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      const o = v as Record<string, any>;
      const isFrame = typeof o.tableId === 'string' && Array.isArray(o.seats) && Array.isArray(o.board);
      if ('rank' in o && 'suit' in o) problems.push(`card object at ${path}`);
      for (const [k, x] of Object.entries(o)) {
        if (BANNED_KEYS.has(k)) { problems.push(`banned key ${path}.${k}`); continue; }
        if (k === 'holeCards' && x === false) continue;                       // Feed.holeCards flag
        if (isFrame && k === 'board') {
          if (!x.every(isCard) || x.length > 5) problems.push(`bad board at ${path}.board`);
          continue;
        }
        if (isFrame && k === 'seats') {
          (x as any[]).forEach((s, i) => {
            const p = `${path}.seats[${i}]`;
            for (const [sk, sx] of Object.entries(s || {})) {
              if (BANNED_KEYS.has(sk)) { problems.push(`banned key ${p}.${sk}`); continue; }
              if (sk === 'holeCards') {
                if (sx === null) continue;
                const hr = o.handResult;
                const ok = SHOW_PHASES.has(o.phase) && !!hr && Array.isArray(hr.showdownSeats) && hr.showdownSeats.includes(s.seatIndex)
                  && !(hr.muckedSeats || []).includes(s.seatIndex) && s.folded === false && s.mucked !== true
                  && Array.isArray(sx) && sx.length > 0 && sx.every(isCard);
                if (!ok) problems.push(`hole cards outside a contested showdown at ${p} (phase ${o.phase})`);
                continue;
              }
              walk(sx, `${p}.${sk}`);
            }
          });
          continue;
        }
        if (k === 'holeCards') { problems.push(`holeCards outside a table frame seat at ${path}`); continue; }
        walk(x, `${path}.${k}`);
      }
      return;
    }
    if (typeof v === 'string') for (const f of forbiddenStrings) if (f && v.includes(f)) problems.push(`forbidden string "${f}" at ${path}`);
  };
  walk(payload, '$');
  return problems;
}

/**
 * 2026-11-02 (P2-S4 / P2-S9) — an in-memory Postgres for the broadcast tables: the
 * exact statements broadcastToken.ts / programStore.ts send (broadcast_tokens insert /
 * select / revoke; broadcast_channels upsert / select). `fail` makes every query throw.
 */
export function fakeBroadcastDb() {
  const tokens = new Map<string, any>();
  const channels = new Map<string, any>();
  const queries: string[] = [];
  const db = {
    fail: false,
    tokens,
    channels,
    queries,
    async query(sql: string, params: unknown[] = []): Promise<{ rows: any[] }> {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      if (db.fail) throw new Error('db down');
      if (/^\s*INSERT INTO broadcast_tokens/.test(sql)) {
        const [jti, ev, scopes, label, m, u, nbf, exp, parent] = params as any[];
        tokens.set(jti, { jti, ev, scopes, label, issued_by_master: m, issued_by_user: u, nbf: new Date(nbf), exp: new Date(exp), revoked_at: null, created_at: new Date(), parent_jti: parent ?? null });
        return { rows: [] };
      }
      if (/^\s*SELECT jti, ev, scopes/.test(sql)) return { rows: [...tokens.values()].map((r) => ({ ...r })) };
      if (/^\s*UPDATE broadcast_tokens SET revoked_at/.test(sql)) {
        // jti = $1 (one) or jti = ANY($1::text[]) (a key and the keys minted from it).
        const ids = Array.isArray(params[0]) ? (params[0] as string[]) : [params[0] as string];
        for (const id of ids) {
          const r = tokens.get(id);
          if (r && !r.revoked_at) r.revoked_at = new Date();
        }
        return { rows: [] };
      }
      if (/^\s*INSERT INTO broadcast_channels/.test(sql)) {
        const [channel, eventKey, by] = params as any[];
        channels.set(channel, { channel, event_key: eventKey, updated_by: by });
        return { rows: [] };
      }
      if (/^\s*SELECT channel, event_key/.test(sql)) return { rows: [...channels.values()].map((r) => ({ ...r })) };
      throw new Error(`fakeBroadcastDb: unexpected SQL ${sql.slice(0, 60)}`);
    },
  };
  return db;
}

/** Every problem a PUBLIC payload must never have: a card object, an id / seed / card key, a raw account id string. */
export function deepScanPublic(payload: unknown, forbiddenStrings: string[] = []): string[] {
  const BANNED_KEYS = new Set(['holeCards', 'yourCards', 'seed', 'playerId', 'masterUserId', 'userId', 'phone', 'publicId', 'communityCards', 'board', 'deck', 'burn', 'burnCards', 'localUserId', 'masterPlayerId']);
  const problems: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if ('rank' in o && 'suit' in o) problems.push(`card object at ${path}`);
      for (const [k, x] of Object.entries(o)) {
        // Feed.holeCards is a boolean FLAG (false on the public feed): no card data. Anything else is banned.
        if (BANNED_KEYS.has(k) && !(k === 'holeCards' && x === false)) problems.push(`banned key ${path}.${k}`);
        walk(x, `${path}.${k}`);
      }
      return;
    }
    if (typeof v === 'string') for (const f of forbiddenStrings) if (f && v.includes(f)) problems.push(`forbidden string "${f}" at ${path}`);
  };
  walk(payload, '$');
  return problems;
}
