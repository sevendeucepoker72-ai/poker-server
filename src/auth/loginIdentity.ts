/**
 * Login identity resolution + loginResult wire shapes.
 *
 * Extracted 2026-08-17 from the `oauthLogin` / `tokenLogin` socket handlers so
 * the reject branches that caused the .online sign-in outage are unit-testable.
 *
 * Background (the outage): "Play Online" on americanpub.poker bridges the
 * player's id_token to .online, which exchanges it for a fresh token set via
 * grant_type=urn:apk:bridge. That bridge grant mints its AccessToken with NO
 * resource indicator, so the access token is OPAQUE (the normal /authorize
 * login asks for resource=API_RESOURCE and gets an RS256 JWT instead). An
 * opaque token is validated by introspection, whose payload carries the
 * `username` claim from auth-server's extraTokenClaims but NO `phone` claim.
 *
 * So `username`-only is the NORMAL, EXPECTED shape for a bridged .online login
 * and must resolve to an identity. `resolveLoginIdentity` is that rule, and the
 * test suite pins it — a future "tighten this to require phone" change would
 * silently kill every cross-site SSO handoff.
 */

export interface ResolvedOAuthClaims {
  valid: boolean;
  sub?: string;
  username?: string;
  phone?: string;
  isAdmin?: boolean;
  error?: string;
  clientAuthFailed?: boolean;
}

/** Stable machine-readable reasons a login can be refused. Emitted on the wire
 *  as `loginResult.code` AND as the `code` of an `online_login_failed`
 *  auth_events row, so a client-side failure can be joined to a server-side
 *  cause. Add to this union rather than inventing ad-hoc strings. */
export type LoginFailureCode =
  | 'no_token'
  | 'token_invalid'
  | 'client_auth_failed'
  | 'no_phone_or_username_claim'
  | 'maintenance'
  | 'user_upsert_failed'
  | 'user_row_missing'
  // 2026-08-17 P0 — the local row that matches this login's username key is
  // already OWNED by a DIFFERENT master account (`stats->>'masterUserId'`).
  // Distinct from `user_row_missing` (which means the upsert genuinely
  // returned nothing): this one is a REFUSAL, and the two real accounts
  // behind it need an owner-side merge. See the interim-guard comment on the
  // upserts in index.ts.
  | 'identity_conflict'
  | 'handler_exception'
  | 'rate_limited'
  | 'legacy_token_invalid'
  // Ticket deep-link (`authWithTicket`) refusals. Same wire contract as the
  // socket-login codes so poker-3d can attribute + label them identically.
  | 'ticket_missing'
  | 'ticket_replayed'
  | 'ticket_verify_unreachable'
  | 'ticket_verify_failed'
  | 'ticket_invalid'
  | 'ticket_missing_user'
  | 'master_user_unreachable'
  | 'master_user_shape'
  // 2026-10-07 — play gate (auth/playGate.ts). Used by joinWithWaitlistContext,
  // which answers on loginResult: the deep-link ticket's master account (or
  // the socket's) is suspended from all American Pub Poker games, or the
  // socket has no American Pub Poker account behind it. Same strings as the
  // `code` on the `error` / `joinError` / `qualifierRegistrationResult` frames.
  | 'player_suspended'
  | 'login_required'
  // 2026-10-09 — R1 `resumeSession`: the resume token is DEFINITIVELY unusable
  // (expired, bad signature, wrong kind, users.token_version bumped, account
  // banned, master link changed, row retired). The client drops it and falls
  // back to signing in. Transient refusals keep their own codes
  // (`maintenance`, `rate_limited`, `handler_exception`) so a client never
  // discards a still-valid resume token over a DB blip.
  | 'resume_invalid';

export interface LoginIdentity {
  /** The value used as the LOCAL poker-server users.username key. */
  key: string;
  /** Human-facing display name. */
  displayName: string;
  /**
   * WHICH claim produced `key`. Callers need this to stamp `users.stats`
   * correctly: `masterPhone` must only ever receive a REAL phone number.
   *
   * 2026-08-17 P3 — before this existed, the OIDC upsert stamped
   * `masterPhone: key`, and in production `key` is the `username` claim (a
   * display name), so `masterPhone` was being filled with "Josh Hall". See
   * MasterIdentityStamp for the full field-semantics note.
   */
  source: 'phone' | 'username';
}

export type IdentityResolution =
  | { ok: true; identity: LoginIdentity }
  | { ok: false; code: Extract<LoginFailureCode, 'no_phone_or_username_claim'> };

