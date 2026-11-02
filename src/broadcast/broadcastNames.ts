/**
 * 2026-11-02 (.online tournament broadcast, P1-S1) — the NAMES a broadcast
 * shows, the opaque player keys (`pid`) and the per-player opt-out.
 *
 * Name rule (owner 2026-11-02: "First name + last initial, with a per-player
 * opt-out to show as Player"), applied on the SERVER at EMIT time — never at
 * capture time, so an opt-out taken mid-event also covers every later frame:
 *   1. start from publicNameOf (social/publicIdentity: the display-name
 *      whitelist; a phone-like / non-whitelist / over-20 value is 'Player');
 *   2. two or more words → `First L.` ('John Smith' → 'John S.', 'Mary Ann Lee'
 *      → 'Mary L.'), where a "word" is a segment cut at every separator, digit and
 *      CamelCase boundary (fix round 4: 'JohnSmith Jr' → 'John J.', 'Mary22Jones'
 *      → 'Mary J.', "JohnSmith's" → 'John S.'; owner answer (c): 'JohnSmith' →
 *      'John S.'; see surnameSafeName / nameSegments);
 *   3. one word stays as is (a chosen alias: 'Zed99', 'McDonald', 'Jean-Luc');
 *   4. opted out, OR opt-out UNKNOWN (a cache miss, a DB error) → 'Player'
 *      (fail-closed). A bot is never opted out (the caller passes false).
 * The client renders only `name` ('Seat N' when it is missing).
 *
 * pid = 'b-' + the first 16 hex of HMAC-SHA256(per-process random key,
 * `tournamentId:playerId`) — the roomEntrantToken pattern (index.ts F19): it
 * never maps back to an account, and differs between events. No broadcast
 * payload ever carries playerId, masterUserId, userId or publicId.
 *
 * Opt-out storage: `users.stats.broadcastOptOut` (boolean) + `broadcastOptOutAt`
 * (ISO) on the player's local row, written through the atomic mergeUserStats
 * (row lock), so it survives every restart / redeploy (CLAUDE.md "User data
 * MUST persist"). The signed-in profile already carries it
 * (`loginResult.userData.stats.broadcastOptOut`; absent = false), and
 * 'getBroadcastOptOut' answers it on mount / resume (Pattern B). An in-memory
 * cache keyed by master id and by local id serves the emit-time lookups; a miss
 * queues ONE batched, rate-limited DB read and answers "unknown" ('Player')
 * until it lands. Nothing here ever blocks a game path.
 */
import { createHmac, randomBytes } from 'crypto';
import { publicNameOf, PUBLIC_NAME_FALLBACK } from '../social/publicIdentity';
import type { WindowRateLimiter } from '../auth/rateLimit';

export const BROADCAST_NAME_FALLBACK = PUBLIC_NAME_FALLBACK;   // 'Player'

/** The broadcast name of a raw seat / registration name. `optOut` must be exactly false to show a name. */
export function broadcastNameOf(raw: unknown, optOut: boolean | null | undefined): string {
  if (optOut !== false) return BROADCAST_NAME_FALLBACK;
  const pub = publicNameOf(raw);
  if (pub === BROADCAST_NAME_FALLBACK) return BROADCAST_NAME_FALLBACK;
  try {
    return surnameSafeName(pub);
  } catch {
    return BROADCAST_NAME_FALLBACK;   // fail-closed: never the raw name on a bug
  }
}

/**
 * Fix round 4 (2026-11-02) — the approved promise (rules line 1) is that the broadcast
 * shows "your public name (first name and last initial)": NO surname may reach air, in
 * any spelling of a handle. Owner answer (c): one-word joined capitalised names become
 * First L. ('JohnSmith' -> 'John S.'). Generalised (replaces round 3's joinedWordsName,
 * which only knew letters-plus-trailing-digits and let 'JohnSmith Jr', 'JohnSmith_77',
 * 'Mary22Jones', "JohnSmith's", 'Mary-JaneWatson' through):
 *   1. nameSegments cuts the name into word segments (see there);
 *   2. two or more letter segments -> `<first> <initial of the LAST segment>.`:
 *      - <first> is the first letter segment as typed ('JOHN_SMITH' -> 'JOHN S.'); a
 *        one-letter first segment is an initial and gets a period ('JSmith' -> 'J. S.'),
 *        and a leading '.'-joined run of them stays together ('A.J. Smith' -> 'A.J. S.');
 *      - the LAST segment skips 1-letter junk ('JohnSmith22 x' -> 'John S.'); digit
 *        segments are never letters ('JohnSmith 2' -> 'John S.');
 *   3. one letter segment (an alias: 'Zed99', 'AcesUp' is TWO -> 'Aces U.'), only
 *      single letters ('A.J.'), or exactly two capitalised parts joined by one hyphen
 *      and nothing else ('Jean-Luc': a hyphenated first name cannot be told from a
 *      'John-Smith', documented in tests) -> as typed.
 * Known limits (no boundary to cut on, documented in tests/broadcastNames.test.ts):
 * 'johnsmith', 'JOHNSMITH', 'Johnsmith', a 3+ capital run straight into lowercase
 * ('JOHNsmith'), 'John-Smith', and a first name that is itself a surname prefix
 * ('VonMiller') stay as typed.
 */
