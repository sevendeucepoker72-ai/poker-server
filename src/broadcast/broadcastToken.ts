/**
 * 2026-11-02 (.online tournament broadcast, P2-S4) — BROADCAST TOKENS: the one
 * credential of the /broadcast namespace (spec R3, §3 "Token").
 *
 * A short-lived, revocable, HS256-signed token poker-server issues to a signed-in
 * admin. Public output needs NO token (a fixed OBS URL ?ch=weekly works week
 * after week); a token adds a scope:
 *   output    the source counts as an on-air output (the deploy freeze, health);
 *   producer  the bc:producer:* API (the producer panel mints its own on the
 *             signed-in main socket: 'broadcastIssueToken' {ev:'ch:*', scopes:
 *             ['producer']});
 *   delayed   the delayed hole-card feed — P5, built dark: minting it answers
 *             'holecards_off' in this build.
 * Claims: jti, ev ('ch:<channel>' | 'ch:*' (producer only) | 'q:<id>' | 't:<id>';
 * 'delayed' only q: / t:), scp, iss_m (the issuer's master id), lbl, nbf, exp
 * (<= nbf + 12 h). Header: alg HS256 (pinned — 'none', RS256 and any other alg
 * are refused), typ 'bcast+jwt' (pinned). Secret: env BROADCAST_TOKEN_SECRET,
 * 32+ characters — shorter / unset turns EVERY token feature off
 * ('secret_unset'; health says so).
 *
 * Signed with `jsonwebtoken` (already a dependency: authManager's session
 * tokens), not jose: jose 6 is ESM-only and cannot load under this repo's
 * CommonJS jest, so it could not be tested here.
 *
 * Postgres `broadcast_tokens` (DDL: authManager initDB, next to
 * qualifier_configs) keeps the jti and its metadata — NEVER the token string;
 * it is loaded at boot so a revocation survives a restart. A token whose jti
 * this process does not know (the row was never written, or the load has not
 * run) is refused as 'revoked': fail-closed. Every check is synchronous
 * (signature + the in-memory registry): a handshake never waits on the DB.
 *
 * Never rotate the secret during an event (an env change restarts the server,
 * and a restart cancels a running qualifier): revoke tokens instead.
 */
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import {
  BROADCAST_CHANNELS, BROADCAST_TOKEN_MAX_TTL_MS, BROADCAST_TOKEN_SCOPES, BROADCAST_TOKEN_TYP,
  type BroadcastScope, type ChannelId,
} from './contract';
import { parseEventKey } from './eventKey';

export const BROADCAST_TOKEN_SECRET_MIN = 32;
export const BROADCAST_TOKEN_AUDIT_ISSUED = 'BROADCAST_TOKEN_ISSUED';
export const BROADCAST_TOKEN_AUDIT_REVOKED = 'BROADCAST_TOKEN_REVOKED';
/** Log tag of a refused key (handshake / issue). */
export const BROADCAST_TOKEN_REFUSED_TAG = 'broadcast_token_refused';
const NOT_BEFORE_MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_MAX_LEN = 4096;
/** Expired rows stay listed / in memory this long (a late revoke, the key list). */
const ROW_KEEP_AFTER_EXP_MS = 24 * 60 * 60 * 1000;

/** The secret in force: >= 32 characters, else null (every token feature off). */
export function tokenSecretOf(env: Record<string, string | undefined> | undefined): string | null {
  const s = String(env?.BROADCAST_TOKEN_SECRET ?? '').trim();
  return s.length >= BROADCAST_TOKEN_SECRET_MIN ? s : null;
}

export type TokenEv =
  | { kind: 'ch'; channel: ChannelId | '*' }
  | { kind: 'q'; id: string }
  | { kind: 't'; id: string };

/** A token's `ev`: 'ch:<channel>' | 'ch:*' | 'q:<id>' | 't:<id>' (never next:). */
export function parseTokenEv(raw: unknown): TokenEv | null {
  if (typeof raw !== 'string') return null;
  if (raw === 'ch:*') return { kind: 'ch', channel: '*' };
  if (raw.startsWith('ch:')) {
    const c = raw.slice(3);
    return (BROADCAST_CHANNELS as readonly string[]).includes(c) ? { kind: 'ch', channel: c as ChannelId } : null;
  }
  const p = parseEventKey(raw);
  if (!p || p.kind === 'next') return null;
  return p.kind === 'q' ? { kind: 'q', id: p.id } : { kind: 't', id: p.id };
}

