/**
 * 2026-10-07 — .online PLAY GATE: game suspensions + "no American Pub Poker
 * account, no play".
 *
 * Owner decisions this module enforces:
 *   1. A suspended ("86'd") player may not play ANY American Pub Poker game,
 *      .online included. When he tries, he is told exactly
 *      "You are suspended from playing any games with American Pub Poker."
 *      Spectating stays allowed. Nothing ANNOUNCING the suspension is ever
 *      pushed to him — the sentence only appears as the answer to his own
 *      attempt to play.
 *   2. Guest play is OFF for everyone: nobody plays .online without an
 *      American Pub Poker account (a MASTER user id).
 *
 * WHERE THE TRUTH LIVES. Suspensions are master-side (player_suspensions in
 * Cloud SQL, matched by user id OR by any account sharing the suspended phone
 * number — poker-server never holds a real phone, so it cannot do that match
 * itself). poker-server asks, per MASTER user id:
 *
 *   GET {MASTER_API_URL}/users/:id/play-status/internal
 *   X-Internal-Token: INTERNAL_NOTIFY_TOKEN        (same internalAuth as
 *                                                   /qualifier-credits/consume/internal)
 *   200 {success:true, suspended:boolean, message:string|null}
 *
 * FAIL-OPEN for the suspension check. If that endpoint is unreachable, slow
 * (>4s), 404 (master not deployed yet), 401 (token drift) or returns a shape
 * we don't understand, the player is ALLOWED and a loud `[play-gate]` line is
 * logged. A master outage must never lock every .online player out. The one
 * game with real-world consequence (qualifiers) is independently blocked by
 * the master's qualifier-credit consume, which fails CLOSED.
 *
 * The ACCOUNT requirement is NOT fail-open: no master id means "sign in".
 * Its only escape hatch is the ONLINE_GUEST_PLAY_ENABLED emergency switch
 * (default off), reported on /api/health so it can never be a silent state.
 * "No master id" is decided only after any login already in flight on the
 * same socket has finished (bounded wait — see LoginTracker below), so a
 * play tap that races a reconnect's oauthLogin is not mistaken for a guest.
 *
 * Wire contract (C5) shared with poker-3d — keep these strings EXACT:
 *   code 'player_suspended' → PLAYER_SUSPENDED_MESSAGE
 *   code 'login_required'   → LOGIN_REQUIRED_MESSAGE   (no master id on the session)
 *   code 'guest_disabled'   → LOGIN_REQUIRED_MESSAGE   (guest `register` refused)
 */

import { parseStatsColumn } from './loginIdentity';

/** Owner wording, verbatim. Same sentence as the master API's PLAYER_MESSAGE. */
export const PLAYER_SUSPENDED_MESSAGE = 'You are suspended from playing any games with American Pub Poker.';
/** Shown when a socket has no American Pub Poker account behind it. */
export const LOGIN_REQUIRED_MESSAGE = 'Sign in with your American Pub Poker account to play.';

export type PlayRefusalCode = 'player_suspended' | 'login_required' | 'guest_disabled';

export interface PlayRefusal {
  code: PlayRefusalCode;
  message: string;
  /** The master id that was found suspended (opaque id; safe to log). */
  masterId?: string;
}

export interface PlayStatus {
  suspended: boolean;
  /** True when the check could not be answered and the player was let through. */
  failedOpen: boolean;
  /** Why it failed open (no_internal_token | timeout | http_404 | bad_shape | …). */
  reason?: string;
}

/** Counters surfaced on /api/health (`playGate`). No ids, no PII. */
export interface PlayGateCounters {
  lookups: number;
  cacheHits: number;
  suspendedAnswers: number;
  failOpen: number;
  lastFailOpenReason: string | null;
  lastFailOpenAt: string | null;
}

