import * as jose from 'jose';

const AUTH_SERVER_URL = process.env.AUTH_SERVER_URL || 'https://auth.americanpubpoker.online';
const INTROSPECTION_URL = `${AUTH_SERVER_URL}/token/introspection`;
const CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'poker-server';

// 2026-07-07 — structured JWT access tokens. poker-3d (and any client that sends
// `resource=API_RESOURCE`) receives an RS256 JWT access token (aud=API_RESOURCE),
// NOT an opaque one. oidc-provider REFUSES to introspect structured JWTs
// ("unsupported_token_type", 400 "Structured JWT Tokens cannot be introspected"),
// so the introspection path below fails those logins. We verify JWT tokens via
// the auth-server JWKS instead (same trust root the master API's requireAuth
// uses). Opaque tokens (bridge / ticket / legacy) still go to introspection.
const JWKS_URL = `${AUTH_SERVER_URL}/jwks`;
const API_RESOURCE = process.env.API_RESOURCE
  || 'https://poker-prod-api-azeg4kcklq-uc.a.run.app/poker-api';
let _jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
function getJwks() {
  if (!_jwks) _jwks = jose.createRemoteJWKSet(new URL(JWKS_URL));
  return _jwks;
}
// An opaque oidc-provider access token is a dotless random string; a structured
// JWT has exactly three dot-separated segments.
function looksLikeJwt(t: string): boolean {
  return typeof t === 'string' && t.split('.').length === 3;
}

async function verifyJwtAccessToken(token: string): Promise<OAuthTokenResult> {
  try {
    const { payload } = await jose.jwtVerify(token, getJwks(), {
      issuer: AUTH_SERVER_URL,   // matches auth-server AUTH_ISSUER
      audience: API_RESOURCE,    // access tokens minted for the master API resource
    });
    const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
    if (!sub) return { valid: false, error: 'JWT missing sub' };
    // extraTokenClaims puts username/roles/is_admin on the access token; phone is
    // not present there, so oauthLogin's `phone || username` falls back to username.
    return {
      valid: true,
      sub,
      username: (payload.username as string) || (payload.preferred_username as string),
      phone: (payload.phone as string) || (payload.phone_number as string),
      isAdmin: payload.is_admin === true,
    };
  } catch (err: any) {
    // Bad signature / expired / wrong issuer|aud → an invalid USER token, not a
    // credential problem. Return invalid so the client re-authenticates. (Do NOT
    // fall through to introspection — a JWT can't be introspected anyway.)
    return { valid: false, error: `JWT verification failed (${err?.code || err?.message || 'invalid'})` };
  }
}

// Fail-close the OAUTH_CLIENT_SECRET fallback. The dev value
// ('dev-poker-server-secret') is public-knowledge and must NEVER be used to
// authenticate to a real auth-server. In production (NODE_ENV=production or
// any non-empty RAILWAY_ENVIRONMENT) we throw at module load so Railway
// crash-loops the deploy until the env var is set — which is the right
// behavior versus silently shipping with a known weak credential.
// In dev, keep the fallback so local workflows still work, but log loudly.
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
if (!process.env.OAUTH_CLIENT_SECRET) {
  if (IS_PRODUCTION) {
    throw new Error('OAUTH_CLIENT_SECRET env var is required in production');
  }
  // eslint-disable-next-line no-console
  console.warn(
    '[oauthValidator] OAUTH_CLIENT_SECRET is not set — falling back to the dev value. ' +
      'This is only safe in local development. Set OAUTH_CLIENT_SECRET before deploying.'
  );
}
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || 'dev-poker-server-secret';

export interface OAuthTokenResult {
  valid: boolean;
  sub?: string;         // local user ID from auth server
  username?: string;
  phone?: string;
  isAdmin?: boolean;
  error?: string;
  // 2026-07-06 P1 (secret single-sourcing) — surfaced so callers can tell a
  // CREDENTIAL break (our OAUTH_CLIENT_SECRET no longer matches the
  // auth-server's registered secret — fleet-wide, every login fails) apart
  // from a bad/expired user token (normal). status = raw HTTP status of a
  // non-OK introspection response; clientAuthFailed = that status was 401
  // (invalid_client). See preflightIntrospection() below for the boot check.
  status?: number;
  clientAuthFailed?: boolean;
}