export interface TokenClaims {
  jti: string;
  ev: string;
  scp: BroadcastScope[];
  iss_m: string | null;
  lbl: string;
  /** seconds */
  nbf: number;
  /** seconds */
  exp: number;
}

export interface TokenRow {
  jti: string;
  ev: string;
  scopes: BroadcastScope[];
  label: string;
  issuedByMaster: string | null;
  issuedByUser: number | null;
  /** epoch ms */
  nbf: number;
  /** epoch ms */
  exp: number;
  revokedAt: number | null;
  createdAt: number;
  /**
   * Review fix (2026-11-02) — the producer key whose bc:producer:mintKey made this one (null =
   * minted by a signed-in admin, broadcastIssueToken): audited, listed, must START before its
   * parent expires, and is revoked with it on bc:producer:revokeKey {jti, withChildren:true}.
   */
  parentJti: string | null;
}

export interface MintRequest {
  ev: unknown;
  scopes: unknown;
  label: unknown;
  ttlHours?: unknown;
  notBefore?: unknown;
}

export type MintValidation =
  | { ok: true; ev: string; parsed: TokenEv; scopes: BroadcastScope[]; label: string; nbf: number; exp: number }
  | { ok: false; code: 'invalid_request' | 'event_not_found' };

/** Printable text only (no control / bidi-override characters), trimmed, at most `max`. */
export function cleanLabel(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001F\u007F‪-‮⁦-⁩]/g, '').trim().slice(0, max);
}

/**
 * A mint request → its validated claims (times in ms, whole seconds). ttlHours
 * is capped at 12 (default 12); notBefore (epoch ms) at most 7 days ahead.
 */
export function validateMintRequest(req: MintRequest, now: number): MintValidation {
  const parsed = parseTokenEv(req?.ev);
  if (!parsed) return { ok: false, code: 'event_not_found' };
  const raw = req?.scopes;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > BROADCAST_TOKEN_SCOPES.length) return { ok: false, code: 'invalid_request' };
  const scopes: BroadcastScope[] = [];
  for (const s of raw) {
    if (!(BROADCAST_TOKEN_SCOPES as readonly string[]).includes(s) || scopes.includes(s)) return { ok: false, code: 'invalid_request' };
    scopes.push(s as BroadcastScope);
  }
  // 'ch:*' is the producer panel's key (every channel): producer scope ONLY.
  if (parsed.kind === 'ch' && parsed.channel === '*' && !(scopes.length === 1 && scopes[0] === 'producer')) return { ok: false, code: 'invalid_request' };
  // The delayed hole-card feed is bound to ONE event.
  if (scopes.includes('delayed') && parsed.kind === 'ch') return { ok: false, code: 'invalid_request' };
  const label = cleanLabel(req?.label, 60) || 'Broadcast key';
  const ttlH = req?.ttlHours === undefined || req?.ttlHours === null ? 12 : Number(req.ttlHours);
  if (!Number.isFinite(ttlH) || ttlH <= 0) return { ok: false, code: 'invalid_request' };
  const ttlS = Math.max(60, Math.floor(Math.min(BROADCAST_TOKEN_MAX_TTL_MS, ttlH * 3_600_000) / 1000));
  let nbfMs = now;
  if (req?.notBefore !== undefined && req?.notBefore !== null) {
    const nb = Number(req.notBefore);
    if (!Number.isFinite(nb) || nb > now + NOT_BEFORE_MAX_AHEAD_MS) return { ok: false, code: 'invalid_request' };
    nbfMs = Math.max(now, nb);
  }
  const nbfS = Math.floor(nbfMs / 1000);
  return { ok: true, ev: String(req.ev), parsed, scopes, label, nbf: nbfS * 1000, exp: (nbfS + ttlS) * 1000 };
}

/** HS256, typ bcast+jwt, whole-second nbf / exp. */
export function signBroadcastToken(secret: string, claims: TokenClaims): string {
  return jwt.sign({ ...claims }, secret, { algorithm: 'HS256', header: { alg: 'HS256', typ: BROADCAST_TOKEN_TYP }, noTimestamp: true });
}

