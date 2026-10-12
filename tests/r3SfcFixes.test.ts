/**
 * .online R3 (2026-10-11) — SF-C fixes, running the REAL src/index.ts text
 * (sliced + transpiled — index.ts boots a server on import) or the real module:
 *   K1-6       setFastMode sets the socket's extra-table seats too; a new extra
 *              seat starts with the main session's choice (the restore paths are
 *              in absentSeat.test.ts / rebalanceSafety.test.ts)
 *   AUTH-P3-1  voiceOffer / voiceAnswer / voiceIce / coachWhisper reach only a
 *              live socket sharing the voice room / table room
 *   AUTH-P3-2  /api/health identityGuard.stampDurable is true on TEXT too
 *   AUTH-P3-3  play tickets are burned durably (used_play_tickets)
 *   AUTH-P3-4  enableDealersChoice: a seated player, a ring table only
 *   GAME-P3-10 the AI opponent model is keyed by player id, not display name
 *   OPS-P3-2   no login handle (phone numbers) in [AUDIT] / ticket-login logs
 *   OPS-4/5    Node 22 in every build file; Railway deploy healthcheck
 * Each has a CONTROL (or wiring check) that reproduces the pre-R3 behaviour.
 */
import fs from 'fs';
import path from 'path';
import { PokerTable, GamePhase, PlayerAction } from '../src/game/PokerTable';
import {
  createTicketReplayGuard, initUsedPlayTicketsTable, ticketHash, ticketReplayStats, TICKET_HASH_TTL_MS,
} from '../src/auth/ticketReplay';
import {
  recordOpponentObservation, categorizeOpponent, getActiveOpponentKeys, opponentModelKey, getOpponentProfile,
  opponentProfileCount, OPPONENT_PROFILES_CAP,
} from '../src/ai/AIPlayer';
import { createFakePokerDb } from './helpers/fakePokerDb';
import { SRC, slice, fnSrc, handlerSrc, load, flush, SEAT_IDENTITY_SRC } from './helpers/indexSource';

const ROOT = path.join(__dirname, '..');
const quiet = { log() {}, warn() {}, error() {} };

/** A fake socket.io socket: rooms, emits, handler registration. */
function fakeSocket(id: string, rooms: string[] = []) {
  const handlers: Record<string, (...a: any[]) => any> = {};
  const emitted: Array<[string, any]> = [];
  return {
    id, handlers, emitted, rooms: new Set<string>([id, ...rooms]),
    on: (ev: string, fn: any) => { handlers[ev] = fn; },
    emit: (ev: string, d: any) => { emitted.push([ev, d]); },
    join(r: string) { this.rooms.add(r); }, leave(r: string) { this.rooms.delete(r); },
  };
}

// ── K1-6 ───────────────────────────────────────────────────────────────────
describe('R3 (K1-6) — fast mode is the PLAYER\'s choice: his extra-table seats follow it', () => {
  const HANDLER = handlerSrc('setFastMode', '\n  });\n');
  function world(code = HANDLER) {
    const playerSessions = new Map<string, any>([['S1', { socketId: 'S1', tableId: 'T1', seatIndex: 0, sittingOut: false }]]);
    const multiTableSessions = new Map<string, any[]>([['S1', [{ socketId: 'S1', tableId: 'T2', seatIndex: 3, sittingOut: false }]]]);
    const authSessions = new Map<string, any>([['S1', { userId: 7, username: 'u7' }]]);
    const scope = { playerSessions, multiTableSessions, authSessions };
    const { exports: m } = load(`function wire(socket) {\n${code}\n}\n${fnSrc('function tableWantsFastBots(')}`, scope, '{ wire, tableWantsFastBots }');
    const s = fakeSocket('S1');
    m.wire(s);
    return { m, s, playerSessions, multiTableSessions };
  }

  it('setFastMode {enabled:true}: the main seat AND the extra-table seat get fast bots; the client is told', async () => {
    const w = world();
    await w.s.handlers.setFastMode({ enabled: true });
    expect(w.m.tableWantsFastBots('T1')).toBe(true);
    expect(w.m.tableWantsFastBots('T2')).toBe(true);
    expect(w.s.emitted).toEqual([['fastModeSet', { enabled: true }]]);
    await w.s.handlers.setFastMode({ enabled: false });
    expect(w.m.tableWantsFastBots('T2')).toBe(false);
  });

  it('CONTROL — pre-R3: only the main session changed; the extra table never got fast bots although the toggle showed ON', async () => {
    const LINE = '    for (const extra of multiTableSessions.get(socket.id) || []) if (extra) extra.fastMode = session.fastMode;\n';
    expect(HANDLER).toContain(LINE);
    const w = world(HANDLER.replace(LINE, ''));
    await w.s.handlers.setFastMode({ enabled: true });
    expect(w.m.tableWantsFastBots('T1')).toBe(true);
    expect(w.m.tableWantsFastBots('T2')).toBe(false);
  });

  it('wiring: a new extra-table seat starts with the main session\'s choice; the per-player state carries fastMode', () => {
    const join = handlerSrc('joinAdditionalTable', '\n  });\n');
    expect(join).toContain('...(playerSessions.get(socket.id)?.fastMode ? { fastMode: true } : {}),');
    const bc = fnSrc('function broadcastGameState(');
    expect(bc.split('state.fastMode = session.fastMode === true;').length - 1).toBe(2);   // main + extra-table sessions
  });
});