function surnameSafeName(pub: string): string {
  const segs = nameSegments(pub);
  const words = segs.filter((s) => s.letters);
  if (words.length < 2 || words.every((w) => w.text.length === 1)) return pub;
  if (/^[A-Z][a-z]+-[A-Z][a-z]+$/.test(pub)) return pub;
  let first = words[0].text;
  let firstEnd = 0;   // index in `words` of the last segment the first name uses
  if (first.length === 1) {
    let j = segs.indexOf(words[0]);
    while (j + 1 < segs.length && segs[j + 1].letters && segs[j + 1].text.length === 1 && segs[j + 1].sep === '.') j++;
    first = `${pub.slice(words[0].start, segs[j].end)}.`;
    firstEnd = words.indexOf(segs[j]);
  }
  const rest = words.slice(firstEnd + 1);
  if (rest.length === 0) return BROADCAST_NAME_FALLBACK;   // not reachable (all initials returned above); fail-closed
  const named = rest.filter((w) => w.text.length > 1);
  const last = named.length > 0 ? named[named.length - 1] : rest[rest.length - 1];
  return `${first} ${last.text.charAt(0).toUpperCase()}.`;
}

/** Surname prefixes that join the next capitalised segment ('McDonald', 'LeBron', 'DeShawn', 'VanDyke'). */
const SURNAME_PREFIXES = new Set(['Mc', 'Mac', 'De', 'Di', 'Da', 'Du', 'Le', 'La', 'Van', 'Von', 'St']);

export interface NameSegment {
  /** As typed; a merged segment keeps its apostrophe ("O'Brien"). */
  text: string;
  start: number;
  end: number;
  /** Letters (true) or digits (false). */
  letters: boolean;
  /** The separator characters before it ('' = joined straight to the previous segment). */
  sep: string;
}

const isUpper = (c: string | undefined): boolean => c !== undefined && c >= 'A' && c <= 'Z';

/**
 * A display name -> its word segments. Cuts at spaces, '.', '_', '-', apostrophes,
 * digits (a digit run is its own, non-letter segment) and CamelCase boundaries:
 * lowercase -> Uppercase ('JohnSmith', 'johnSmith'), and a run of ONE or TWO capitals
 * before a Capital+lowercase ('TJMiller' -> TJ | Miller, 'JSmith' -> J | Smith). Never
 * inside an all-caps or all-lowercase run ('JohnSMITH' -> John | SMITH; 'JOHNsmith' is
 * one segment), and never inside a word of 4 or fewer letters whose case alternates
 * ('JoHn'). Then a possessive "'s" is dropped, and a surname prefix (SURNAME_PREFIXES)
 * or a single capital before an apostrophe (O'Brien, D'Angelo) joins the next
 * capitalised segment (chained: 'DeLaCruz').
 */