export type VerifyCode = 'bad_token' | 'expired' | 'not_yet_valid' | 'secret_unset';
/** Signature, alg (pinned), typ (pinned), nbf / exp and the claim shapes. No registry check. */
export function verifyBroadcastToken(secret: string | null, token: unknown, now: number): { ok: true; claims: TokenClaims } | { ok: false; code: VerifyCode } {
  if (!secret) return { ok: false, code: 'secret_unset' };
  if (typeof token !== 'string' || token.length === 0 || token.length > TOKEN_MAX_LEN) return { ok: false, code: 'bad_token' };
  let decoded: jwt.Jwt;
  try {
    decoded = jwt.verify(token, secret, { algorithms: ['HS256'], complete: true, clockTimestamp: Math.floor(now / 1000) }) as jwt.Jwt;
  } catch (e: any) {
    if (e?.name === 'TokenExpiredError') return { ok: false, code: 'expired' };
    if (e?.name === 'NotBeforeError') return { ok: false, code: 'not_yet_valid' };
    return { ok: false, code: 'bad_token' };
  }
  if (!decoded || decoded.header?.alg !== 'HS256' || decoded.header?.typ !== BROADCAST_TOKEN_TYP) return { ok: false, code: 'bad_token' };
  const p = decoded.payload as Record<string, unknown>;
  if (!p || typeof p !== 'object') return { ok: false, code: 'bad_token' };
  const scp = p.scp;
  if (typeof p.jti !== 'string' || !p.jti || !parseTokenEv(p.ev)) return { ok: false, code: 'bad_token' };
  if (!Array.isArray(scp) || scp.length === 0 || !scp.every((s) => (BROADCAST_TOKEN_SCOPES as readonly string[]).includes(s))) return { ok: false, code: 'bad_token' };
  if (typeof p.nbf !== 'number' || typeof p.exp !== 'number' || p.exp <= p.nbf || (p.exp - p.nbf) * 1000 > BROADCAST_TOKEN_MAX_TTL_MS) return { ok: false, code: 'bad_token' };
  // jsonwebtoken checks nbf only when present: it is (above). Belt and braces on the clock:
  if (now < p.nbf * 1000) return { ok: false, code: 'not_yet_valid' };
  if (now >= p.exp * 1000) return { ok: false, code: 'expired' };
  return {
    ok: true,
    claims: {
      jti: p.jti, ev: String(p.ev), scp: scp as BroadcastScope[], iss_m: typeof p.iss_m === 'string' && p.iss_m ? p.iss_m : null,
      lbl: typeof p.lbl === 'string' ? p.lbl : '', nbf: p.nbf, exp: p.exp,
    },
  };
}

export interface TokenDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export type CheckResult = { ok: true; claims: TokenClaims; row: TokenRow } | { ok: false; code: VerifyCode | 'revoked' };

export interface TokenRegistry {
  secretConfigured(): boolean;
  /** Rows from Postgres (boot). Never throws. */
  load(): Promise<{ loaded: number; error?: string }>;
  /**
   * Review fix (2026-11-02) — has the persisted list been read (always true with no db)? Until
   * it has, a key this process does not know is not yet KNOWN to be revoked: the handshake
   * waits (whenLoaded) instead of refusing it 'revoked' (which made the page drop its key).
   */
  isLoaded(): boolean;
  /** Resolves true once loaded, or false after timeoutMs. Never rejects. */
  whenLoaded(timeoutMs: number): Promise<boolean>;
  /** Sign + record. The caller has checked who may mint and for what (the event, entrants, the scope rules). */
  mint(v: Extract<MintValidation, { ok: true }>, issuer: { masterUserId: string | null; userId: number | null }, opts?: { parentJti?: string | null }): Promise<
    { ok: true; token: string; row: TokenRow; persisted: boolean } | { ok: false; code: 'secret_unset' }>;
  /** Synchronous: signature + claims + the registry (unknown / revoked jti → 'revoked'). */
  check(token: unknown): CheckResult;
  /** Re-check a live session's jti (revoked / expired since the handshake). */
  stillValid(jti: string): { ok: true } | { ok: false; code: 'revoked' | 'expired' };
  /**
   * Revokes the key; with `cascade` also every key minted from it (any depth; `children` =
   * their jtis, to drop their sessions). Not by default: the producer panel retires its own
   * short-lived key on Close / renewal, and the OBS keys it made must keep working.
   */
  revoke(jti: string, opts?: { cascade?: boolean }): Promise<{ row: TokenRow | null; persisted: boolean; children: string[] }>;
  /** Live (unrevoked, unexpired) keys minted from this one. */
  childrenOf(jti: string): TokenRow[];
  row(jti: string): TokenRow | undefined;
  /** Rows not long expired, newest first (never a token string). */
  list(ev?: string): TokenRow[];
  /** Unrevoked, unexpired rows the account issued (registration refusal, spec R4). */
  liveRowsOf(masterUserId: string): TokenRow[];
  stats(): Record<string, unknown>;
}