// ── AUTH-P3-1 ──────────────────────────────────────────────────────────────
describe('R3 (AUTH-P3-1) — voice signals and coach whispers reach only a socket sharing the room', () => {
  const VOICE = slice('  // ========== WebRTC Voice Chat Signaling ==========', '  // ========== Staking Marketplace ==========');
  const COACH = handlerSrc('coachWhisper', '\n  });\n');
  const RELAY = fnSrc('function relayPeerSharingRoom(');
  function world(code = `${RELAY}\nfunction wire(socket) {\n${VOICE}\n${COACH}\n}`) {
    const live = new Map<string, any>();
    const roomEmits: Array<[string, string, any]> = [];
    const authSessions = new Map<string, any>();
    const playerSessions = new Map<string, any>();
    const { exports: m } = load(code, {
      authSessions, playerSessions, seatNameForSocket: () => 'Pub Name', publicNameForUser: async () => 'Coach Pub',
      io: { sockets: { sockets: live }, to: (r: string) => ({ emit: (ev: string, d: any) => roomEmits.push([r, ev, d]) }) },
    }, '{ wire }');
    const sock = (id: string, rooms: string[] = [], uid = 1) => {
      const s = fakeSocket(id, rooms);
      live.set(id, s);
      authSessions.set(id, { userId: uid, username: `u${uid}` });
      m.wire(s);
      return s;
    };
    return { sock, roomEmits, live };
  }

  it('A and B in voice_T1: an offer / answer / ICE candidate is relayed between them', async () => {
    const w = world();
    const a = w.sock('A', ['voice_T1', 'table:T1'], 1);
    const b = w.sock('B', ['voice_T1', 'table:T1'], 2);
    await b.handlers.voiceOffer({ to: 'A', offer: { sdp: 'o' } });
    await a.handlers.voiceAnswer({ to: 'B', answer: { sdp: 'a' } });
    await a.handlers.voiceIce({ to: 'B', candidate: { c: 1 } });
    expect(a.emitted).toEqual([['voiceOffer', { from: 'B', offer: { sdp: 'o' }, username: 'Pub Name' }]]);
    expect(b.emitted).toEqual([['voiceAnswer', { from: 'A', answer: { sdp: 'a' } }], ['voiceIce', { from: 'A', candidate: { c: 1 } }]]);
  });

  it('a socket in ANOTHER table\'s voice room, a room name, a gone socket or itself: nothing relayed', async () => {
    const w = world();
    const a = w.sock('A', ['voice_T1'], 1);
    const c = w.sock('C', ['voice_T2'], 3);
    const x = w.sock('X', [], 4);                               // in no voice room
    await x.handlers.voiceOffer({ to: 'A', offer: {} });
    await c.handlers.voiceIce({ to: 'A', candidate: {} });
    await a.handlers.voiceOffer({ to: 'voice_T1', offer: {} }); // a ROOM name
    await a.handlers.voiceOffer({ to: 'table:T1', offer: {} });
    await a.handlers.voiceOffer({ to: 'GONE', offer: {} });
    await a.handlers.voiceOffer({ to: 'A', offer: {} });
    expect(a.emitted).toEqual([]);
    expect(c.emitted).toEqual([]);
    expect(w.roomEmits).toEqual([]);
  });

  it('coachWhisper: only to a socket at the coach\'s table (seated or watching), a bounded string', async () => {
    const w = world();
    const coach = w.sock('COACH', ['table:T1'], 9);
    const student = w.sock('STU', ['table:T1'], 2);
    const other = w.sock('OTHER', ['table:T2'], 3);
    await coach.handlers.coachWhisper({ targetSocketId: 'STU', message: 'x'.repeat(900) });
    await coach.handlers.coachWhisper({ targetSocketId: 'OTHER', message: 'hi' });
    await coach.handlers.coachWhisper({ targetSocketId: 'table:T2', message: 'hi all' });
    await coach.handlers.coachWhisper({ targetSocketId: 'STU', message: { html: '<b>' } });
    await flush();
    expect(student.emitted).toEqual([['coachWhisper', { message: 'x'.repeat(500), coachName: 'Coach Pub' }]]);
    expect(other.emitted).toEqual([]);
    expect(w.roomEmits).toEqual([]);
  });

  it('CONTROL — pre-R3 relays (io.to(<client string>)): a stranger reached A, and a ROOM name reached a whole table', async () => {
    const pre = `${RELAY}\nfunction wire(socket) {\n${VOICE.split("relayPeerSharingRoom(socket, data.to, 'voice_')?.emit(").join('io.to(data.to).emit(')}\n}`;
    expect(pre).toContain('io.to(data.to).emit(');
    const w = world(pre);
    w.sock('A', ['voice_T1'], 1);
    const x = w.sock('X', [], 4);
    await x.handlers.voiceOffer({ to: 'A', offer: {} });
    await x.handlers.voiceOffer({ to: 'table:T1', offer: {} });
    expect(w.roomEmits.map(([r, ev]) => [r, ev])).toEqual([['A', 'voiceOffer'], ['table:T1', 'voiceOffer']]);
  });
});