export interface PlayStatusClientOptions {
  /** Master API base, e.g. https://…/poker-api (read per call so env changes apply). */
  baseUrl: () => string;
  /** INTERNAL_NOTIFY_TOKEN (read per call). */
  token: () => string;
  fetchImpl?: typeof fetch;
  /** Cache TTL for a real answer. Default 60s. */
  ttlMs?: number;
  /** Cache TTL for a fail-open answer, so an outage doesn't add 4s to every join. Default 15s. */
  failOpenTtlMs?: number;
  /** Per-request timeout. Default 4s. */
  timeoutMs?: number;
  /**
   * Circuit breaker: after this many TRANSPORT failures (timeout, network,
   * HTTP 5xx) within breakerWindowMs, skip the lookup entirely (fail open at
   * once) for breakerOpenMs — so a slow master doesn't add the full timeout to
   * every first join / reconnect for every player. Defaults 3 / 30s / 30s.
   */
  breakerThreshold?: number;
  breakerWindowMs?: number;
  breakerOpenMs?: number;
  now?: () => number;
  /** Loud-log sink for fail-open events. Default console.error. */
  logError?: (line: string) => void;
}

/** A cached answer read without a lookup (see PlayStatusClient.peek). */
export interface PlayStatusPeek {
  status: PlayStatus;
  /** How old the answer is. */
  ageMs: number;
  /** Past its normal cache TTL — still usable up to the caller's maxAgeMs, but worth refreshing. */
  expired: boolean;
}

export interface PlayStatusClient {
  getPlayStatus(masterId: string): Promise<PlayStatus>;
  /**
   * 2026-10-09 — read the LAST answer for this id without any lookup, or null
   * if there is none younger than `maxAgeMs`. Synchronous and free, for the
   * hand loop (which must never wait on the master). Does not touch counters.
   */
  peek(masterId: string, maxAgeMs: number): PlayStatusPeek | null;
  /** Drop one id (or everything) from the cache. */
  invalidate(masterId?: string): void;
  counters(): PlayGateCounters;
  cacheSize(): number;
}

const MAX_CACHE_ENTRIES = 5000;

/**
 * Client for the master's play-status endpoint, with a per-master-id cache and
 * in-flight de-duplication (a burst of joins from one player = one request).
 * Never throws: every failure is a fail-open PlayStatus.
 */
