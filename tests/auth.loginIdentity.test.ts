/**
 * Regression guards for the 2026-08-17 .online sign-in outage.
 *
 * Symptom: "Play Online" (the cross-site bridge handoff from americanpub.poker)
 * failed ~2 of every 3 attempts. Live forensics proved the auth-server minted a
 * valid token set AND that poker-server's introspection of it returned
 * `active:true` WITH a username claim — yet the socket login was still refused,
 * and the reason was structurally undiscoverable (only 1 of 5 reject branches
 * emitted any server-side event, and that reporter was itself a silent no-op).
 *
 * These tests pin the two invariants that make the failure impossible to
 * reintroduce silently:
 *   1. A bridged token's claim shape (username only, NO phone) resolves to an
 *      identity. Requiring `phone` here would kill every cross-site SSO hop.
 *   2. Every refusal carries a machine-readable `code`, and the client's
 *      `requestId` is echoed back so concurrent auth flows on one socket can
 *      tell their own result apart from someone else's.
 */

import {
  resolveLoginIdentity,
  buildLoginFailure,
  normalizeRequestId,
  masterIdGuardSql,
  parseStatsColumn,
  isRowOwnedByOtherMaster,
  mergeMasterIdentityStats,
  resolveIdentityGuardMode,
  clearMasterIdentityStamp,
  type ResolvedOAuthClaims,
} from '../src/auth/loginIdentity';