export function nameSegments(name: string): NameSegment[] {
  const raw: NameSegment[] = [];
  let sep = '';
  const tokens = /[A-Za-z]+|[0-9]+|[^A-Za-z0-9]+/g;
  for (let m = tokens.exec(name); m !== null; m = tokens.exec(name)) {
    const t = m[0];
    if (!/[A-Za-z0-9]/.test(t)) { sep += t; continue; }
    if (/^[0-9]/.test(t)) {
      raw.push({ text: t, start: m.index, end: m.index + t.length, letters: false, sep });
      sep = '';
      continue;
    }
    let at = m.index;
    for (const part of splitLetterRun(t)) {
      raw.push({ text: part, start: at, end: at + part.length, letters: true, sep });
      sep = '';
      at += part.length;
    }
  }
  const kept = raw.filter((s, i) => {
    const next = raw[i + 1];
    const possessive = s.letters && s.sep === "'" && (s.text === 's' || s.text === 'S');
    return !(possessive && (!next || next.sep !== '' || !next.letters));
  });
  const out: NameSegment[] = [];
  for (let i = 0; i < kept.length; i++) {
    let cur = kept[i];
    let tail = cur;
    while (i + 1 < kept.length) {
      const next = kept[i + 1];
      if (!tail.letters || !next.letters || !isUpper(next.text.charAt(0))) break;
      const prefix = SURNAME_PREFIXES.has(tail.text) && next.sep === '';
      const elision = tail.text.length === 1 && isUpper(tail.text) && next.sep === "'";
      if (!prefix && !elision) break;
      cur = { text: name.slice(cur.start, next.end), start: cur.start, end: next.end, letters: true, sep: cur.sep };
      tail = next;
      i++;
    }
    out.push(cur);
  }
  return out;
}

/** One run of letters -> its CamelCase words (see nameSegments). */
function splitLetterRun(run: string): string[] {
  let alternating = true;
  for (let i = 1; i < run.length; i++) if (isUpper(run[i]) === isUpper(run[i - 1])) alternating = false;
  if (run.length <= 4 && alternating) return [run];
  const out: string[] = [];
  let start = 0;
  for (let i = 1; i < run.length; i++) {
    let cut = !isUpper(run[i - 1]) && isUpper(run[i]);
    if (!cut && isUpper(run[i - 1]) && isUpper(run[i]) && i + 1 < run.length && !isUpper(run[i + 1])) {
      let capsBefore = 0;
      for (let k = i - 1; k >= start && isUpper(run[k]); k--) capsBefore++;
      cut = capsBefore <= 2;
    }
    if (cut) { out.push(run.slice(start, i)); start = i; }
  }
  out.push(run.slice(start));
  return out;
}

const BROADCAST_PID_KEY = randomBytes(32);
/** The opaque, per-event key of an entrant in every broadcast payload. */
export function broadcastPid(tournamentId: string, playerId: string): string {
  return `b-${createHmac('sha256', BROADCAST_PID_KEY).update(`${tournamentId}:${playerId}`).digest('hex').slice(0, 16)}`;
}

/** users.stats (TEXT on prod, or an object) → its broadcastOptOut flag. Junk → false (the row says nothing). */
export function optOutFromStats(stats: unknown): boolean {
  let o: unknown = stats;
  if (typeof stats === 'string') { try { o = JSON.parse(stats); } catch { o = null; } }
  return !!o && typeof o === 'object' && (o as Record<string, unknown>).broadcastOptOut === true;
}

// ===== the opt-out cache =====

export interface OptOutIds { userId?: number | null; masterUserId?: string | null }
export interface OptOutRow { id: number; masterUserId: string | null; optOut: boolean }

export interface BroadcastOptOutStore {
  /** true / false when known; undefined = unknown (queues a background load). Never throws, never awaits. */
  get(ids: OptOutIds): boolean | undefined;
  /** Record a known value under both keys. */
  set(ids: OptOutIds, optOut: boolean): void;
  /** Read rows now (handlers). Throws on a DB error. */
  loadNow(q: { userIds?: number[]; masterIds?: string[] }): Promise<OptOutRow[]>;
  /** Run the queued batch load (tests; normally scheduled by get). */
  flush(): Promise<void>;
  stats(): Record<string, number>;
}

/** A queued miss is not re-read for this long (a player with no row, a DB blip). */
const OPT_OUT_RETRY_MS = 30_000;
/** At most one batch read per this interval. */
const OPT_OUT_LOAD_MIN_INTERVAL_MS = 2_000;
const OPT_OUT_BATCH_MAX = 200;
/** Bounded: past this the cache is emptied (every name falls back to 'Player' until re-read: fail-closed). */
const OPT_OUT_CACHE_MAX = 50_000;

