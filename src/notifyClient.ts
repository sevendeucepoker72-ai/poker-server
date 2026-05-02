// Lightweight HTTP client for fire-and-forget push notifications.
//
// Posts to the poker-api `/internal/notify` endpoint, which handles tag
// resolution + dispatch. Auth is via the shared `X-Internal-Token` header
// (env: INTERNAL_NOTIFY_TOKEN). When the token is missing this module is a
// silent no-op so local dev / unconfigured environments don't spam errors.
//
// IMPORTANT: callers MUST NOT `await` notifyPlayer() in any hot path
// (turn-timer setup, broadcast loop, action handler). Just call it and
// discard the returned Promise — the server's deferred fetch is already
// fire-and-forget on the API side (returns 202).

const POKER_API_URL =
  process.env.POKER_API_URL ||
  process.env.MASTER_API_URL ||
  'https://poker-prod-api-azeg4kcklq-uc.a.run.app/poker-api';
const TOKEN = process.env.INTERNAL_NOTIFY_TOKEN || '';

export type NotifyPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface NotifyOptions {
  priority?: NotifyPriority;
  metadata?: Record<string, any>;
}

export async function notifyPlayer(
  userId: string | number,
  eventType: string,
  title: string,
  body: string,
  opts?: NotifyOptions
): Promise<void> {
  if (!userId || !TOKEN) return; // silent no-op when not configured
  try {
    await fetch(`${POKER_API_URL}/internal/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': TOKEN,
      },
      body: JSON.stringify({ userId, eventType, title, body, ...(opts || {}) }),
    });
  } catch (e) {
    console.warn('[notifyPlayer] failed', {
      userId,
      eventType,
      err: (e as Error)?.message,
    });
  }
}