export async function validateOAuthToken(token: string): Promise<OAuthTokenResult> {
  // 2026-07-07 — JWT access tokens (resource=API_RESOURCE clients, incl. the
  // primary poker-3d "Sign in" + silent-SSO flow) are verified via JWKS, not
  // introspection (oidc-provider rejects JWT introspection). Opaque tokens
  // (bridge / ticket / legacy) fall through to the introspection path below.
  if (looksLikeJwt(token)) {
    return verifyJwtAccessToken(token);
  }

  // 5s hard timeout — if the auth server stalls we want to fail fast so
  // the client's `loginResult` timeout doesn't fire first with no error
  // message. Previously this fetch() had no timeout and would hang until
  // Node's default TCP timeout (~2 min), making every login appear to
  // "time out" even though the real failure was upstream.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    // Use token introspection endpoint (RFC 7662)
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const response = await fetch(INTROSPECTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: new URLSearchParams({ token }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // 401 here is NEVER about the user's token — it means the auth-server
      // rejected OUR Basic credentials (invalid_client). That's the
      // rotated-but-unsynced secret failure mode: every .online login fails
      // fleet-wide while the deploy looks green. Log loudly (ops signal) and
      // return a user-facing message that doesn't leak internals.
      if (response.status === 401) {
        // eslint-disable-next-line no-console
        console.error(
          '[oauthValidator] CLIENT AUTH FAILED (401 invalid_client): the auth-server rejected ' +
            `client_id='${CLIENT_ID}' — OAUTH_CLIENT_SECRET no longer matches the auth-server's ` +
            'registered secret. ALL .online OAuth logins are failing. ' +
            'Fix: sync Railway OAUTH_CLIENT_SECRET with GCP secret poker-prod-poker-server-client-secret ' +
            '(see rotate-poker-server-secret.sh at workspace root).'
        );
        return {
          valid: false,
          error: 'Sign-in is temporarily unavailable — please try again in a few minutes',
          status: 401,
          clientAuthFailed: true,
        };
      }
      return { valid: false, error: `Introspection failed (${response.status})`, status: response.status };
    }

    const data: any = await response.json();

    if (!data.active) {
      return { valid: false, error: 'Token is not active' };
    }

    return {
      valid: true,
      sub: data.sub,
      username: data.username || data.preferred_username,
      phone: data.phone || data.phone_number,
      isAdmin: data.is_admin === true,
    };
  } catch (err: any) {
    // Not an OAuth token or introspection unreachable — return invalid.
    // AbortError from the 5s timeout surfaces here as a generic failure.
    const isTimeout = err?.name === 'AbortError';
    return {
      valid: false,
      error: isTimeout ? 'Auth server timed out' : (err.message || 'Token validation failed'),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================
// 2026-07-06 P1 — Credential pre-flight (secret single-sourcing).
//
// The ONLY trustworthy way to know our OAUTH_CLIENT_SECRET matches the
// auth-server's registered value is a live introspection round-trip: with
// CORRECT credentials the auth-server answers 200 {active:false} even for a
// garbage token; with WRONG credentials it answers 401 invalid_client. No
// offline comparison exists (the auth-server side lives in GCP Secret
// Manager, this side on Railway — neither is readable from the other).
//
// Called from the httpServer.listen callback at boot and re-checked on an
// interval, so a rotated-but-unsynced secret is detected within minutes of a
// deploy instead of by users failing to sign in. NEVER throws, NEVER fatal —
// a broken credential must not crash-loop the process (tables keep serving
// rehydrated hands; only NEW OAuth logins are broken while it's red).
// ============================================================

export type PreflightStatus = 'ok' | 'invalid_client' | 'unreachable' | 'unchecked' | `http_${number}`;

let lastPreflight: { status: PreflightStatus; at: string | null } = { status: 'unchecked', at: null };

/** Last preflight result — surfaced on /api/health as `authClient` so the
 *  credential state is verifiable externally (curl) without Railway CLI access. */
export function getPreflightStatus(): { status: PreflightStatus; at: string | null } {
  return lastPreflight;
}

export async function preflightIntrospection(): Promise<{ ok: boolean; status: PreflightStatus }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  let status: PreflightStatus;
  try {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const response = await fetch(INTROSPECTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
        // Marks the probe in auth-server logs; carries no auth meaning.
        'User-Agent': 'poker-server-preflight/1',
      },
      body: new URLSearchParams({ token: 'preflight-credential-check' }),
      signal: controller.signal,
    });
    if (response.ok) status = 'ok';
    else if (response.status === 401) status = 'invalid_client';
    else status = `http_${response.status}` as PreflightStatus;
  } catch {
    status = 'unreachable';
  } finally {
    clearTimeout(timeoutId);
  }
  lastPreflight = { status, at: new Date().toISOString() };
  return { ok: status === 'ok', status };
}