// ── AUTH-P3-2 ──────────────────────────────────────────────────────────────
describe('R3 (AUTH-P3-2) — identityGuard.stampDurable reports the real durability', () => {
  const { exports: m } = load(fnSrc('function statsStampDurable('), {}, '{ statsStampDurable }');
  it('jsonb and TEXT are durable; a missing column / failed probe is not; not probed yet = null', () => {
    expect(m.statsStampDurable('jsonb')).toBe(true);
    expect(m.statsStampDurable('text')).toBe(true);           // prod — it said false
    expect(m.statsStampDurable('absent')).toBe(false);
    expect(m.statsStampDurable('probe_failed:timeout')).toBe(false);
    expect(m.statsStampDurable(null)).toBeNull();
  });
  it('wiring: /api/health uses it (the old `=== \'jsonb\'` is gone)', () => {
    expect(SRC).toContain('stampDurable: statsStampDurable(_statsColumnType),');
    expect(SRC).not.toContain("stampDurable: _statsColumnType === 'jsonb'");
  });
});

// ── AUTH-P3-3 ──────────────────────────────────────────────────────────────
describe('R3 (AUTH-P3-3) — play tickets are burned durably (used_play_tickets)', () => {
  const TOKEN = 'eyJ.play-online-ticket.sig';
  const stats0 = () => ({ ...ticketReplayStats });

  it('the boot DDL creates the ledger; the first claim inserts ONE row keyed by the SHA-256 (the ticket itself is never stored)', async () => {
    const db = createFakePokerDb();
    await initUsedPlayTicketsTable(db.pool as any);
    expect(db.statements.some((s) => s.startsWith('CREATE TABLE IF NOT EXISTS used_play_tickets'))).toBe(true);
    const g = createTicketReplayGuard(() => db.pool as any, { warn() {} });
    expect(await g.claim(TOKEN)).toBe(true);
    expect([...db.usedTickets.keys()]).toEqual([ticketHash(TOKEN)]);
    expect(ticketHash(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([...db.usedTickets.keys()])).not.toContain('play-online');
  });

  it('a second use in the same process is refused at once (memory), before any DB call', async () => {
    const db = createFakePokerDb();
    const g = createTicketReplayGuard(() => db.pool as any, { warn() {} });
    const before = stats0();
    const [first, second] = await Promise.all([g.claim(TOKEN), g.claim(TOKEN)]);
    expect([first, second]).toEqual([true, false]);
    expect(ticketReplayStats.refusedMemory - before.refusedMemory).toBe(1);
    expect(db.statements.filter((s) => s.startsWith('INSERT INTO used_play_tickets'))).toHaveLength(1);
  });

  it('a RESTART (new process, empty memory) and the OTHER process of a deploy overlap both refuse it — the ledger answers', async () => {
    const db = createFakePokerDb();
    const oldProcess = createTicketReplayGuard(() => db.pool as any, { warn() {} });
    const newProcess = createTicketReplayGuard(() => db.pool as any, { warn() {} });
    const before = stats0();
    expect(await oldProcess.claim(TOKEN)).toBe(true);
    expect(newProcess.memorySize()).toBe(0);
    expect(await newProcess.claim(TOKEN)).toBe(false);
    expect(ticketReplayStats.refusedDurable - before.refusedDurable).toBe(1);
    expect(await newProcess.claim('another-ticket')).toBe(true);   // a fresh ticket still works
  });

  it('CONTROL — the pre-R3 in-memory guard: a restart forgot the ticket and accepted it again', () => {
    const memoryOnly = () => { const used = new Set<string>(); return (t: string) => (used.has(t) ? false : (used.add(t), true)); };
    expect(memoryOnly()(TOKEN)).toBe(true);
    expect(memoryOnly()(TOKEN)).toBe(true);                     // the "restarted" process: replay accepted
  });

  it('a DB that cannot answer falls back to the in-memory guard (sign-in not blocked; counted)', async () => {
    const db = createFakePokerDb();
    db.failNext(/used_play_tickets/, 1);
    const warns: string[] = [];
    const g = createTicketReplayGuard(() => db.pool as any, { warn: (m) => warns.push(m) });
    const before = stats0();
    expect(await g.claim(TOKEN)).toBe(true);
    expect(await g.claim(TOKEN)).toBe(false);                    // still burned in this process
    expect(ticketReplayStats.durableErrors - before.durableErrors).toBe(1);
    expect(warns.join('\n')).toContain('[ticket-replay] durable claim failed');
    const noPool = createTicketReplayGuard(() => { throw new Error('DB not initialized'); }, { warn() {} });
    expect(await noPool.claim('t2')).toBe(true);
  });

  it('expired rows are pruned (TTL); the memory entry expires with the same TTL', async () => {
    let now = Date.parse('2026-10-11T12:00:00Z');
    const db = createFakePokerDb();
    db.setClock(() => now);
    const g = createTicketReplayGuard(() => db.pool as any, { now: () => now, warn() {} });
    expect(await g.claim(TOKEN)).toBe(true);
    expect(await g.prune()).toBe(0);
    now += TICKET_HASH_TTL_MS + 1000;
    expect(await g.prune()).toBe(1);
    expect(db.usedTickets.size).toBe(0);
  });

  it('wiring: both ticket paths AWAIT the durable claim; the boot creates the table and prunes hourly; /api/health shows the counters', () => {
    expect(handlerSrc('authWithTicket', "\n    })\n  );\n")).toContain("if (!(await markTicketUsed(data.token))) {");
    expect(handlerSrc('joinWithWaitlistContext', '\n    }\n  );')).toContain("if (!(await markTicketUsed(data.token))) {");
    expect(fnSrc('function markTicketUsed(')).toContain('return playTicketGuard.claim(token);');
    expect(SRC).toContain('const playTicketGuard = createTicketReplayGuard(() => getPool());');
    expect(SRC).toContain('try { await initUsedPlayTicketsTable(getPool()); }');
    expect(SRC).toContain('setInterval(() => { void playTicketGuard.prune(); }, 60 * 60_000).unref?.();');
    expect(SRC).toContain('ticketReplayGuard: { ...ticketReplayStats },');
    expect(SRC).not.toContain('usedTicketHashes');
  });
});

// ── AUTH-P3-4 ──────────────────────────────────────────────────────────────
describe('R3 (AUTH-P3-4) — Dealer\'s Choice: a seated player, a ring table only', () => {
  const HANDLER = handlerSrc('enableDealersChoice', '\n  });\n');
  function world(kind: 'cash' | 'private' | 'club' | 'tournament' | 'headsup' | 'challenge', code = HANDLER) {
    const t = new PokerTable({ tableId: 'T', tableName: 'T', smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 400 } as any);
    expect(t.sitDown(0, 'Alice', 2000, 'user_1', false)).toBe(true);
    expect(t.sitDown(1, 'Bot', 2000, 'ai-1', true)).toBe(true);
    const playerSessions = new Map<string, any>([
      ['SA', { socketId: 'SA', tableId: 'T', seatIndex: 0, playerId: 'user_1' }],
      ['SPEC', { socketId: 'SPEC', tableId: 'OTHER', seatIndex: 2, playerId: 'user_3' }],
    ]);
    const multiTableSessions = new Map<string, any[]>();
    const dealersChoiceState = new Map<string, any>();
    const room: Array<[string, string, any]> = [];
    const set = (k: string) => (kind === k ? new Set(['T']) : new Set<string>());
    const { exports: m } = load(
      `${fnSrc('function tableKindOf(')}\n${fnSrc('function dealersChoiceAllowedAt(')}\n${SEAT_IDENTITY_SRC}\n${fnSrc('function socketSeatedAt(')}\nfunction wire(socket) {\n${code}\n}`,
      {
        playerSessions, multiTableSessions, dealersChoiceState, DEALERS_CHOICE_VARIANTS: ['texas-holdem', 'omaha'],
        tableManager: { getTable: (id: string) => (id === 'T' ? t : undefined) },
        isTournamentTable: (id: string) => kind === 'tournament' && id === 'T',
        spinGoMultipliers: new Map(), careerTables: new Set(), allInOrFoldTables: new Set(),
        challengeTables: set('challenge'), clubTableIds: kind === 'club' || kind === 'challenge' ? new Set(['T']) : new Set(),
        quickTables: kind === 'headsup' || kind === 'challenge' ? new Set(['T']) : new Set(), privateTableIds: set('private'),
        io: { to: (r: string) => ({ emit: (ev: string, d: any) => room.push([r, ev, d]) }) }, broadcastGameState() {},
      }, '{ wire }');
    const sock = (id: string) => { const s = fakeSocket(id); m.wire(s); return s; };
    return { t, sock, dealersChoiceState, room };
  }

  it.each(['cash', 'private', 'club'] as const)('%s table: the seated player turns it on (everyone told)', async (kind) => {
    const w = world(kind);
    const a = w.sock('SA');
    await a.handlers.enableDealersChoice({ enabled: true });
    expect(w.dealersChoiceState.get('T')).toMatchObject({ enabled: true });
    expect(w.room).toEqual([['table:T', 'dealersChoiceToggled', { tableId: 'T', enabled: true, currentVariant: 'texas-holdem' }]]);
  });

  it.each(['tournament', 'headsup', 'challenge'] as const)('%s table: refused dealers_choice_not_allowed; nothing changes', async (kind) => {
    const w = world(kind);
    const a = w.sock('SA');
    await a.handlers.enableDealersChoice({ enabled: true });
    expect(w.dealersChoiceState.size).toBe(0);
    expect(w.room).toEqual([]);
    expect(a.emitted).toEqual([['error', expect.objectContaining({ code: 'dealers_choice_not_allowed' })]]);
  });

  it('a socket not seated at that table (another table, no session, a stood-up seat) changes nothing', async () => {
    const w = world('cash');
    await w.sock('SPEC').handlers.enableDealersChoice({ tableId: 'T', enabled: true });
    await w.sock('NOBODY').handlers.enableDealersChoice({ tableId: 'T', enabled: true });
    w.t.standUp(0);
    await w.sock('SA').handlers.enableDealersChoice({ enabled: true });
    expect(w.dealersChoiceState.size).toBe(0);
    expect(w.room).toEqual([]);
  });

  it('CONTROL — pre-R3: a tournament seat switched the label on for the whole tournament table', async () => {
    const PRE = `  socket.on('enableDealersChoice', async (data) => {
    const session = playerSessions.get(socket.id);
    if (!session) return;
    const tableId = data?.tableId || session.tableId;
    if (session.tableId !== tableId) return;
    const table = tableManager.getTable(tableId);
    if (!table) return;
    if (data.enabled) dealersChoiceState.set(tableId, { enabled: true });
    io.to(\`table:\${tableId}\`).emit('dealersChoiceToggled', { tableId, enabled: data.enabled });
  });`;
    const w = world('tournament', PRE);
    await w.sock('SA').handlers.enableDealersChoice({ enabled: true });
    expect(w.dealersChoiceState.get('T')).toMatchObject({ enabled: true });
  });
});

// ── GAME-P3-10 ─────────────────────────────────────────────────────────────
describe('R3 (GAME-P3-10) — the AI opponent model is keyed by player id, never the display name', () => {
  /** n hands of the given style recorded for `key`. */
  const play = (key: string, n: number, style: 'nit' | 'maniac', from = 0) => {
    for (let h = 0; h < n; h++) {
      recordOpponentObservation(key, 'hand_start', { handNumber: from + h });
      if (style === 'maniac') { recordOpponentObservation(key, 'vpip'); recordOpponentObservation(key, 'pfr'); }
    }
  };

  it('two players both named "Player": a nit and a maniac keep SEPARATE reads', () => {
    const t = new PokerTable({ tableId: 'G', tableName: 'G', smallBlind: 10, bigBlind: 20, ante: 0, minBuyIn: 400 } as any);
    t.sitDown(0, 'Bot', 2000, 'ai-g10-bot', true);
    t.sitDown(1, 'Player', 2000, 'user_g10_a', false);
    t.sitDown(2, 'Player', 2000, 'user_g10_b', false);
    const [, nit, maniac] = t.seats.map((s) => opponentModelKey(s));
    expect([nit, maniac]).toEqual(['user_g10_a', 'user_g10_b']);
    play(nit, 20, 'nit', 1000);
    play(maniac, 20, 'maniac', 2000);
    expect(categorizeOpponent(nit)).toBe('nit');
    expect(categorizeOpponent(maniac)).toBe('maniac');
    expect(getActiveOpponentKeys(t, 0)).toEqual(['user_g10_a', 'user_g10_b']);
    expect(getOpponentProfile('Player')).toBeNull();             // nothing keyed by the name
  });

  it('CONTROL — keyed by display name (pre-R3) both fed ONE profile: the bot saw neither player as he is', () => {
    play('g10-shared-name', 20, 'nit', 3000);
    play('g10-shared-name', 20, 'maniac', 4000);
    expect(getOpponentProfile('g10-shared-name')!.handsSeen).toBe(40);
    expect(categorizeOpponent('g10-shared-name')).not.toBe('maniac');
    expect(categorizeOpponent('g10-shared-name')).not.toBe('nit');
  });

  it('the store is bounded: least recently observed out at OPPONENT_PROFILES_CAP (bot ids are new per seating)', () => {
    recordOpponentObservation('g10-keep', 'hand_start', { handNumber: 1 });
    for (let i = 0; i < OPPONENT_PROFILES_CAP; i++) {
      recordOpponentObservation(`g10-bot-${i}`, 'hand_start', { handNumber: 1 });
      if (i % 1000 === 0) recordOpponentObservation('g10-keep', 'vpip');   // still observed: never evicted
    }
    expect(opponentProfileCount()).toBe(OPPONENT_PROFILES_CAP);
    expect(getOpponentProfile('g10-keep')).not.toBeNull();
    expect(getOpponentProfile('g10-bot-0')).toBeNull();
  });

  it('a seat without a player id falls back to its name; wiring: index.ts records by opponentModelKey, never s.playerName', () => {
    expect(opponentModelKey({ playerId: '', playerName: 'Solo' })).toBe('Solo');
    const listener = fnSrc('function ensureTableProgressListener(');
    expect(listener).toContain("recordOpponentObservation(oppKey, 'hand_start', { handNumber: hn });");
    expect(listener).toContain("recordOpponentObservation(opponentModelKey(s), 'showdown');");
    expect(listener).not.toMatch(/recordOpponentObservation\(s\.playerName/);
    void GamePhase; void PlayerAction;
  });
});

// ── OPS-P3-2 ───────────────────────────────────────────────────────────────
describe('R3 (OPS-P3-2) — no login handle (legacy phone numbers) in the logs', () => {
  function audit(sessions: Array<[string, any]> = []) {
    const lines: string[] = [];
    const { exports: m } = load(`${slice('const PHONE_HANDLE_RE', '\n}\n')}\n${fnSrc('function auditLog(')}`, {
      authSessions: new Map(sessions), DURABLE_AUDIT_ACTIONS: new Set(), console: { log: (l: string) => lines.push(l) },
    }, '{ auditLog, auditActorLabel }');
    return { m, lines };
  }

  it('a phone-number handle prints as user:<id> (its live session) or phone-handle; ids, SYSTEM, slugs, names print as before', () => {
    const { m, lines } = audit([['S1', { userId: 4481, username: '3035550199' }]]);
    m.auditLog('3035550199', 'BUY_IN_DEDUCT', { tableId: 'T', buyIn: 500 });
    m.auditLog('+1 (720) 555-0100', 'CASH_OUT', { userId: 77, amount: 5 });
    expect(lines[0]).toContain('| user:4481 | BUY_IN_DEDUCT |');
    expect(lines[1]).toContain('| phone-handle | CASH_OUT |');
    expect(lines.join('\n')).not.toMatch(/3035550199|720\) 555/);
    for (const a of ['SYSTEM', 'user:12', '4481', 'josh.hall2', 'm:123456', 'Alice A.', 'user_1541']) expect(m.auditActorLabel(a)).toBe(a);
  });

  it('R3 review (SFC-2): ANY live session\'s login handle (a legacy full-name row, a ticket slug) prints as user:<id>', () => {
    const { m, lines } = audit([['S1', { userId: 4198, username: 'Jane Q Public' }], ['S2', { userId: 4492, username: 'jane.public' }]]);
    m.auditLog('Jane Q Public', 'BUY_IN_DEDUCT', { tableId: 'T', buyIn: 500 });
    m.auditLog('jane.public', 'CASH_OUT', { amount: 5 });
    expect(lines[0]).toContain('| user:4198 | BUY_IN_DEDUCT |');
    expect(lines[1]).toContain('| user:4492 | CASH_OUT |');
    expect(lines.join('\n')).not.toMatch(/Jane Q Public|jane\.public/);
    expect(m.auditActorLabel('SYSTEM')).toBe('SYSTEM');
  });

  it('CONTROL — pre-R3 auditLog printed the raw handle', () => {
    const pre = fnSrc('function auditLog(').replace('${auditActorLabel(actorUsername)}', '${actorUsername}');
    const lines: string[] = [];
    const { exports: m } = load(pre, { DURABLE_AUDIT_ACTIONS: new Set(), console: { log: (l: string) => lines.push(l) } }, '{ auditLog }');
    m.auditLog('3035550199', 'BUY_IN_DEDUCT', {});
    expect(lines[0]).toContain('| 3035550199 |');
  });

  it('wiring: the ticket-login success line prints ids only; a malformed /me logs its keys, never the object; admin alert lines print ids', () => {
    const tk = handlerSrc('authWithTicket', "\n    })\n  );\n");
    expect(tk).toContain('`[authWithTicket] logged in userId=${localUser.id} (masterId=${remoteUserId})`');
    expect(tk).not.toContain('username=${localUser.username}');
    expect(tk).toContain("keys:', Object.keys(masterUser || {}).slice(0, 40).join(','));");
    expect(tk).not.toContain("username:', masterUser);");
    expect(SRC).not.toMatch(/admin \$\{auth\.username\}|Admin \$\{auth\.username\}|admin=\$\{auth\.username\}/);
  });
});

// ── OPS-4 / OPS-5 ──────────────────────────────────────────────────────────
describe('R3 (OPS-4 / OPS-5) — Node 22 in every build file; the Railway deploy healthcheck', () => {
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

  it('nixpacks (Railway), Dockerfile, CI and package.json engines all name Node 22 (>= 22.12); the lockfile root agrees', () => {
    expect(read('nixpacks.toml')).toMatch(/nixPkgs = \["nodejs_22",/);
    expect(read('Dockerfile')).toMatch(/^FROM node:22-alpine$/m);
    expect(read('.github/workflows/ci.yml')).toContain('node-version: [22.x]');
    expect(JSON.parse(read('package.json')).engines).toEqual({ node: '^22.12.0' });
    expect(JSON.parse(read('package-lock.json')).packages[''].engines).toEqual({ node: '^22.12.0' });
    for (const f of ['nixpacks.toml', 'Dockerfile', '.github/workflows/ci.yml']) expect(read(f)).not.toMatch(/node(js)?[_:-]?20\b|20\.x/);
  });

  it('railway.json: deploys go live only on a 200 from /api/health; a crash is always restarted', () => {
    const r = JSON.parse(read('railway.json'));
    expect(r.deploy).toMatchObject({ healthcheckPath: '/api/health', restartPolicyType: 'ALWAYS', startCommand: 'npm start' });
    expect(r.deploy.healthcheckTimeout).toBeGreaterThanOrEqual(60);
    expect(r.deploy.restartPolicyMaxRetries).toBeUndefined();   // ON_FAILURE-only knob
    expect(SRC).toContain("app.get('/api/health', async (_req, res) => {");
  });
});

void quiet;