export function createBroadcastOptOutStore(deps: {
  load: (q: { userIds: number[]; masterIds: string[] }) => Promise<OptOutRow[]>;
  now?: () => number;
  /** Schedules the batch load (default setTimeout 0, unref'd). */
  schedule?: (fn: () => void) => void;
  log?: (line: string) => void;
}): BroadcastOptOutStore {
  const now = deps.now || Date.now;
  const log = deps.log || ((l: string) => console.warn(l));
  const schedule = deps.schedule || ((fn: () => void) => { const t = setTimeout(fn, 0); (t as any).unref?.(); });
  const byUser = new Map<number, boolean>();
  const byMaster = new Map<string, boolean>();
  const wantUsers = new Set<number>();
  const wantMasters = new Set<string>();
  const triedAt = new Map<string, number>();
  const st = { hits: 0, unknown: 0, loads: 0, loadErrors: 0, rowsLoaded: 0, sets: 0, cacheResets: 0 };
  let loading = false;
  let scheduled = false;
  let lastLoadAt = 0;

  const masterKey = (m: string | null | undefined): string | null => (m === undefined || m === null || m === '' ? null : String(m));
  const userKey = (u: number | null | undefined): number | null => (Number.isInteger(u) && (u as number) > 0 ? (u as number) : null);

  function set(ids: OptOutIds, optOut: boolean): void {
    if (byUser.size + byMaster.size > OPT_OUT_CACHE_MAX) { byUser.clear(); byMaster.clear(); st.cacheResets++; }
    const u = userKey(ids.userId);
    const m = masterKey(ids.masterUserId);
    if (u !== null) { byUser.set(u, optOut === true); triedAt.delete(`u:${u}`); }
    if (m !== null) { byMaster.set(m, optOut === true); triedAt.delete(`m:${m}`); }
    st.sets++;
  }

  function queue(ids: OptOutIds): void {
    const t = now();
    const u = userKey(ids.userId);
    const m = masterKey(ids.masterUserId);
    // By local id when there is one (a primary-key read whose row also names the
    // master id); by master id only without one (that read scans users).
    if (u !== null) {
      if (!((triedAt.get(`u:${u}`) ?? -Infinity) > t - OPT_OUT_RETRY_MS)) wantUsers.add(u);
    } else if (m !== null && !((triedAt.get(`m:${m}`) ?? -Infinity) > t - OPT_OUT_RETRY_MS)) {
      wantMasters.add(m);
    }
    if ((wantUsers.size > 0 || wantMasters.size > 0) && !scheduled && !loading) {
      scheduled = true;
      schedule(() => { scheduled = false; void flush(); });
    }
  }

  function get(ids: OptOutIds): boolean | undefined {
    try {
      const m = masterKey(ids.masterUserId);
      const u = userKey(ids.userId);
      const byM = m !== null ? byMaster.get(m) : undefined;
      const byU = u !== null ? byUser.get(u) : undefined;
      // Two answers that disagree (should not happen: one person, one row) → opted out.
      if (byM !== undefined && byU !== undefined && byM !== byU) { st.hits++; return true; }
      const known = byM !== undefined ? byM : byU;
      if (known !== undefined) { st.hits++; return known; }
      st.unknown++;
      queue(ids);
      return undefined;
    } catch {
      return undefined;
    }
  }

  async function flush(): Promise<void> {
    if (loading) return;
    const t = now();
    if (t - lastLoadAt < OPT_OUT_LOAD_MIN_INTERVAL_MS && lastLoadAt > 0) {
      if (!scheduled) {
        scheduled = true;
        const wait = OPT_OUT_LOAD_MIN_INTERVAL_MS - (t - lastLoadAt);
        const timer = setTimeout(() => { scheduled = false; void flush(); }, wait);
        (timer as any).unref?.();
      }
      return;
    }
    const userIds = [...wantUsers].slice(0, OPT_OUT_BATCH_MAX);
    const masterIds = [...wantMasters].slice(0, OPT_OUT_BATCH_MAX);
    if (userIds.length === 0 && masterIds.length === 0) return;
    for (const u of userIds) { wantUsers.delete(u); triedAt.set(`u:${u}`, t); }
    for (const m of masterIds) { wantMasters.delete(m); triedAt.set(`m:${m}`, t); }
    if (triedAt.size > OPT_OUT_CACHE_MAX) triedAt.clear();
    loading = true;
    lastLoadAt = t;
    st.loads++;
    try {
      const rows = await deps.load({ userIds, masterIds });
      for (const r of rows) set({ userId: r.id, masterUserId: r.masterUserId }, r.optOut === true);
      st.rowsLoaded += rows.length;
    } catch (e: any) {
      st.loadErrors++;
      try { log(`[broadcast] ${JSON.stringify({ event: 'broadcast_opt_out_load_failed', users: userIds.length, masters: masterIds.length, error: String(e?.message || e).slice(0, 160) })}`); } catch { /* logging only */ }
    } finally {
      loading = false;
    }
    if (wantUsers.size > 0 || wantMasters.size > 0) queue({});
  }

  return {
    get,
    set,
    loadNow: (q) => deps.load({ userIds: q.userIds || [], masterIds: q.masterIds || [] }),
    flush,
    stats: () => ({ ...st, cachedUsers: byUser.size, cachedMasters: byMaster.size, queued: wantUsers.size + wantMasters.size }),
  };
}