/**
 * Resolve the local-user key from a validated token's claims.
 *
 * `phone` when auth-server supplies it (JWT access tokens from the master-API
 * resource can carry it), otherwise `username` — which is all an introspected
 * OPAQUE token (bridge / ticket / legacy grant) ever has. Whitespace-only
 * values are treated as absent so a blank claim can't create a junk user row.
 *
 * This does NOT weaken validation: the caller has already proven the token's
 * signature/activity and holds a cryptographically-attested `sub`. This only
 * decides which claim names the local row.
 *
 * 2026-08-17 P0 — DELIBERATELY NOT TRIMMED. An earlier revision returned
 * `claims.username.trim()`, which looked harmless and was not: the master API's
 * `updateUser` validates firstName/lastName only as "string, <= 50 chars" (the
 * NAME_BAD_CHARS whitelist runs in signup ONLY), and auth-server derives the
 * `username` claim as `[firstName, lastName].join(' ')`. Trimming here MERGES
 * `"  Josh Hall"` and `"Josh Hall"` onto one local row — i.e. it manufactures a
 * brand-new way for one player to land on another player's account. Blank is
 * still rejected (a whitespace-only claim can't name a row), but a non-blank
 * value is used verbatim, exactly as the master stored it.
 */
export function resolveLoginIdentity(claims: ResolvedOAuthClaims): IdentityResolution {
  const phoneRaw = typeof claims.phone === 'string' ? claims.phone : '';
  const usernameRaw = typeof claims.username === 'string' ? claims.username : '';
  // Blank-check on the trimmed form; KEEP the untrimmed value (see above).
  const phone = phoneRaw.trim() ? phoneRaw : '';
  const username = usernameRaw.trim() ? usernameRaw : '';
  const key = phone || username;
  if (!key) return { ok: false, code: 'no_phone_or_username_claim' };
  return {
    ok: true,
    identity: { key, displayName: username || key, source: phone ? 'phone' : 'username' },
  };
}

export interface LoginFailurePayload {
  success: false;
  error: string;
  code: LoginFailureCode;
  requestId?: string;
}

/**
 * Build the `loginResult` failure frame.
 *
 * `requestId` is echoed straight back from the client's emit. poker-3d runs
 * FIVE auth flows over ONE socket (bridge handoff, boot refresh, legacy
 * tokenLogin, OIDC callback, deep-link ticket) and every one of them listened
 * to the same global `loginResult` event — so one flow's failure was consumed
 * by all of them, and the bridge handoff routinely reported (and acted on) a
 * rejection that belonged to the concurrent stale-token `tokenLogin`. Echoing
 * the id is what lets each flow recognise its own result. It is opaque to the
 * server and is length-clamped; clients that don't send one get the previous
 * shape.
 *
 * COVERAGE (2026-08-17, corrected TWICE — read this before trusting it).
 *
 * Revision 1 of this comment listed the deep-link ticket among the flows in a
 * way that read as "already handled". It was not; `authWithTicket` emitted a
 * dozen bare `loginResult` frames with no requestId and no code.
 *
 * Revision 2 then claimed converting `authWithTicket` finished the job. That
 * was ALSO wrong, and in a worse way, because the client had already been
 * switched to requestId-scoped listeners on the strength of it:
 * `joinWithWaitlistContext` — the OTHER deep-link handler, reached from the
 * at-venue waitlist SMS — never emitted `loginResult` on ANY branch at all. It
 * answers on `error` / `gameState`. So routing it through the scoped client
 * helper guaranteed a 15s watchdog timeout on EVERY invocation, while the
 * server had already seated the player and deducted their buy-in.
 *
 * CONVERTED as of this change: `oauthLogin`, `tokenLogin`, `authWithTicket`,
 * `joinWithWaitlistContext`.
 *
 * STILL UNCONVERTED, deliberately: the password `login` handler (index.ts,
 * `socket.on('login')`), which poker-3d does not use — its login screen
 * redirects to the OIDC /authorize flow and only emits `register` for guests.
 * If a client ever starts emitting `login` on a shared socket, convert it too.
 *
 * THE STANDING RULE, since this has now been got wrong twice: before claiming
 * coverage, `grep -n "loginResult" src/index.ts` and check EVERY emitter, and
 * separately check every handler the CLIENT routes through the scoped helper —
 * a handler that emits no `loginResult` at all is the failure mode that does
 * not show up when you only audit the emitters.
 */
