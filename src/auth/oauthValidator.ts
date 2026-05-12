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
      return { valid: false, error: `Introspection failed (${response.status})` };
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
