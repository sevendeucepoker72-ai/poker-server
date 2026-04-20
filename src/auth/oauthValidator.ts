const AUTH_SERVER_URL = process.env.AUTH_SERVER_URL || 'https://auth.americanpubpoker.online';
const INTROSPECTION_URL = `${AUTH_SERVER_URL}/token/introspection`;
const CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'poker-server';
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
    // Not an OAuth token or introspection unreachable — return invalid
    return {
      valid: false,
      error: err.message || 'Token validation failed',
    };
  }
}