export function buildLoginFailure(
  code: LoginFailureCode,
  message: string,
  requestId?: unknown
): LoginFailurePayload {
  const rid = typeof requestId === 'string' && requestId ? requestId.slice(0, 64) : undefined;
  return { success: false, error: message, code, ...(rid ? { requestId: rid } : {}) };
}

/** Normalise a client-supplied correlation id (or undefined). */
export function normalizeRequestId(requestId: unknown): string | undefined {
  return typeof requestId === 'string' && requestId ? requestId.slice(0, 64) : undefined;
}

// ---------------------------------------------------------------------------
// 2026-08-17 P0 — local-row ownership (INTERIM account-takeover guard)
// ---------------------------------------------------------------------------
// THE HOLE (verified, live today):
//   1. auth-server derives the `username` claim as `[firstName, lastName]
//      .join(' ')` — a NON-UNIQUE human display name, not the master's unique
//      `users.username`.
//   2. `extraTokenClaims` ships no `phone`, so `resolveLoginIdentity`'s
//      prefer-phone branch is dead in prod and 100% of .online logins key on
//      that display name.
//   3. poker-server upserts the local row `ON CONFLICT (LOWER(username))`, so
//      the caller is bound to whatever row that name matches — inheriting its
//      id, chips, progression and `is_admin`.
//   4. The master API's `updateUser` validates firstName/lastName only as
//      "string, <= 50 chars" and a user may set their own.
//   ⇒ any player can rename themselves to an admin's display name and sign in
//     as that admin. The benign form already happens: two real "John Smith"s
//     silently share one account.
//
// THE REAL FIX is a `master_user_id` column with a unique index, keyed on the
// cryptographically-attested `sub`. That needs a Railway Postgres schema change
// plus a backfill of every existing row, which is not available from here.
//
// THE INTERIM FIX (this): detect, and OPTIONALLY refuse, a login that would
// bind to a row DEMONSTRABLY belonging to a different master account, using the
// `stats->>'masterUserId'` value both upsert sites already write. Rows with no
// masterUserId are legacy and are still adopted exactly as before — and are
// STAMPED on adoption, so each one becomes owned (and protected) from its first
// OIDC login. Migration therefore happens organically, one login at a time.
//
// 🚨 SHIPS IN WARN MODE. See `resolveIdentityGuardMode` below for why refusing
// is not safe to enable yet, and for the exact sequence to enable it.
//
// TYPE NOTE — do not "simplify" the cast. `users.stats` is declared
// `TEXT DEFAULT '{}'` in authManager.initDB, while authManager.saveProgress
// (`COALESCE(stats,'{}'::jsonb) || $n::jsonb`) and index.ts's authWithTicket
// lookup (`stats->>'masterUserId'`) both treat it as JSONB — and BOTH of those
// would hard-error on a TEXT column, while both are wrapped in swallowing
// try/catches, which is precisely why the disagreement has never surfaced.
// The declared type is not evidence either way: initDB uses CREATE TABLE IF NOT
// EXISTS, so it has not described the live table since the first boot.
// Every expression below is therefore written to be correct under BOTH:
// `NULLIF(x::text,'')::jsonb` round-trips a jsonb value and parses a text one,
// and the JS side accepts an object (jsonb driver) or a string (text driver).
// index.ts probes `information_schema` once at boot and reports the real answer
// on /api/health — see `probeStatsColumnType`. Read it there; do not re-derive.