export function createPlayStatusClient(opts: PlayStatusClientOptions): PlayStatusClient {
  const fetchImpl = opts.fetchImpl || fetch;
  const ttlMs = opts.ttlMs ?? 60_000;
  const failOpenTtlMs = opts.failOpenTtlMs ?? 15_000;
  const timeoutMs = opts.timeoutMs ?? 4_000;
  const now = opts.now || Date.now;
  const logError = opts.logError || ((line: string) => console.error(line));
  const breakerThreshold = opts.breakerThreshold ?? 3;
  const breakerWindowMs = opts.breakerWindowMs ?? 30_000;
  const breakerOpenMs = opts.breakerOpenMs ?? 30_000;
  let transportFailures: number[] = [];
  let breakerOpenUntil = 0;
  const noteTransportFailure = () => {
    const t = now();
    transportFailures = transportFailures.filter((x) => t - x < breakerWindowMs);
    transportFailures.push(t);
    if (transportFailures.length >= breakerThreshold) {
      breakerOpenUntil = t + breakerOpenMs;
      transportFailures = [];
    }
  };

  const cache = new Map<string, { status: PlayStatus; expiresAt: number; fetchedAt: number }>();
  const inflight = new Map<string, Promise<PlayStatus>>();
  const c: PlayGateCounters = {
    lookups: 0, cacheHits: 0, suspendedAnswers: 0, failOpen: 0,
    lastFailOpenReason: null, lastFailOpenAt: null,
  };

  const failOpen = (masterId: string, reason: string): PlayStatus => {
    c.failOpen++;
    c.lastFailOpenReason = reason;
    c.lastFailOpenAt = new Date(now()).toISOString();
    try {
      logError(`[play-gate] ${JSON.stringify({
        event: 'play_status_check_failed', masterId, reason, decision: 'fail_open_allowed',
      })}`);
    } catch { /* logging must never affect play */ }
    return { suspended: false, failedOpen: true, reason };
  };

  async function fetchStatus(masterId: string): Promise<PlayStatus> {
    const tok = (opts.token() || '').trim();
    if (!tok) return failOpen(masterId, 'no_internal_token');
    const base = (opts.baseUrl() || '').replace(/\/+$/, '');
    if (!base) return failOpen(masterId, 'no_master_api_url');
    if (now() < breakerOpenUntil) return failOpen(masterId, 'circuit_open');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/users/${encodeURIComponent(masterId)}/play-status/internal`, {
        method: 'GET',
        headers: { 'X-Internal-Token': tok, Accept: 'application/json' },
        signal: ac.signal,
      });
      if (!res.ok) {
        if (res.status >= 500) noteTransportFailure();
        return failOpen(masterId, `http_${res.status}`);
      }
      let body: any;
      try { body = await res.json(); } catch { return failOpen(masterId, 'bad_json'); }
      if (!body || typeof body.suspended !== 'boolean') return failOpen(masterId, 'bad_shape');
      if (body.suspended) c.suspendedAnswers++;
      transportFailures = [];
      return { suspended: body.suspended, failedOpen: false };
    } catch (e: any) {
      noteTransportFailure();
      return failOpen(masterId, e?.name === 'AbortError' ? 'timeout' : 'network_error');
    } finally {
      clearTimeout(timer);
    }
  }

  function remember(masterId: string, status: PlayStatus): void {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const t = now();
      for (const [k, v] of cache) if (v.expiresAt <= t) cache.delete(k);
      if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    }
    const t = now();
    cache.set(masterId, { status, expiresAt: t + (status.failedOpen ? failOpenTtlMs : ttlMs), fetchedAt: t });
  }

  async function getPlayStatus(masterIdRaw: string): Promise<PlayStatus> {
    const masterId = String(masterIdRaw || '').trim();
    if (!masterId) return { suspended: false, failedOpen: false };
    c.lookups++;
    const hit = cache.get(masterId);
    if (hit && hit.expiresAt > now()) { c.cacheHits++; return hit.status; }
    const pending = inflight.get(masterId);
    if (pending) return pending;
    const p = fetchStatus(masterId)
      .catch((e: any) => failOpen(masterId, `unexpected:${String(e?.message || e).slice(0, 40)}`))
      .then((status) => { remember(masterId, status); return status; })
      .finally(() => { inflight.delete(masterId); });
    inflight.set(masterId, p);
    return p;
  }

  return {
    getPlayStatus,
    peek(masterIdRaw: string, maxAgeMs: number): PlayStatusPeek | null {
      const masterId = String(masterIdRaw || '').trim();
      if (!masterId) return null;
      const hit = cache.get(masterId);
      if (!hit) return null;
      const t = now();
      const ageMs = t - hit.fetchedAt;
      if (ageMs > maxAgeMs) return null;
      return { status: hit.status, ageMs, expired: hit.expiresAt <= t };
    },
    invalidate(masterId?: string) {
      if (masterId === undefined) cache.clear();
      else cache.delete(String(masterId).trim());
    },
    counters: () => ({ ...c }),
    cacheSize: () => cache.size,
  };
}

/** The master id stamped on a local row's `users.stats` (TEXT or jsonb), or null. */
export function masterIdFromStats(rawStats: unknown): string | null {
  const m = parseStatsColumn(rawStats).masterUserId;
  if (m == null) return null;
  const s = String(m).trim();
  return s ? s : null;
}

/**
 * The slice of an authSessions entry the gate reads.
 *  - masterUserId: ATTESTED master id (OIDC sub / verified ticket). Wins.
 *  - statsMasterUserId: the local row's stats.masterUserId, for sessions that
 *    carry no attested id (legacy HS256 tokenLogin, password login).
 *    undefined = not looked up yet; null = looked up, row has none.
 *    Deliberately a SEPARATE field: it identifies the player for the play gate
 *    only, and must not grant the master-id-keyed privileges (qualifier entry,
 *    credit redemption) that `masterUserId` does.
 */
export interface GateSession {
  userId: number;
  masterUserId?: string;
  statsMasterUserId?: string | null;
}

/**
 * Resolve the MASTER user id behind a socket's session. Looks the local row's
 * stats up at most once per session (cached on the session object, null
 * included). A lookup ERROR is not cached and resolves to null — the caller
 * then refuses with login_required rather than letting an unidentified socket
 * play.
 */
export async function resolveSessionMasterId(
  session: GateSession | undefined | null,
  loadStats: (userId: number) => Promise<unknown>,
  logError: (line: string) => void = (l) => console.error(l),
): Promise<string | null> {
  if (!session) return null;
  if (session.masterUserId && String(session.masterUserId).trim()) return String(session.masterUserId).trim();
  if (session.statsMasterUserId !== undefined) return session.statsMasterUserId || null;
  try {
    const id = masterIdFromStats(await loadStats(session.userId));
    session.statsMasterUserId = id;
    return id;
  } catch (e: any) {
    try {
      logError(`[play-gate] ${JSON.stringify({
        event: 'master_id_lookup_failed', localUserId: session.userId, error: String(e?.message || e).slice(0, 120),
      })}`);
    } catch { /* never affect play */ }
    return null;
  }
}

/**
 * The gate decision. `masterIds` are every master identity attached to the
 * attempt (the session's, plus e.g. a verified deep-link ticket's). Rules:
 *   - none at all → login_required (unless guest play is switched back on);
 *   - ANY of them suspended → player_suspended;
 *   - otherwise null (allowed). A fail-open status counts as not suspended.
 */
export async function evaluatePlayable(
  masterIds: Array<string | null | undefined>,
  getPlayStatus: (masterId: string) => Promise<PlayStatus>,
  opts: { requireAccount?: boolean } = {},
): Promise<PlayRefusal | null> {
  const requireAccount = opts.requireAccount !== false;
  const ids = Array.from(new Set(
    masterIds.map((m) => (m == null ? '' : String(m).trim())).filter(Boolean),
  ));
  if (ids.length === 0) {
    return requireAccount ? { code: 'login_required', message: LOGIN_REQUIRED_MESSAGE } : null;
  }
  const statuses = await Promise.all(ids.map((id) => getPlayStatus(id)));
  const idx = statuses.findIndex((s) => s.suspended);
  if (idx >= 0) return { code: 'player_suspended', message: PLAYER_SUSPENDED_MESSAGE, masterId: ids[idx] };
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// IN-FLIGHT LOGINS (2026-10-07 review fix — the reconnect race).
//
// After ANY reconnect (PWA resume, phone unlock, Railway blip) the server sees
// a NEW socket id with no authSessions entry. The client re-sends oauthLogin
// at once, but that handler only sets the session after awaited
// introspection + upsert + loadProgress (~0.3–2s). A play tap inside that
// window found no session, resolved no master id, and was refused
// login_required — a signed-in, non-suspended player told to sign in.
//
// Every login handler (oauthLogin, tokenLogin, authWithTicket, password
// login, the waitlist deep-link's auth bootstrap) now registers itself here
// for the socket it runs on. When the gate cannot resolve a master id and a
// login is in flight on that SAME socket, it waits for that login to finish
// (bounded — see DEFAULT_LOGIN_WAIT_MS) and decides on the session it left.
// ────────────────────────────────────────────────────────────────────────

/** What a wait for in-flight logins ended with. */
export type LoginWaitOutcome = 'none' | 'settled' | 'timeout';

/**
 * Default bound on the gate's wait for an in-flight login. Below poker-3d's
 * 8s join watchdog (Lobby.jsx) so a slow login still answers before the
 * client gives up, and above a normal oauthLogin (introspection + upsert +
 * loadProgress, typically 0.3–2s).
 */
export const DEFAULT_LOGIN_WAIT_MS = 6_000;

export interface LoginTracker {
  /**
   * Mark a login as started on `socketId`. Returns its release function —
   * call it when the login handler finishes, on EVERY path (use finally).
   * Idempotent.
   */
  begin(socketId: string): () => void;
  /** True while any login is in flight on this socket. */
  isPending(socketId: string): boolean;
  /**
   * Resolve once every login in flight on this socket RIGHT NOW has finished
   * ('settled'), or after `timeoutMs` ('timeout'). 'none' (immediately) when
   * nothing is in flight. Never rejects.
   */
  waitFor(socketId: string, timeoutMs: number): Promise<LoginWaitOutcome>;
  /**
   * Drop every in-flight mark for a socket that has DISCONNECTED (settling
   * any waiter at once). A login handler that hangs past its socket must not
   * leave the mark — and /api/health's loginsInFlight — behind forever. A
   * release() that arrives later for a forgotten mark is a no-op.
   */
  forget(socketId: string): void;
  /** Sockets with at least one login in flight (for /api/health). */
  size(): number;
}

export function createLoginTracker(): LoginTracker {
  const inflight = new Map<string, Set<Promise<void>>>();
  // The resolver behind each mark, so forget() can settle waiters at once.
  const resolvers = new Map<Promise<void>, () => void>();
  return {
    begin(socketId: string): () => void {
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => { resolveDone = resolve; });
      resolvers.set(done, resolveDone);
      let set = inflight.get(socketId);
      if (!set) { set = new Set(); inflight.set(socketId, set); }
      set.add(done);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const s = inflight.get(socketId);
        if (s) {
          s.delete(done);
          if (s.size === 0) inflight.delete(socketId);
        }
        resolvers.delete(done);
        resolveDone();
      };
    },
    forget(socketId: string): void {
      const set = inflight.get(socketId);
      if (!set) return;
      inflight.delete(socketId);
      for (const done of set) {
        const resolve = resolvers.get(done);
        resolvers.delete(done);
        if (resolve) resolve();
      }
    },
    isPending(socketId: string): boolean {
      return (inflight.get(socketId)?.size || 0) > 0;
    },
    async waitFor(socketId: string, timeoutMs: number): Promise<LoginWaitOutcome> {
      const set = inflight.get(socketId);
      if (!set || set.size === 0) return 'none';
      const all = Promise.all(Array.from(set)).then((): LoginWaitOutcome => 'settled');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<LoginWaitOutcome>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
      });
      try {
        return await Promise.race([all, limit]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    size: () => inflight.size,
  };
}

export interface AssertPlayableDeps {
  /** The socket's authSessions entry (undefined = never signed in). */
  getSession: (socketId: string) => GateSession | undefined;
  /** Read a local users.stats value by local id (for the stats fallback). */
  loadStats: (userId: number) => Promise<unknown>;
  getPlayStatus: (masterId: string) => Promise<PlayStatus>;
  /** false only under the ONLINE_GUEST_PLAY_ENABLED emergency switch. Read per call. */
  requireAccount: () => boolean;
  /**
   * Wait for logins in flight on this socket (LoginTracker.waitFor). Optional:
   * without it the gate decides on the session as it is at entry.
   */
  waitForLogin?: (socketId: string, timeoutMs: number) => Promise<LoginWaitOutcome>;
  /** Bound for that wait. Default DEFAULT_LOGIN_WAIT_MS. */
  loginWaitMs?: number;
  /** Called after the gate actually waited ('settled' | 'timeout'), for counters/logs. */
  onLoginWait?: (outcome: LoginWaitOutcome, ctx: { where: string; waitedMs: number; resolved: boolean }) => void;
  /** Called once per refusal (counters + the `play_refused` log line). */
  onRefusal?: (refusal: PlayRefusal, ctx: { where: string; localUserId: number | null }) => void;
  logError?: (line: string) => void;
}

export interface AssertPlayableOptions {
  /**
   * Wait (bounded) for a login in flight on this socket before deciding
   * login_required. Default true. Pass false from INSIDE a login handler
   * (the seat-restore gate): that handler is itself the in-flight login, so
   * waiting would only run out the bound against itself.
   */
  waitForLogin?: boolean;
}

/**
 * Build the `assertPlayable(socketId, where, extraMasterIds?, opts?)` every
 * play-entry handler calls first. Resolves to null (may play) or the refusal
 * to send. `extraMasterIds` are identities proven by the request itself (e.g.
 * a verified deep-link ticket's user id); if ANY attached id is suspended the
 * attempt is refused. When the socket's session resolves to no master id but
 * a login is in flight on the same socket, the decision waits for it (see
 * LoginTracker). Never throws.
 */
export function createAssertPlayable(deps: AssertPlayableDeps) {
  const logError = deps.logError || ((l: string) => console.error(l));
  return async function assertPlayable(
    socketId: string,
    where: string,
    extraMasterIds: Array<string | null | undefined> = [],
    opts: AssertPlayableOptions = {},
  ): Promise<PlayRefusal | null> {
    let session = deps.getSession(socketId);
    let refusal: PlayRefusal | null;
    try {
      let sessionMasterId = await resolveSessionMasterId(session, deps.loadStats, logError);
      if (!sessionMasterId && opts.waitForLogin !== false && deps.waitForLogin) {
        const startedAt = Date.now();
        const outcome = await deps.waitForLogin(socketId, deps.loginWaitMs ?? DEFAULT_LOGIN_WAIT_MS);
        if (outcome !== 'none') {
          // Re-read: the login that just finished (or is still running past
          // the bound) may have set or replaced the session.
          session = deps.getSession(socketId);
          sessionMasterId = await resolveSessionMasterId(session, deps.loadStats, logError);
          if (deps.onLoginWait) {
            try {
              deps.onLoginWait(outcome, { where, waitedMs: Date.now() - startedAt, resolved: !!sessionMasterId });
            } catch { /* never affect play */ }
          }
        }
      }
      refusal = await evaluatePlayable([sessionMasterId, ...extraMasterIds], deps.getPlayStatus, {
        requireAccount: deps.requireAccount(),
      });
    } catch (e: any) {
      // Not reachable in practice (both helpers swallow their own failures).
      // If it ever is: the SUSPENSION half fails open, but an unidentified
      // socket still must not slip past the account requirement.
      try {
        logError(`[play-gate] ${JSON.stringify({ event: 'gate_exception', where, error: String(e?.message || e).slice(0, 120) })}`);
      } catch { /* never affect play */ }
      const hasId = !!(session?.masterUserId || session?.statsMasterUserId || extraMasterIds.some((m) => m && String(m).trim()));
      refusal = hasId || !deps.requireAccount() ? null : { code: 'login_required', message: LOGIN_REQUIRED_MESSAGE };
    }
    if (refusal && deps.onRefusal) {
      try { deps.onRefusal(refusal, { where, localUserId: session?.userId ?? null }); } catch { /* never affect play */ }
    }
    return refusal;
  };
}

/**
 * What a login does with the seat it would otherwise RESTORE (a reserved
 * seat after a disconnect, a post-restart orphan, or a seat this very socket
 * still holds), given the seat-restore gate's answer:
 *   - 'restore'  → may play: the normal reconnect restore runs.
 *   - 'stand_up' → player_suspended: definitive. The seat is stood up (stack
 *                  credited, mid-hand chips left in the pot) and he is told
 *                  with the C5 sentence after loginResult.
 *   - 'hold'     → login_required (no American Pub Poker account behind THIS
 *                  session — a legacy guest row, or a row no login has linked
 *                  yet). NOT a suspension, and possibly only a session-identity
 *                  gap: a parallel or retried oauthLogin for the same player
 *                  (poker-3d re-auths silently on login_required) must still be
 *                  able to claim the seat. So nothing is destroyed: the seat is
 *                  NOT restored to this session, the reservation keeps its own
 *                  expiry (which cashes the stack out as it always has).
 */
export type SeatRestoreAction = 'restore' | 'stand_up' | 'hold';

export function seatRestoreAction(refusal: PlayRefusal | null | undefined): SeatRestoreAction {
  if (!refusal) return 'restore';
  return refusal.code === 'player_suspended' ? 'stand_up' : 'hold';
}

/**
 * ONLINE_GUEST_PLAY_ENABLED — EMERGENCY ROLLBACK ONLY. Unset (the default)
 * means the owner's rule: no account, no play, and guest `register` is refused.
 * Only an explicit '1' / 'true' re-enables guest play.
 */
export function resolveGuestPlayEnabled(raw: unknown): boolean {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** The `registerResult` frame for a refused guest registration. */
export function guestRegisterRefusal(): { success: false; error: string; code: 'guest_disabled' } {
  return { success: false, error: LOGIN_REQUIRED_MESSAGE, code: 'guest_disabled' };
}

/**
 * Split qualifier registrants into keep / suspended, for the pre-start screen
 * that removes anyone suspended AFTER they registered. Registrants without a
 * master id are kept (qualifier registration already required one).
 */
export async function partitionSuspendedRegistrants<T extends { masterPlayerId?: string }>(
  players: T[],
  getPlayStatus: (masterId: string) => Promise<PlayStatus>,
): Promise<{ keep: T[]; suspended: T[] }> {
  const statuses = await Promise.all(players.map((p) =>
    p.masterPlayerId ? getPlayStatus(p.masterPlayerId) : Promise.resolve<PlayStatus>({ suspended: false, failedOpen: false }),
  ));
  const keep: T[] = [];
  const suspended: T[] = [];
  players.forEach((p, i) => (statuses[i].suspended ? suspended : keep).push(p));
  return { keep, suspended };
}

/**
 * 2026-10-09 — TOURNAMENT START SCREEN (free-chip / wallet tournaments).
 * registerTournament refuses a suspended player, but one suspended AFTER he
 * registered would still be seated at start. Resolve every registrant's
 * master id (`masterIdOf` never needs to succeed: an error or null keeps the
 * player, like qualifiers) and return who is suspended now. Fail-open: an
 * unreachable master removes no one.
 */
export async function findSuspendedRegistrants<T>(
  players: T[],
  masterIdOf: (player: T) => Promise<string | null>,
  getPlayStatus: (masterId: string) => Promise<PlayStatus>,
): Promise<{ keep: T[]; suspended: Array<{ player: T; masterId: string }> }> {
  const ids = await Promise.all(players.map((p) => masterIdOf(p).catch(() => null)));
  const wrapped = players.map((player, i) => ({ player, masterPlayerId: ids[i] ? String(ids[i]).trim() || undefined : undefined }));
  const { keep, suspended } = await partitionSuspendedRegistrants(wrapped, getPlayStatus);
  return {
    keep: keep.map((w) => w.player),
    suspended: suspended.map((w) => ({ player: w.player, masterId: w.masterPlayerId as string })),
  };
}

/** The TournamentManager surface removeSuspendedRegistrants needs (structural, for tests). */
export interface RegistrantRemovalTm {
  getTournament(tournamentId: string): { players: Array<{ playerId: string; userId?: number }>; config: { buyIn?: number } } | undefined;
  /** MUST return true only when a registration was actually removed (TournamentManager does since 2026-10-09). */
  unregisterPlayer(tournamentId: string, playerId: string): boolean;
  refundEntryFee(tournamentId: string, userId?: number): void;
}

export interface RemovedRegistrant {
  playerId: string;
  masterId: string;
  userId: number | null;
  /** Entry fee credited back (0 = free tournament, no paying userId, or the credit failed). */
  refunded: number;
  /** A refund was due and the wallet credit FAILED (audit it as such). */
  refundFailed: boolean;
}

/**
 * 2026-10-09 (D5) — remove the suspended registrants found by
 * findSuspendedRegistrants and refund each paid entry fee EXACTLY ONCE.
 * `suspended` was computed from a snapshot taken BEFORE awaiting the
 * play-status lookups; during that await a registrant may have left on his
 * own (leaveTournament unregisters AND refunds him). So each one is re-read
 * from the LIVE tournament, synchronously, right before the removal, and is
 * refunded only when unregisterPlayer reports a real removal — never twice.
 */
export async function removeSuspendedRegistrants(
  tm: RegistrantRemovalTm,
  tournamentId: string,
  suspended: Array<{ player: { playerId: string }; masterId: string }>,
  creditRefund: (userId: number, amount: number) => Promise<boolean>,
): Promise<RemovedRegistrant[]> {
  const removed: RemovedRegistrant[] = [];
  for (const { player, masterId } of suspended) {
    // No await between this read and the removal.
    const t = tm.getTournament(tournamentId);
    const live = t?.players.find((p) => p.playerId === player.playerId);
    if (!t || !live) continue; // already gone (left + refunded meanwhile)
    if (!tm.unregisterPlayer(tournamentId, player.playerId)) continue;
    const entryFee = t.config.buyIn || 0;
    let refunded = 0;
    let refundFailed = false;
    if (entryFee > 0 && live.userId !== undefined) {
      tm.refundEntryFee(tournamentId, live.userId);
      const ok = await creditRefund(live.userId, entryFee);
      refunded = ok ? entryFee : 0;
      refundFailed = !ok;
    }
    removed.push({ playerId: player.playerId, masterId, userId: live.userId ?? null, refunded, refundFailed });
  }
  return removed;
}

/** The TournamentManager surface cancelIfTooFewEligibleAfterScreen needs (structural, for tests). */
export interface StartScreenCancelTm {
  getTournament(tournamentId: string): { status: string; players: unknown[] } | undefined;
  /** Status → 'cancelled', field + collected pool emptied; returns who to refund (TournamentManager). */
  cancelTournament(tournamentId: string): Array<{ playerId: string; userId?: number; refund: number }>;
}

/** Fewer eligible registrants than this after the start screen = the tournament is cancelled. */
export const MIN_ELIGIBLE_TO_START = 2;

/**
 * 2026-10-09 (S4) — called right after removeSuspendedRegistrants, with no
 * await in between. When the screen REMOVED someone and fewer than two
 * eligible registrants remain, the tournament cannot start with this field:
 * it is cancelled NOW through the existing cancel path
 * (TournamentManager.cancelTournament — the stall sweep's path) and the
 * remaining registrants are returned for their refund. Never a walkover,
 * and nobody is paid a prize.
 * SINGLE REFUND: the suspended were already refunded by
 * removeSuspendedRegistrants and are no longer in the field; cancelTournament
 * leaves the tournament 'cancelled' with an empty field and pool, so neither
 * leaveTournament (unregisterPlayer needs 'registering') nor the stall sweep
 * can refund anyone again.
 * Returns null — and changes nothing — when nothing was removed, the
 * tournament is gone or no longer registering, or ≥2 registrants remain.
 */
export function cancelIfTooFewEligibleAfterScreen(
  tm: StartScreenCancelTm,
  tournamentId: string,
  removedCount: number,
): Array<{ playerId: string; userId?: number; refund: number }> | null {
  if (!(removedCount > 0)) return null;
  const t = tm.getTournament(tournamentId);
  if (!t || t.status !== 'registering') return null;
  if (t.players.length >= MIN_ELIGIBLE_TO_START) return null;
  return tm.cancelTournament(tournamentId);
}

// ────────────────────────────────────────────────────────────────────────
// 2026-10-09 — HAND-START STAND-UP (a player suspended mid-session no longer
// keeps his seat).
//
// PokerTable emits 'beforeHandStart' at the top of startNewHand — the last
// moment a seat can be stood up with nothing committed to a pot (the previous
// pot is awarded, the next hand's blinds are not posted). index.ts plans the
// stand-ups from the play-status CACHE only, so the hand loop never waits on
// the master: an id with no answer (or one older than the normal TTL) is
// looked up in the background and acted on at the NEXT hand boundary.
// HAND_GATE_MAX_STATUS_AGE_MS bounds how stale an answer may be and still
// stand a player up — long enough to span a slow hand (the refresh is fired
// at the previous boundary), short enough that a lifted suspension stops
// mattering within minutes.
// ────────────────────────────────────────────────────────────────────────
export const HAND_GATE_MAX_STATUS_AGE_MS = 5 * 60_000;

export interface HandGateSeat {
  seatIndex: number;
  /** The seat player's master id; null when his session has none (or it is not resolved yet). */
  masterId: string | null;
}

export interface HandGatePlan {
  /** Seats whose player is suspended per the cached answer — stand them up before the deal. */
  standUp: Array<{ seatIndex: number; masterId: string }>;
  /** Master ids with no cached answer, or an expired one — refresh in the background. */
  refresh: string[];
}

/**
 * Decide, from cached answers only, which seats to stand up before this deal
 * and which ids to refresh. `peek` is the play-status client's cache read
 * (bound to HAND_GATE_MAX_STATUS_AGE_MS by the caller). A fail-open answer is
 * "not suspended", like everywhere else in the gate.
 */
export function planHandStartGate(
  seats: HandGateSeat[],
  peek: (masterId: string) => PlayStatusPeek | null,
): HandGatePlan {
  const standUp: Array<{ seatIndex: number; masterId: string }> = [];
  const refresh = new Set<string>();
  for (const seat of seats) {
    const id = seat.masterId == null ? '' : String(seat.masterId).trim();
    if (!id) continue;
    const cached = peek(id);
    if (!cached || cached.expired) refresh.add(id);
    if (cached && cached.status.suspended) standUp.push({ seatIndex: seat.seatIndex, masterId: id });
  }
  return { standUp, refresh: Array.from(refresh) };
}