export function createTokenRegistry(deps: {
  secret: () => string | null;
  db?: TokenDb | null;
  now?: () => number;
  log?: (line: string) => void;
}): TokenRegistry {
  const now = deps.now || Date.now;
  const log = deps.log || ((l: string) => console.log(l));
  const rows = new Map<string, TokenRow>();
  let loaded = !deps.db;
  const loadWaiters = new Set<(ok: boolean) => void>();
  const st = { issued: 0, revoked: 0, loaded: 0, loadErrors: 0, saveErrors: 0, checks: 0, refusals: {} as Record<string, number> };
  const note = (event: string, extra: Record<string, unknown>) => {
    try { log(`[broadcast] ${JSON.stringify({ event, ...extra })}`); } catch { /* logging only */ }
  };
  const refuse = <C extends string>(code: C): { ok: false; code: C } => { st.refusals[code] = (st.refusals[code] || 0) + 1; return { ok: false, code }; };
  const prune = () => {
    const t = now();
    if (rows.size < 2000) return;
    for (const [k, r] of rows) if (r.exp + ROW_KEEP_AFTER_EXP_MS < t) rows.delete(k);
  };
  const ms = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = v instanceof Date ? v.getTime() : Date.parse(String(v));
    return Number.isFinite(n) ? n : null;
  };

  return {
    secretConfigured: () => !!deps.secret(),

    async load() {
      if (!deps.db) return { loaded: 0 };
      try {
        const { rows: found } = await deps.db.query(
          `SELECT jti, ev, scopes, label, issued_by_master, issued_by_user, nbf, exp, revoked_at, created_at, parent_jti
             FROM broadcast_tokens WHERE exp > NOW() - INTERVAL '1 day' ORDER BY created_at DESC LIMIT 2000`,
        );
        let n = 0;
        for (const r of found) {
          const nbf = ms(r.nbf);
          const exp = ms(r.exp);
          if (typeof r.jti !== 'string' || nbf === null || exp === null) continue;
          const scopes = (Array.isArray(r.scopes) ? r.scopes : String(r.scopes || '').replace(/[{}]/g, '').split(','))
            .map((s: unknown) => String(s).trim()).filter((s: string) => (BROADCAST_TOKEN_SCOPES as readonly string[]).includes(s)) as BroadcastScope[];
          // A row already known in this process (minted before the load finished) wins.
          if (rows.has(r.jti)) continue;
          rows.set(r.jti, {
            jti: r.jti, ev: String(r.ev), scopes, label: String(r.label || ''),
            issuedByMaster: r.issued_by_master ? String(r.issued_by_master) : null,
            issuedByUser: Number.isInteger(Number(r.issued_by_user)) && r.issued_by_user !== null ? Number(r.issued_by_user) : null,
            nbf, exp, revokedAt: ms(r.revoked_at), createdAt: ms(r.created_at) ?? nbf,
            parentJti: typeof r.parent_jti === 'string' && r.parent_jti ? r.parent_jti : null,
          });
          n++;
        }
        st.loaded += n;
        if (!loaded) {
          loaded = true;
          for (const w of [...loadWaiters]) { try { w(true); } catch { /* waiter */ } }
          loadWaiters.clear();
        }
        return { loaded: n };
      } catch (e: any) {
        st.loadErrors++;
        const error = String(e?.message || e).slice(0, 160);
        note('broadcast_tokens_load_failed', { error });
        return { loaded: 0, error };
      }
    },

    isLoaded: () => loaded,

    whenLoaded(timeoutMs) {
      if (loaded) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (ok: boolean) => {
          if (done) return;
          done = true;
          loadWaiters.delete(finish);
          clearTimeout(timer);
          resolve(ok);
        };
        const timer = setTimeout(() => finish(loaded), Math.max(0, timeoutMs));
        (timer as any).unref?.();
        loadWaiters.add(finish);
      });
    },

    async mint(v, issuer, opts) {
      const secret = deps.secret();
      if (!secret) return refuse('secret_unset');
      const jti = randomUUID();
      const row: TokenRow = {
        jti, ev: v.ev, scopes: v.scopes.slice(), label: v.label,
        issuedByMaster: issuer.masterUserId, issuedByUser: issuer.userId,
        nbf: v.nbf, exp: v.exp, revokedAt: null, createdAt: now(),
        parentJti: opts?.parentJti ? String(opts.parentJti) : null,
      };
      const token = signBroadcastToken(secret, {
        jti, ev: v.ev, scp: row.scopes, iss_m: issuer.masterUserId, lbl: v.label, nbf: Math.floor(v.nbf / 1000), exp: Math.floor(v.exp / 1000),
      });
      rows.set(jti, row);
      st.issued++;
      prune();
      let persisted = false;
      if (deps.db) {
        try {
          await deps.db.query(
            `INSERT INTO broadcast_tokens (jti, ev, scopes, label, issued_by_master, issued_by_user, nbf, exp, parent_jti)
             VALUES ($1, $2, $3::text[], $4, $5, $6, to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0), $9)`,
            [jti, row.ev, row.scopes, row.label, row.issuedByMaster, row.issuedByUser, row.nbf, row.exp, row.parentJti],
          );
          persisted = true;
        } catch (e: any) {
          // The token works in THIS process; after a restart its jti is unknown → refused (fail-closed).
          st.saveErrors++;
          note('broadcast_token_save_failed', { jti, error: String(e?.message || e).slice(0, 160) });
        }
      }
      return { ok: true, token, row, persisted };
    },

    check(token) {
      st.checks++;
      const v = verifyBroadcastToken(deps.secret(), token, now());
      if (!v.ok) return refuse(v.code);
      const row = rows.get(v.claims.jti);
      if (!row || row.revokedAt !== null) return refuse('revoked');
      // The row is the authority: a token whose claims disagree with its own row is forged or stale.
      if (row.ev !== v.claims.ev || row.scopes.join(',') !== v.claims.scp.join(',')) return refuse('bad_token');
      return { ok: true, claims: v.claims, row };
    },

    stillValid(jti) {
      const row = rows.get(jti);
      if (!row || row.revokedAt !== null) return { ok: false, code: 'revoked' };
      if (now() >= row.exp) return { ok: false, code: 'expired' };
      return { ok: true };
    },

    async revoke(jti, opts) {
      const row = rows.get(jti);
      if (!row) return { row: null, persisted: false, children: [] };
      // The key (and, with cascade, every key minted from it, any depth), revoked in memory at once.
      const all: TokenRow[] = [row];
      const seen = new Set<string>([row.jti]);
      for (let i = 0; opts?.cascade === true && i < all.length; i++) {
        for (const r of rows.values()) if (r.parentJti === all[i].jti && !seen.has(r.jti)) { seen.add(r.jti); all.push(r); }
      }
      const t = now();
      for (const r of all) if (r.revokedAt === null) { r.revokedAt = t; st.revoked++; }
      const jtis = all.map((r) => r.jti);
      let persisted = false;
      if (deps.db) {
        try {
          await deps.db.query(`UPDATE broadcast_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE jti = ANY($1::text[])`, [jtis]);
          persisted = true;
        } catch (e: any) {
          st.saveErrors++;
          note('broadcast_token_revoke_save_failed', { jti, children: jtis.length - 1, error: String(e?.message || e).slice(0, 160) });
        }
      }
      return { row, persisted, children: jtis.slice(1) };
    },

    row: (jti) => rows.get(jti),

    childrenOf(jti) {
      const t = now();
      return [...rows.values()].filter((r) => r.parentJti === jti && r.revokedAt === null && r.exp > t);
    },

    list(ev) {
      const t = now();
      return [...rows.values()]
        .filter((r) => r.exp + ROW_KEEP_AFTER_EXP_MS > t && (ev === undefined || r.ev === ev))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 200);
    },

    liveRowsOf(masterUserId) {
      const t = now();
      const m = String(masterUserId || '');
      if (!m) return [];
      return [...rows.values()].filter((r) => r.issuedByMaster === m && r.revokedAt === null && r.exp > t);
    },

    stats: () => {
      const t = now();
      let live = 0;
      for (const r of rows.values()) if (r.revokedAt === null && r.exp > t) live++;
      return { secretConfigured: !!deps.secret(), listLoaded: loaded, issued: st.issued, revoked: st.revoked, live, rows: rows.size, loaded: st.loaded, loadErrors: st.loadErrors, saveErrors: st.saveErrors, checks: st.checks, refusals: { ...st.refusals } };
    },
  };
}

