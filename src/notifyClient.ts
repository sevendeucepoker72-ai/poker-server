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
//
// 2026-10-28 (error sweep: .online pushes never delivered) — the recipient is
// the MASTER account id (the master API's users.id, a uuid), never
// poker-server's LOCAL integer users.id. The blind_level_up hook sent the
// local id: the master answered 202, then its dispatcher died on 'invalid
// input syntax for type uuid' (477 in a week, 397 on the 10-25 qualifier) and
// nothing was delivered. Callers resolve the master id (index.ts
// masterUserIdForSeat / notifyTournamentStart); this module also refuses,
// without a request, anything Postgres would not read as a uuid (one debug
// line), and the master now answers such a value 400 invalid_user_id — that
// 400 is taken quietly (counted + one debug line, never retried, never thrown).

import { log } from './logger';

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

/**
 * 2026-10-28 — every spelling Postgres accepts for a uuid (the master API's
 * utils/uuid.js PG_UUID_RE, the one its /internal/notify checks): 32 hex
 * digits, any case, at most one '-' after any group of 4, optionally in ONE
 * '{...}' pair. A local integer id (or its string) never matches.
 */
const PG_UUID_RE = /^(?:\{[0-9a-fA-F]{4}(?:-?[0-9a-fA-F]{4}){7}\}|[0-9a-fA-F]{4}(?:-?[0-9a-fA-F]{4}){7})$/;

/** true when the master would take `id` as a users.id (a uuid). */
export function isMasterUserId(id: unknown): id is string {
  return typeof id === 'string' && PG_UUID_RE.test(id);
}

/**
 * 2026-10-28 — what happened to the pushes (counts only, no ids):
 * posted = requests sent; accepted = 2xx; skippedNotMasterId = refused here
 * (not a uuid, nothing sent); rejected = the master's 400 (invalid_user_id or
 * a missing field); failed = any other non-2xx or a network error.
 */
const notifyStats = { posted: 0, accepted: 0, skippedNotMasterId: 0, rejected: 0, failed: 0 };
export function notifyClientStats(): typeof notifyStats {
  return { ...notifyStats };
}

export async function notifyPlayer(
  masterUserId: string,
  eventType: string,
  title: string,
  body: string,
  opts?: NotifyOptions
): Promise<void> {
  if (!masterUserId || !TOKEN) return; // silent no-op when not configured
  if (!isMasterUserId(masterUserId)) {
    notifyStats.skippedNotMasterId++;
    log.debug(`[notifyPlayer] ${JSON.stringify({
      event: 'notify_skipped_not_master_id', eventType,
      userIdType: typeof masterUserId, userIdLength: String(masterUserId).length,
    })}`);
    return;
  }
  try {
    notifyStats.posted++;
    const res = await fetch(`${POKER_API_URL}/internal/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': TOKEN,
      },
      body: JSON.stringify({ userId: masterUserId, eventType, title, body, ...(opts || {}) }),
    });
    if (res.ok) {
      notifyStats.accepted++;
    } else if (res.status === 400) {
      // The master refused the request itself (invalid_user_id, a missing
      // field): resending the same body can never succeed. Quiet — no retry.
      notifyStats.rejected++;
      log.debug(`[notifyPlayer] ${JSON.stringify({ event: 'notify_rejected_400', eventType })}`);
    } else {
      notifyStats.failed++;
    }
  } catch (e) {
    notifyStats.failed++;
    console.warn('[notifyPlayer] failed', {
      userId: masterUserId,
      eventType,
      err: (e as Error)?.message,
    });
  }
}