/**
 * Enforcement mode for the ownership guard above.
 *
 * 🚨 DEFAULT IS `warn`, DELIBERATELY, AND MUST STAY THAT WAY UNTIL THE STEPS
 * BELOW ARE DONE. Enforcing today would be a net LOSS of safety:
 *
 *   • Measured exposure of the hole: ZERO. An audit of all 2,268 live master
 *     accounts (2026-08-17) found NO display-name collision involving an admin
 *     account. The escalation path is real but nobody is currently standing on
 *     it.
 *   • Measured cost of enforcing: FOUR real people locked out permanently.
 *     Production has 4 confirmed pairs of duplicate master accounts belonging
 *     to the same human — cory.sayles/cory.sayles2, jamar.harris/jamar.harris2,
 *     derek.eldred/derek.eldred2, ryan.godwin/ryan.godwin2. They share a display
 *     name, so whichever account signs in first stamps the row and the other is
 *     refused `identity_conflict` FOREVER.
 *   • There is NO recovery path for that lockout from inside the running app
 *     unless an admin is available: no admin socket handler could clear
 *     `stats.masterUserId`, rename a local row, or delete a user. This change
 *     adds `adminClearIdentityStamp` to close that gap — but an admin has to be
 *     awake and reachable, which is not a rollout plan.
 *   • The client treats `identity_conflict` as DEFINITIVE
 *     (poker-3d socketAuth.js:isDefinitiveLoginFailure), suppressing the
 *     fall-through to the local auto-login paths. So a false positive is a hard
 *     stop, not a degraded retry.
 *   • And this lands mid-outage. "Don't make it worse" outranks "close a hole
 *     nobody is standing in".
 *
 * WARN mode runs the identical ownership check and emits the identical
 * structured log record (both master ids, the local row id, its is_admin) —
 * then BINDS AND RETURNS THE ROW exactly as the pre-guard code did. Zero
 * behaviour change for users; the full list of genuinely-colliding pairs
 * accumulates in Railway logs within hours.
 *
 * SEQUENCE TO ENABLE (in order, none optional):
 *   1. Ship this in warn mode. Leave it for at least a full weekly cycle.
 *   2. Collect the conflicts: search Railway logs for `IDENTITY CONFLICT` and
 *      the structured `[login-failure]` / `[identity-guard]` lines.
 *   3. Confirm `users.stats` is JSONB via /api/health `identityGuard
 *      .statsColumnType`, and confirm the adoption stamp is actually DURABLE
 *      (mergeUserStats used to wipe the whole stats column on every completed
 *      hand under the JSONB hypothesis — fixed 2026-08-17, but verify on real
 *      data before trusting the stamp to gate logins).
 *   4. Merge or rename the real duplicate accounts (the 4 pairs above and
 *      anything else step 2 turns up), using `adminClearIdentityStamp` to free
 *      a wrongly-stamped row.
 *   5. ONLY THEN set ONLINE_IDENTITY_GUARD_ENFORCE=1 on the Railway
 *      poker-server service.
 *
 * The real fix remains a `master_user_id` column with a unique index keyed on
 * the attested `sub`, which removes the mutable display name from identity
 * entirely and makes this whole mode switch unnecessary.
 */
export type IdentityGuardMode = 'warn' | 'enforce';

/** Parse ONLINE_IDENTITY_GUARD_ENFORCE. Anything but an explicit opt-in is warn. */
export function resolveIdentityGuardMode(raw: unknown): IdentityGuardMode {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'enforce' ? 'enforce' : 'warn';
}

/**
 * SQL fragment: is this conflicting row safe to bind to the caller?
 *
 * Safe when the row is unowned (legacy, no masterUserId) or already owned by
 * THIS master `sub`. `$N` must be bound to the attested sub.
 *
 * Used as the `WHERE` of `ON CONFLICT ... DO UPDATE`. When it is false the
 * update touches nothing and `RETURNING` yields NO ROW — which is what makes
 * this fail-closed rather than fail-silent.
 */
export function masterIdGuardSql(subParam: string): string {
  return `(NULLIF(users.stats::text, '')::jsonb ->> 'masterUserId') IS NULL
          OR (NULLIF(users.stats::text, '')::jsonb ->> 'masterUserId') = ${subParam}`;
}

/** Read a `users.stats` column value that may arrive as jsonb-object or TEXT. */
export function parseStatsColumn(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* corrupt stats — treat as empty rather than throwing a login */ }
  }
  return {};
}

/**
 * The master identity keys poker-server stamps onto a local row.
 *
 * 🚨 FIELD SEMANTICS — 2026-08-17 P3 correction. `users.stats` has THREE
 * writers and they were not agreeing on what these keys mean:
 *
 *   • authManager.syncMasterUser  → masterUsername = masterData.username
 *   • index.ts authWithTicket     → masterUsername = masterUser.username
 *   • index.ts OIDC socket login  → masterUsername = the `username` CLAIM
 *
 * The first two are the master API's stable unique slug (`josh.hall2`). The
 * third is auth-server's `username` claim, which extraTokenClaims derives as
 * `[firstName, lastName].join(' ')` — a DISPLAY NAME (`Josh Hall`). Two
 * different values in one field.
 *
 * The visible consequence was a write ping-pong that defeated the "returning
 * player skips the UPDATE entirely" optimisation this function exists to
 * provide: authWithTicket saw `masterUsername !== masterUser.username`, wrote
 * the slug, then the next OIDC login saw it differ from the display name and
 * wrote that back — one stats UPDATE on the hot path of EVERY login, forever,
 * on every row both paths touch.
 *
 * The same bug filled `masterPhone` with a display name, because the OIDC
 * caller passed the resolved local key and in production that key IS the
 * username claim.
 *
 * RULE GOING FORWARD:
 *   masterUserId      — the attested OIDC `sub` / master users.id. Identity.
 *   masterUsername    — the master API's unique slug. NOT written by the OIDC
 *                       path, which never receives it (it only has the claim).
 *   masterDisplayName — the human display name from the `username` claim.
 *   masterPhone       — a REAL phone number, or absent. Never a name.
 *
 * Rows already carrying a display name in `masterUsername` self-correct on
 * their next authWithTicket (its drift branch overwrites with the slug) and are
 * then stable, because nothing writes the display name into that key any more.
 * No backfill is needed and none is attempted — nothing READS these keys for
 * behaviour; the only consumer is authWithTicket's drift comparison.
 */
