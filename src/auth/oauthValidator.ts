const AUTH_SERVER_URL = process.env.AUTH_SERVER_URL || 'https://auth.americanpubpoker.online';
const INTROSPECTION_URL = `${AUTH_SERVER_URL}/token/introspection`;
const CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'poker-server';

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