// ===== the socket handlers (default namespace, signed in) =====

export interface OptOutAuth { userId: number; username: string; masterUserId?: string; statsMasterUserId?: string | null; isAdminClaim?: boolean }
export interface OptOutSocket { id: string; emit: (ev: string, d: unknown) => unknown }

export const BROADCAST_OPT_OUT_AUDIT = 'BROADCAST_OPT_OUT_SET';

export interface BroadcastOptOutHandlers {
  /** 'setBroadcastOptOut' {optOut} → 'broadcastOptOutResult'. */
  set(socket: OptOutSocket, data: unknown): Promise<void>;
  /** 'getBroadcastOptOut' {} → 'broadcastOptOutResult'. */
  get(socket: OptOutSocket): Promise<void>;
  /** 'adminSetBroadcastOptOut' {userId? | masterUserId?, optOut} → 'adminBroadcastOptOutResult' (isUserAdmin, audited). */
  adminSet(socket: OptOutSocket, data: unknown): Promise<void>;
  stats(): Record<string, number>;
}

export function createBroadcastOptOutHandlers(deps: {
  store: BroadcastOptOutStore;
  authOf: (socketId: string) => OptOutAuth | undefined;
  mergeUserStats: (userId: number, patch: Record<string, unknown>, opts: { rethrow: boolean }) => Promise<void>;
  isUserAdmin: (userId: number) => Promise<boolean>;
  auditLog: (actor: string, action: string, details: Record<string, unknown>) => void;
  limiter: WindowRateLimiter;
  now?: () => number;
  log?: (line: string) => void;
  /** Review fix (2026-11-02) — the master's answer now: false = not an admin any more; null = could not tell (the claim stands). */
  recheckAdmin?: (auth: OptOutAuth) => Promise<boolean | null>;
}): BroadcastOptOutHandlers {
  const now = deps.now || Date.now;
  const log = deps.log || ((l: string) => console.log(l));
  const st = { set: 0, get: 0, adminSet: 0, loginRequired: 0, saveFailed: 0, loadFailed: 0, rateLimited: 0, notAdmin: 0, invalid: 0 };
  const note = (event: string, extra: Record<string, unknown>) => {
    try { log(`[broadcast] ${JSON.stringify({ event, ...extra })}`); } catch { /* logging only */ }
  };
  const reply = (socket: OptOutSocket, payload: Record<string, unknown>) => { try { socket.emit('broadcastOptOutResult', payload); } catch { /* gone */ } };
  const replyAdmin = (socket: OptOutSocket, payload: Record<string, unknown>) => { try { socket.emit('adminBroadcastOptOutResult', payload); } catch { /* gone */ } };
  const masterOf = (auth: OptOutAuth): string | null => (auth.masterUserId ? String(auth.masterUserId) : (auth.statsMasterUserId ? String(auth.statsMasterUserId) : null));

  /** Persist, then cache. A failed save still HONOURS an opt-out in this process (privacy first) and says save_failed. */
  async function write(userId: number, masterUserId: string | null, optOut: boolean): Promise<boolean> {
    try {
      await deps.mergeUserStats(userId, { broadcastOptOut: optOut, broadcastOptOutAt: new Date(now()).toISOString() }, { rethrow: true });
    } catch (e: any) {
      if (optOut) deps.store.set({ userId, masterUserId }, true);
      st.saveFailed++;
      note('broadcast_opt_out_save_failed', { userId, optOut, error: String(e?.message || e).slice(0, 160) });
      return false;
    }
    deps.store.set({ userId, masterUserId }, optOut);
    return true;
  }

  return {
    async set(socket, data) {
      const auth = deps.authOf(socket.id);
      if (!auth || !(Number(auth.userId) > 0)) { st.loginRequired++; reply(socket, { ok: false, code: 'login_required' }); return; }
      const optOut = (data as { optOut?: unknown } | null)?.optOut;
      if (typeof optOut !== 'boolean') { st.invalid++; reply(socket, { ok: false, code: 'save_failed' }); return; }
      if (!deps.limiter.hit(`u:${auth.userId}`)) { st.rateLimited++; reply(socket, { ok: false, code: 'rate_limited' }); return; }
      if (!(await write(auth.userId, masterOf(auth), optOut))) { reply(socket, { ok: false, code: 'save_failed' }); return; }
      st.set++;
      note('broadcast_opt_out_set', { userId: auth.userId, optOut, via: 'player' });
      reply(socket, { ok: true, optOut });
    },

    async get(socket) {
      const auth = deps.authOf(socket.id);
      if (!auth || !(Number(auth.userId) > 0)) { st.loginRequired++; reply(socket, { ok: false, code: 'login_required' }); return; }
      st.get++;
      // A tight loop never reaches the DB: past the limit, the cache answers (else rate_limited).
      if (!deps.limiter.hit(`g:${auth.userId}`)) {
        const cached = deps.store.get({ userId: auth.userId, masterUserId: masterOf(auth) });
        if (cached === undefined) { st.rateLimited++; reply(socket, { ok: false, code: 'rate_limited' }); return; }
        reply(socket, { ok: true, optOut: cached });
        return;
      }
      // His OWN row is read (not the cache: another process / an admin may have set it).
      try {
        const rows = await deps.store.loadNow({ userIds: [auth.userId] });
        const row = rows.find((r) => r.id === auth.userId);
        if (!row) { st.loadFailed++; reply(socket, { ok: false, code: 'load_failed' }); return; }
        deps.store.set({ userId: row.id, masterUserId: row.masterUserId ?? masterOf(auth) }, row.optOut);
        reply(socket, { ok: true, optOut: row.optOut });
      } catch (e: any) {
        st.loadFailed++;
        note('broadcast_opt_out_load_failed', { userId: auth.userId, error: String(e?.message || e).slice(0, 160) });
        reply(socket, { ok: false, code: 'load_failed' });
      }
    },

    async adminSet(socket, data) {
      const auth = deps.authOf(socket.id);
      if (!auth || !(Number(auth.userId) > 0)) { st.loginRequired++; replyAdmin(socket, { ok: false, code: 'login_required' }); return; }
      // CLAUDE.md: every admin socket handler awaits isUserAdmin BEFORE any mutation.
      // Review fix (2026-11-02): the local is_admin column is grant-only — THIS login's is_admin
      // claim is required too (the broadcastIssueToken rule), and the master is asked again.
      let admin = false;
      try { admin = await deps.isUserAdmin(auth.userId); } catch { admin = false; }
      if (admin && auth.isAdminClaim === true && deps.recheckAdmin) {
        let still: boolean | null = null;
        try { still = await deps.recheckAdmin(auth); } catch { still = null; }
        if (still === false) admin = false;
      }
      const after = deps.authOf(socket.id);
      if (!admin || auth.isAdminClaim !== true || !after || after.userId !== auth.userId) { st.notAdmin++; replyAdmin(socket, { ok: false, code: 'not_admin' }); return; }
      const d = (data || {}) as { userId?: unknown; masterUserId?: unknown; optOut?: unknown };
      const optOut = d.optOut;
      const userId = Number.isInteger(Number(d.userId)) && Number(d.userId) > 0 ? Number(d.userId) : null;
      const masterUserId = typeof d.masterUserId === 'string' && d.masterUserId ? d.masterUserId : null;
      if (typeof optOut !== 'boolean' || (userId === null && masterUserId === null)) { st.invalid++; replyAdmin(socket, { ok: false, code: 'invalid_request' }); return; }
      let row: OptOutRow | undefined;
      try {
        const rows = await deps.store.loadNow(userId !== null ? { userIds: [userId] } : { masterIds: [masterUserId as string] });
        row = userId !== null ? rows.find((r) => r.id === userId) : rows.find((r) => r.masterUserId === masterUserId);
      } catch {
        st.loadFailed++;
        replyAdmin(socket, { ok: false, code: 'load_failed' });
        return;
      }
      if (!row) { replyAdmin(socket, { ok: false, code: 'user_not_found' }); return; }
      if (!(await write(row.id, row.masterUserId, optOut))) { replyAdmin(socket, { ok: false, code: 'save_failed' }); return; }
      st.adminSet++;
      deps.auditLog(auth.username, BROADCAST_OPT_OUT_AUDIT, { targetUserId: row.id, targetMasterUserId: row.masterUserId, optOut, byUserId: auth.userId });
      replyAdmin(socket, { ok: true, userId: row.id, masterUserId: row.masterUserId, optOut });
    },

    stats: () => ({ ...st }),
  };
}