export interface MasterIdentityStamp {
  masterUserId: string;
  /** Master API's unique slug. Omit unless you genuinely have it. */
  masterUsername?: string;
  /** Human display name (auth-server `username` claim). */
  masterDisplayName?: string;
  /** A real phone number, or omitted. NEVER a display name. */
  masterPhone?: string;
}

/**
 * Ownership test for an ALREADY-FETCHED row. Mirrors `masterIdGuardSql` so the
 * diagnostic path and the SQL guard can never disagree.
 */
export function isRowOwnedByOtherMaster(rawStats: unknown, sub: string): boolean {
  const owner = parseStatsColumn(rawStats).masterUserId;
  if (owner == null || owner === '') return false; // unowned legacy row — adoptable
  return String(owner) !== String(sub);
}

/**
 * Compute the stats value to write when ADOPTING a legacy row (or repairing a
 * drifted one). Returns `null` when nothing needs writing, so the common case
 * (returning player, already stamped) skips the UPDATE entirely.
 *
 * MERGES — never replaces. `users.stats` carries unrelated keys written by
 * other subsystems (chipRecoveryGrantApplied, starsRecoveryGrantApplied,
 * handsPlayed, lastSeen…). Clobbering them is the exact data-loss shape
 * CLAUDE.md's "user data MUST persist" rule forbids.
 */
export function mergeMasterIdentityStats(
  rawStats: unknown,
  stamp: MasterIdentityStamp
): Record<string, any> | null {
  const existing = parseStatsColumn(rawStats);
  const next: Record<string, any> = { ...existing };
  let changed = false;

  if (String(existing.masterUserId ?? '') !== String(stamp.masterUserId)) {
    next.masterUserId = String(stamp.masterUserId);
    changed = true;
  }
  if (stamp.masterUsername != null && existing.masterUsername !== stamp.masterUsername) {
    next.masterUsername = stamp.masterUsername;
    changed = true;
  }
  if (stamp.masterDisplayName != null && existing.masterDisplayName !== stamp.masterDisplayName) {
    next.masterDisplayName = stamp.masterDisplayName;
    changed = true;
  }
  if (stamp.masterPhone != null && existing.masterPhone !== stamp.masterPhone) {
    next.masterPhone = stamp.masterPhone;
    changed = true;
  }
  return changed ? next : null;
}

/**
 * Remove the ownership stamp from a row's stats, returning the new stats object
 * and the owner id that was removed (null if the row was already unowned).
 *
 * This is the ADMIN RECOVERY primitive behind the `adminClearIdentityStamp`
 * socket handler. Its absence is the single biggest reason the guard cannot be
 * enforced: once a row is stamped, a second human sharing that display name is
 * refused with no way back, and no existing admin handler could clear it.
 *
 * Deliberately clears ONLY `masterUserId` — the key the guard reads. The
 * descriptive keys (masterUsername / masterDisplayName / masterPhone) are left
 * alone so the row stays identifiable in support, and every unrelated stats key
 * (chips/stars recovery flags, handsPlayed, …) is preserved: this is a MERGE,
 * like every other write to this column. The removed id is returned so the
 * audit-log row can carry it and the action can be reversed by hand.
 */
export function clearMasterIdentityStamp(
  rawStats: unknown
): { stats: Record<string, any>; clearedMasterUserId: string | null } {
  const existing = parseStatsColumn(rawStats);
  const owner = existing.masterUserId;
  const next = { ...existing };
  delete next.masterUserId;
  return {
    stats: next,
    clearedMasterUserId: owner == null || owner === '' ? null : String(owner),
  };
}