describe('resolveLoginIdentity — the branch that rejected valid bridged logins', () => {
  it('accepts a BRIDGED token: username claim only, no phone (opaque AT via introspection)', () => {
    // Exactly what auth-server's introspection returns for a urn:apk:bridge
    // access token — extraTokenClaims supplies username/is_admin/roles, never
    // phone. Verified live: introspection body length tracked 1466+len(username)
    // for five distinct .online users on 2026-08-16/17.
    const claims: ResolvedOAuthClaims = {
      valid: true,
      sub: '16899b30-fcc1-4be1-94f9-47f54cacf240',
      username: 'Rodney Elmore',
      isAdmin: false,
    };
    const res = resolveLoginIdentity(claims);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.identity.key).toBe('Rodney Elmore');
    expect(res.identity.displayName).toBe('Rodney Elmore');
    // The key came from the USERNAME claim, so nothing here is a phone number.
    // Callers use this to avoid stamping a display name into stats.masterPhone.
    expect(res.identity.source).toBe('username');
  });

  it('prefers phone when auth-server supplies one (JWT access token path)', () => {
    const res = resolveLoginIdentity({
      valid: true, sub: 'abc', phone: '7205551234', username: 'Hank Debelak',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.identity.key).toBe('7205551234');
    // Display name still comes from the human-readable claim.
    expect(res.identity.displayName).toBe('Hank Debelak');
    expect(res.identity.source).toBe('phone');
  });

  it('refuses with a labelled code when BOTH claims are absent (degraded /me)', () => {
    const res = resolveLoginIdentity({ valid: true, sub: 'abc' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.code).toBe('no_phone_or_username_claim');
  });

  it('treats whitespace-only claims as absent (no junk local user rows)', () => {
    const res = resolveLoginIdentity({ valid: true, sub: 'abc', username: '   ', phone: '' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.code).toBe('no_phone_or_username_claim');
  });

  it('does NOT trim a usable claim — trimming would MERGE two distinct accounts', () => {
    // 2026-08-17 P0. An earlier revision returned `username.trim()`. That looks
    // like harmless hygiene and is actually a new account-collision surface:
    // the local row is keyed on this value via ON CONFLICT (LOWER(username)),
    // and the master API's updateUser does NOT trim first/last names (it
    // validates only "string, <= 50 chars"). So a user who sets their last name
    // to " Hall" produces the claim "Josh  Hall" / "  Josh Hall" — which
    // trimming would fold onto the REAL "Josh Hall"'s row, handing over their
    // chips, progression and is_admin flag. Blank is still rejected (below);
    // non-blank is used exactly as the master stored it.
    const res = resolveLoginIdentity({ valid: true, sub: 'abc', username: '  Zig Mek  ' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.identity.key).toBe('  Zig Mek  ');
    expect(res.identity.displayName).toBe('  Zig Mek  ');
  });

  it('keeps an untrimmed name DISTINCT from its trimmed twin', () => {
    const a = resolveLoginIdentity({ valid: true, sub: 'attacker', username: ' Josh Hall' });
    const b = resolveLoginIdentity({ valid: true, sub: 'victim', username: 'Josh Hall' });
    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect(a.identity.key).not.toBe(b.identity.key);
  });
});

// ---------------------------------------------------------------------------
// P0 — interim account-takeover / admin-escalation guard
// ---------------------------------------------------------------------------
// The local row is keyed on a NON-UNIQUE display name (auth-server's `username`
// claim is `[firstName, lastName].join(' ')`, and a user may set their own via
// the master API's updateUser). These tests pin the fail-closed guard that
// stops one master account's login from binding to another's local row.

describe('isRowOwnedByOtherMaster — who does this local row belong to?', () => {
  it('adopts a LEGACY row with no masterUserId (existing players must keep working)', () => {
    expect(isRowOwnedByOtherMaster({ handsPlayed: 12 }, 'sub-1')).toBe(false);
    expect(isRowOwnedByOtherMaster(null, 'sub-1')).toBe(false);
    expect(isRowOwnedByOtherMaster(undefined, 'sub-1')).toBe(false);
    expect(isRowOwnedByOtherMaster('{}', 'sub-1')).toBe(false);
    expect(isRowOwnedByOtherMaster({ masterUserId: '' }, 'sub-1')).toBe(false);
  });

  it('allows the SAME master account back into its own row', () => {
    expect(isRowOwnedByOtherMaster({ masterUserId: 'sub-1' }, 'sub-1')).toBe(false);
    // TEXT-column form (see the users.stats TEXT-vs-JSONB note in the module).
    expect(isRowOwnedByOtherMaster('{"masterUserId":"sub-1"}', 'sub-1')).toBe(false);
  });

  it('REFUSES a row owned by a different master account (the takeover)', () => {
    // The live chain: a player renames themselves to an admin's display name,
    // signs in to .online, and the ON CONFLICT upsert binds them to the admin's
    // row — inheriting chips, progression and is_admin=true.
    const adminRow = { masterUserId: 'admin-uuid', masterUsername: 'Josh Hall' };
    expect(isRowOwnedByOtherMaster(adminRow, 'attacker-uuid')).toBe(true);
    expect(isRowOwnedByOtherMaster('{"masterUserId":"admin-uuid"}', 'attacker-uuid')).toBe(true);
  });

  it('compares as strings so a numeric master id can never slip through', () => {
    expect(isRowOwnedByOtherMaster({ masterUserId: 42 }, '42')).toBe(false);
    expect(isRowOwnedByOtherMaster({ masterUserId: 42 }, '43')).toBe(true);
  });

  it('treats corrupt stats as unowned rather than throwing a login', () => {
    expect(isRowOwnedByOtherMaster('not json at all', 'sub-1')).toBe(false);
    expect(isRowOwnedByOtherMaster('[1,2,3]', 'sub-1')).toBe(false);
  });
});

describe('masterIdGuardSql — the ON CONFLICT DO UPDATE WHERE clause', () => {
  const sql = masterIdGuardSql('$6');

  it('binds the caller sub exactly once, at the placeholder it was given', () => {
    expect(sql.match(/\$6/g)).toHaveLength(1);
    expect(masterIdGuardSql('$3')).toContain('$3');
    expect(masterIdGuardSql('$3')).not.toContain('$6');
  });

  it('permits an unowned row OR a row owned by the same sub, nothing else', () => {
    expect(sql).toContain('IS NULL');
    expect(sql).toContain("'masterUserId'");
    expect(sql).toContain('OR');
    // No other escape hatch: exactly two disjuncts.
    expect(sql.split(/\bOR\b/)).toHaveLength(2);
  });

  it('reads users.stats through a cast that works whether it is TEXT or JSONB', () => {
    // users.stats is declared `TEXT DEFAULT '{}'` in authManager.initDB, while
    // saveProgress and authWithTicket both treat it as JSONB. Which one prod
    // actually has is not determinable from this repo, so the guard must be
    // correct under both — and must not blow up on an empty-string cell.
    expect(sql).toContain("NULLIF(users.stats::text, '')::jsonb");
  });
});

describe('mergeMasterIdentityStats — adoption stamp, MERGE not replace', () => {
  it('stamps an unowned legacy row so it is protected from the NEXT login on', () => {
    const merged = mergeMasterIdentityStats(
      { handsPlayed: 7, chipRecoveryGrantApplied: true },
      { masterUserId: 'sub-1', masterDisplayName: 'Zig Mek' }
    );
    expect(merged).toEqual({
      handsPlayed: 7,
      chipRecoveryGrantApplied: true,
      masterUserId: 'sub-1',
      masterDisplayName: 'Zig Mek',
    });
  });

  // 2026-08-17 P3 — field semantics. The OIDC path only ever has the display-name
  // claim, never the master API's slug, and it must not write one into the
  // other's key. Two concrete bugs came from conflating them:
  //   (a) a stats-UPDATE ping-pong on EVERY login, because authWithTicket
  //       compares masterUsername against the SLUG and rewrites it, which the
  //       next OIDC login then rewrote back — defeating this function's entire
  //       "returning player skips the UPDATE" purpose;
  //   (b) masterPhone being filled with a person's name.
  it('does NOT write the display name into masterUsername (the slug key)', () => {
    const merged = mergeMasterIdentityStats(
      { masterUserId: 'sub-1', masterUsername: 'josh.hall2' },
      { masterUserId: 'sub-1', masterDisplayName: 'Josh Hall' }
    );
    // masterUsername (the slug authWithTicket owns) is untouched...
    expect(merged?.masterUsername).toBe('josh.hall2');
    // ...and the display name lands in its own key.
    expect(merged?.masterDisplayName).toBe('Josh Hall');
  });

  it('no longer ping-pongs with authWithTicket: a second identical login is a no-op', () => {
    // Row as authWithTicket leaves it (slug in masterUsername), then an OIDC
    // login stamps the display name once...
    const first = mergeMasterIdentityStats(
      { masterUserId: 'sub-1', masterUsername: 'josh.hall2' },
      { masterUserId: 'sub-1', masterDisplayName: 'Josh Hall' }
    );
    expect(first).not.toBeNull();
    // ...and every subsequent OIDC login writes NOTHING, which is the property
    // the "skips the UPDATE entirely" comment claims and previously lacked.
    expect(mergeMasterIdentityStats(first, {
      masterUserId: 'sub-1', masterDisplayName: 'Josh Hall',
    })).toBeNull();
  });

  it('omits masterPhone entirely when the login had no phone claim', () => {
    const merged = mergeMasterIdentityStats(
      { handsPlayed: 1 },
      { masterUserId: 'sub-1', masterDisplayName: 'Zig Mek' }
    );
    expect(merged).not.toHaveProperty('masterPhone');
  });

  it('writes masterPhone only when given a real phone', () => {
    const merged = mergeMasterIdentityStats(
      {},
      { masterUserId: 'sub-1', masterDisplayName: 'Hank Debelak', masterPhone: '7205551234' }
    );
    expect(merged?.masterPhone).toBe('7205551234');
  });

  it('never clobbers unrelated stats keys (CLAUDE.md "user data MUST persist")', () => {
    const merged = mergeMasterIdentityStats(
      '{"starsRecoveryGrantApplied":true,"biggestPot":91000}',
      { masterUserId: 'sub-1' }
    );
    expect(merged?.starsRecoveryGrantApplied).toBe(true);
    expect(merged?.biggestPot).toBe(91000);
    expect(merged?.masterUserId).toBe('sub-1');
  });

  it('returns null when nothing changed, so the hot path skips the UPDATE', () => {
    const stats = { masterUserId: 'sub-1', masterDisplayName: 'Zig', masterPhone: '7205551234' };
    expect(mergeMasterIdentityStats(stats, {
      masterUserId: 'sub-1', masterDisplayName: 'Zig', masterPhone: '7205551234',
    })).toBeNull();
  });

  it('leaves an existing masterUsername alone when the claim omits it', () => {
    const merged = mergeMasterIdentityStats(
      { masterUserId: 'sub-1', masterUsername: 'old.slug' },
      { masterUserId: 'sub-1' }
    );
    expect(merged).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WARN vs ENFORCE — the mode switch is the whole reason this is safe to deploy
// ---------------------------------------------------------------------------
// Enforcing today would permanently lock out 4 KNOWN real people (production has
// 4 confirmed pairs of duplicate master accounts belonging to one human each,
// sharing a display name) to close a hole with ZERO measured exposure (no admin
// display-name collision exists across all 2,268 live master accounts). These
// tests pin the default so a future refactor cannot flip it by accident.
describe('resolveIdentityGuardMode — MUST default to warn', () => {
  it('defaults to warn when the env var is unset, empty, or whitespace', () => {
    expect(resolveIdentityGuardMode(undefined)).toBe('warn');
    expect(resolveIdentityGuardMode(null)).toBe('warn');
    expect(resolveIdentityGuardMode('')).toBe('warn');
    expect(resolveIdentityGuardMode('   ')).toBe('warn');
  });

  it('does NOT enforce on arbitrary or near-miss values — only an explicit opt-in', () => {
    // A typo'd env var must fail SAFE (warn), never silently start refusing
    // logins mid-outage.
    for (const v of ['0', 'false', 'no', 'off', 'warn', 'enforced', 'yes', 'ENFORCE_LATER', 2]) {
      expect(resolveIdentityGuardMode(v)).toBe('warn');
    }
  });

  it('enforces only on the documented opt-in values', () => {
    expect(resolveIdentityGuardMode('1')).toBe('enforce');
    expect(resolveIdentityGuardMode('true')).toBe('enforce');
    expect(resolveIdentityGuardMode('enforce')).toBe('enforce');
    // Case/whitespace tolerant, since this is typed into a Railway env field.
    expect(resolveIdentityGuardMode(' TRUE ')).toBe('enforce');
    expect(resolveIdentityGuardMode('Enforce')).toBe('enforce');
  });

  it('warn mode still DETECTS the conflict — the check is shared, only the action differs', () => {
    // The point of warn mode: identical detection, identical log record, but the
    // row is still bound and returned. isRowOwnedByOtherMaster is the single
    // predicate both modes call, so they can never disagree about what a
    // conflict IS.
    const adminRow = { masterUserId: 'admin-uuid' };
    expect(isRowOwnedByOtherMaster(adminRow, 'attacker-uuid')).toBe(true);
    expect(resolveIdentityGuardMode(undefined)).toBe('warn');
  });
});

describe('clearMasterIdentityStamp — the admin recovery path', () => {
  it('un-owns a stamped row so the rightful account can adopt it', () => {
    const { stats, clearedMasterUserId } = clearMasterIdentityStamp({
      masterUserId: 'sub-1', masterDisplayName: 'Cory Sayles', handsPlayed: 40,
    });
    expect(clearedMasterUserId).toBe('sub-1');
    expect(stats).not.toHaveProperty('masterUserId');
    // isRowOwnedByOtherMaster must now accept ANY master account — that is what
    // "recovered" means, and it is the exact condition the guard re-tests.
    expect(isRowOwnedByOtherMaster(stats, 'sub-2')).toBe(false);
  });

  it('preserves every unrelated stats key (CLAUDE.md "user data MUST persist")', () => {
    const { stats } = clearMasterIdentityStamp(
      '{"masterUserId":"sub-1","chipRecoveryGrantApplied":true,"biggestPot":91000}'
    );
    expect(stats.chipRecoveryGrantApplied).toBe(true);
    expect(stats.biggestPot).toBe(91000);
  });

  it('keeps the descriptive keys so the row stays identifiable in support', () => {
    const { stats } = clearMasterIdentityStamp({
      masterUserId: 'sub-1', masterUsername: 'cory.sayles2', masterDisplayName: 'Cory Sayles',
    });
    expect(stats.masterUsername).toBe('cory.sayles2');
    expect(stats.masterDisplayName).toBe('Cory Sayles');
  });

  it('is a safe no-op on an already-unowned row', () => {
    const { stats, clearedMasterUserId } = clearMasterIdentityStamp({ handsPlayed: 3 });
    expect(clearedMasterUserId).toBeNull();
    expect(stats).toEqual({ handsPlayed: 3 });
  });

  it('survives a corrupt stats column without throwing', () => {
    expect(() => clearMasterIdentityStamp('not json')).not.toThrow();
    expect(clearMasterIdentityStamp('not json').clearedMasterUserId).toBeNull();
  });
});

describe('parseStatsColumn — jsonb driver returns objects, TEXT driver returns strings', () => {
  it('accepts both shapes and degrades to {} on anything else', () => {
    expect(parseStatsColumn({ a: 1 })).toEqual({ a: 1 });
    expect(parseStatsColumn('{"a":1}')).toEqual({ a: 1 });
    expect(parseStatsColumn(null)).toEqual({});
    expect(parseStatsColumn('')).toEqual({});
    expect(parseStatsColumn('   ')).toEqual({});
    expect(parseStatsColumn('nonsense')).toEqual({});
    expect(parseStatsColumn(['a'])).toEqual({});
    expect(parseStatsColumn(42)).toEqual({});
  });
});

describe('buildLoginFailure — every refusal is labelled and correlatable', () => {
  it('always carries a machine-readable code alongside the prose message', () => {
    const p = buildLoginFailure('user_upsert_failed', 'We could not load your account just now — please try again.');
    expect(p).toEqual({
      success: false,
      code: 'user_upsert_failed',
      error: 'We could not load your account just now — please try again.',
    });
  });

  it('echoes the caller requestId so concurrent flows on one socket can attribute results', () => {
    // The outage amplifier: poker-3d ran the bridge handoff and a stale-token
    // tokenLogin on the SAME socket, both listening to the same global
    // `loginResult`. The bridge consumed the OTHER flow's rejection and wiped
    // the freshly-minted, still-valid tokens.
    const p = buildLoginFailure('legacy_token_invalid', 'Invalid or expired token', 'bridge-42');
    expect(p.requestId).toBe('bridge-42');
  });

  it('omits requestId entirely for legacy clients that do not send one', () => {
    expect(buildLoginFailure('token_invalid', 'Invalid token')).not.toHaveProperty('requestId');
    expect(buildLoginFailure('token_invalid', 'Invalid token', 123 as unknown)).not.toHaveProperty('requestId');
    expect(buildLoginFailure('token_invalid', 'Invalid token', '')).not.toHaveProperty('requestId');
  });

  it('clamps a hostile requestId to 64 chars', () => {
    const p = buildLoginFailure('token_invalid', 'Invalid token', 'x'.repeat(500));
    expect(p.requestId).toHaveLength(64);
  });
});

describe('normalizeRequestId', () => {
  it('passes through a normal id and rejects non-strings', () => {
    expect(normalizeRequestId('abc')).toBe('abc');
    expect(normalizeRequestId(undefined)).toBeUndefined();
    expect(normalizeRequestId(null)).toBeUndefined();
    expect(normalizeRequestId({})).toBeUndefined();
  });
});