// ===== the default-namespace issuer ('broadcastIssueToken', signed-in admin) =====

/** Who mints a key. parent = the producer key a bc:producer:mintKey runs on (the child is capped at it). */
export interface MintIssuer { masterUserId: string | null; userId: number | null; username: string; parent?: { jti: string } | null }

export interface IssueAuth { userId: number; username: string; masterUserId?: string; isAdminClaim?: boolean }
export interface IssueSocket { id: string; emit: (ev: string, d: unknown) => unknown }
export type IssueResult =
  | { ok: true; token: string; jti: string; scopes: BroadcastScope[]; nbf: number; exp: number }
  | { ok: false; code: string };

/**
 * 'broadcastIssueToken' {ev, scopes, label, ttlHours, notBefore?} → the reply on
 * 'broadcastTokenIssued' AND the ack (the producer panel accepts either). Needs
 * a signed-in socket, isUserAdmin (awaited, BEFORE anything else) AND the
 * login's own is_admin claim (authSessions.isAdminClaim): poker-server's
 * is_admin column is grant-only, so the claim of THIS login is what proves the
 * master still says admin. The event / entrant / scope rules are `mint`'s
 * (wire.ts mintToken).
 */
export function createBroadcastIssueHandler(deps: {
  authOf: (socketId: string) => IssueAuth | undefined;
  isUserAdmin: (userId: number) => Promise<boolean>;
  mint: (req: MintRequest, issuer: { masterUserId: string | null; userId: number | null; username: string }) => Promise<IssueResult>;
  limiter: { hit(key: string): boolean };
  log?: (line: string) => void;
  /**
   * Review fix (2026-11-02) — the master's answer NOW (its roles: siteAdmin / leagueAdmin, the
   * rule the auth-server's is_admin claim uses): false = no longer an admin (refused not_admin);
   * null = could not tell (the login's claim stands). The claim alone was stamped once at login.
   */
  recheckAdmin?: (auth: IssueAuth) => Promise<boolean | null>;
}): { issue(socket: IssueSocket, data: unknown, ack?: unknown): Promise<void>; stats(): Record<string, number> } {
  const log = deps.log || ((l: string) => console.log(l));
  const st = { issued: 0, refused: 0 };
  return {
    async issue(socket, data, ack) {
      const reply = (r: IssueResult) => {
        if (!r.ok) {
          st.refused++;
          try { log(`[broadcast] ${JSON.stringify({ event: BROADCAST_TOKEN_REFUSED_TAG, via: 'broadcastIssueToken', code: r.code, socketId: socket.id })}`); } catch { /* logging only */ }
        } else st.issued++;
        try { socket.emit('broadcastTokenIssued', r); } catch { /* gone */ }
        if (typeof ack === 'function') { try { (ack as (x: unknown) => void)(r); } catch { /* gone */ } }
      };
      const auth = deps.authOf(socket.id);
      if (!auth || !(Number(auth.userId) > 0)) return reply({ ok: false, code: 'login_required' });
      if (!deps.limiter.hit(`u:${auth.userId}`)) return reply({ ok: false, code: 'rate_limited' });
      let admin = false;
      try { admin = await deps.isUserAdmin(auth.userId); } catch { admin = false; }
      // Re-read after the await: the socket may have signed out / switched account.
      const after = deps.authOf(socket.id);
      if (!admin || auth.isAdminClaim !== true || !after || after.userId !== auth.userId) return reply({ ok: false, code: 'not_admin' });
      if (deps.recheckAdmin) {
        let still: boolean | null = null;
        try { still = await deps.recheckAdmin(auth); } catch { still = null; }
        const again = deps.authOf(socket.id);
        if (still === false || !again || again.userId !== auth.userId) return reply({ ok: false, code: 'not_admin' });
      }
      const d = (data && typeof data === 'object' ? data : {}) as MintRequest;
      reply(await deps.mint(d, { masterUserId: auth.masterUserId ? String(auth.masterUserId) : null, userId: auth.userId, username: auth.username }));
    },
    stats: () => ({ ...st }),
  };
}
