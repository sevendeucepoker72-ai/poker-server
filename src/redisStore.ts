/**
 * Hand-state checkpoint to Redis.
 *
 * Writes a compact JSON snapshot of every in-progress hand, keyed by
 * table id. On server restart we scan `hand:*` and rehydrate tables so
 * gameplay continues across Railway deploys. If Redis is unavailable
 * (REDIS_URL not set, or connection fails) this module degrades to
 * no-op — everything still works, just without checkpoint survival.
 *
 * TTL on each key is 2h so abandoned snapshots expire. A successfully
 * completed hand deletes its key explicitly.
 *
 * Writes are debounced per-table (default 100ms) so a burst of state
 * changes during a single action doesn't hammer Redis.
 */
import { createClient, RedisClientType } from 'redis';

const KEY_PREFIX = 'hand:';
const KEY_TTL_SECONDS = 60 * 60 * 2; // 2 hours
const DEFAULT_DEBOUNCE_MS = 100;

// Provably-fair revealed-commitment buffer keys: one LIST per table,
// newest-first (LPUSH + LTRIM 0 49), capped at 50 entries to match the
// in-process FAIRNESS_BUFFER_SIZE. 7-day TTL — older verifications
// aren't useful to clients and we don't want unbounded growth.
const FAIRNESS_KEY_PREFIX = 'poker:fairness:';
const FAIRNESS_KEY_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const FAIRNESS_LIST_CAP = 50;

let client: RedisClientType | null = null;
let ready = false;
let connectAttempted = false;

const pendingTimers = new Map<string, NodeJS.Timeout>();
const pendingValues = new Map<string, string>();

export function isRedisReady(): boolean {
  return ready && !!client;
}

/**
 * Ping Redis (returns 'PONG' on success). Used by /api/health to detect a
 * dead/disconnected Redis even when our `ready` flag hasn't been flipped yet.
 * Resolves to 'SKIP' when Redis is not configured (so health checks don't
 * fail on local dev / instances without REDIS_URL set).
 */
export async function pingRedis(): Promise<string> {
  if (!isRedisReady() || !client) return 'SKIP';
  return await client.ping();
}

/**
 * Connect to Redis if REDIS_URL is set. Safe to call multiple times —
 * only connects once. Returns true if connection succeeds, false on
 * any failure (including missing URL).
 */
export async function connectRedis(): Promise<boolean> {
  if (connectAttempted) return ready;
  connectAttempted = true;

  if (!process.env.REDIS_URL) {
    // 2026-06-10 audit: elevated from console.log to console.warn so this
    // is visible in Railway's log filter. Without REDIS_URL, in-progress
    // hands are LOST on every redeploy (rehydration becomes a no-op) — an
    // operator who forgets to set it on a fresh service only finds out
    // when a player reports a vanished hand. A warn-level line surfaces it
    // at deploy time instead.
    console.warn('[redisStore] ⚠️  REDIS_URL not set — hand-state persistence DISABLED. In-progress hands will NOT survive a redeploy. Set REDIS_URL on Railway.');
    return false;
  }

  try {
    client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (err) => {
      console.warn('[redisStore] Redis client error:', err?.message);
      ready = false;
    });
    client.on('ready', () => {
      ready = true;
      console.log('[redisStore] ready');
    });
    await client.connect();
    return true;
  } catch (err) {
    console.warn('[redisStore] Connect failed:', (err as Error)?.message);
    client = null;
    ready = false;
    return false;
  }
}

/**
 * Debounced write. Repeated calls within the debounce window only
 * push the LAST value.
 */
export function snapshotHand(tableId: string, state: unknown, debounceMs: number = DEFAULT_DEBOUNCE_MS): void {
  if (!isRedisReady()) return;
  try {
    const json = JSON.stringify(state);
    pendingValues.set(tableId, json);

    if (pendingTimers.has(tableId)) return; // timer already scheduled
    const timer = setTimeout(async () => {
      pendingTimers.delete(tableId);
      const latest = pendingValues.get(tableId);
      pendingValues.delete(tableId);
      if (latest == null) return;
      try {
        if (client && ready) {
          await client.set(KEY_PREFIX + tableId, latest, { EX: KEY_TTL_SECONDS });
        }
      } catch (err) {
        console.warn(`[redisStore] snapshot set failed for ${tableId}:`, (err as Error)?.message);
      }
    }, debounceMs);
    pendingTimers.set(tableId, timer);
  } catch (err) {
    console.warn('[redisStore] snapshotHand serialize failed:', (err as Error)?.message);
  }
}

/** Synchronous write that flushes any pending debounced snapshot first. */
export async function flushHand(tableId: string): Promise<void> {
  const timer = pendingTimers.get(tableId);
  if (timer) clearTimeout(timer);
  pendingTimers.delete(tableId);
  const latest = pendingValues.get(tableId);
  pendingValues.delete(tableId);
  if (!latest || !isRedisReady() || !client) return;
  try {
    await client.set(KEY_PREFIX + tableId, latest, { EX: KEY_TTL_SECONDS });
  } catch (err) {
    console.warn(`[redisStore] flushHand failed for ${tableId}:`, (err as Error)?.message);
  }
}

/** Delete a hand snapshot (called when a hand completes cleanly). */
export async function clearHand(tableId: string): Promise<void> {
  const timer = pendingTimers.get(tableId);
  if (timer) clearTimeout(timer);
  pendingTimers.delete(tableId);
  pendingValues.delete(tableId);
  if (!isRedisReady() || !client) return;
  try {
    await client.del(KEY_PREFIX + tableId);
  } catch (err) {
    console.warn(`[redisStore] clearHand failed for ${tableId}:`, (err as Error)?.message);
  }
}

/**
 * Scan all hand:* keys and return [tableId, parsedState] pairs.
 * Called on startup to rehydrate in-progress hands.
 */
export async function scanHands(): Promise<Array<{ tableId: string; state: unknown }>> {
  if (!isRedisReady() || !client) return [];
  const results: Array<{ tableId: string; state: unknown }> = [];
  try {
    for await (const key of client.scanIterator({ MATCH: KEY_PREFIX + '*', COUNT: 100 })) {
      // Node Redis v5 scanIterator can yield either a single string or
      // an array of strings depending on version — handle both.
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) {
        const tableId = (k as string).slice(KEY_PREFIX.length);
        try {
          const raw = await client.get(k as string);
          if (!raw) continue;
          const state = JSON.parse(raw);
          results.push({ tableId, state });
        } catch (err) {
          console.warn(`[redisStore] skip corrupt snapshot ${k}:`, (err as Error)?.message);
        }
      }
    }
  } catch (err) {
    console.warn('[redisStore] scanHands failed:', (err as Error)?.message);
  }
  return results;
}

/** Flush all pending writes (for graceful shutdown). */
export async function flushAll(): Promise<void> {
  const tableIds = Array.from(pendingTimers.keys());
  await Promise.all(tableIds.map((id) => flushHand(id)));
}

// ===== Provably-fair revealed-commitment buffer =====
//
// The in-process `revealedCommitmentsByTable` Map in index.ts is the
// authoritative read source for /api/fairness/*. These helpers mirror
// it to Redis so a Railway restart doesn't erase the last 50 revealed
// commitments per table. On Redis-less instances they no-op (matching
// the rest of this module).

export interface RevealedFairnessEntry {
  handNumber: number;
  seed: string;
  hash: string;
  revealedAt: number;
}

let fairnessRedisWarned = false;
function warnFairnessUnavailableOnce(reason: string): void {
  if (fairnessRedisWarned) return;
  fairnessRedisWarned = true;
  console.warn(`[redisStore] fairness buffer persistence disabled (${reason}) — in-process only, will be lost on restart`);
}

/**
 * Append a revealed commitment to the persistent rolling list for the
 * given table. Newest-first (LPUSH), capped at FAIRNESS_LIST_CAP via
 * LTRIM, with a 7-day TTL. Safe to call on Redis-less instances —
 * degrades to a one-time warning.
 */
export async function appendFairnessCommitment(tableId: string, entry: RevealedFairnessEntry): Promise<void> {
  if (!isRedisReady() || !client) {
    warnFairnessUnavailableOnce(process.env.REDIS_URL ? 'redis not ready' : 'no REDIS_URL');
    return;
  }
  try {
    const key = FAIRNESS_KEY_PREFIX + tableId;
    const json = JSON.stringify(entry);
    // Pipeline so all three commands ship in one round-trip and the
    // cap+TTL are guaranteed to apply alongside the push.
    const multi = client.multi();
    multi.lPush(key, json);
    multi.lTrim(key, 0, FAIRNESS_LIST_CAP - 1);
    multi.expire(key, FAIRNESS_KEY_TTL_SECONDS);
    await multi.exec();
  } catch (err) {
    console.warn(`[redisStore] appendFairnessCommitment failed for ${tableId}:`, (err as Error)?.message);
  }
}

/**
 * Load the persisted fairness buffer for one table. Returns newest-first
 * (matching the in-process Map shape) so callers can assign the result
 * directly. Empty array if Redis is down or the key doesn't exist.
 */
export async function loadFairnessBuffer(tableId: string): Promise<RevealedFairnessEntry[]> {
  if (!isRedisReady() || !client) return [];
  try {
    const raw = await client.lRange(FAIRNESS_KEY_PREFIX + tableId, 0, FAIRNESS_LIST_CAP - 1);
    const out: RevealedFairnessEntry[] = [];
    for (const item of raw) {
      try {
        const parsed = JSON.parse(item);
        if (parsed && typeof parsed.handNumber === 'number' && typeof parsed.seed === 'string' && typeof parsed.hash === 'string') {
          out.push(parsed as RevealedFairnessEntry);
        }
      } catch {
        // skip corrupt entry
      }
    }
    return out;
  } catch (err) {
    console.warn(`[redisStore] loadFairnessBuffer failed for ${tableId}:`, (err as Error)?.message);
    return [];
  }
}

/**
 * Scan every poker:fairness:* key and return per-table buffers.
 * Called on startup after connectRedis() to rehydrate the in-process
 * `revealedCommitmentsByTable` Map.
 */
export async function scanFairnessBuffers(): Promise<Array<{ tableId: string; entries: RevealedFairnessEntry[] }>> {
  if (!isRedisReady() || !client) return [];
  const results: Array<{ tableId: string; entries: RevealedFairnessEntry[] }> = [];
  try {
    for await (const key of client.scanIterator({ MATCH: FAIRNESS_KEY_PREFIX + '*', COUNT: 100 })) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) {
        const tableId = (k as string).slice(FAIRNESS_KEY_PREFIX.length);
        const entries = await loadFairnessBuffer(tableId);
        if (entries.length > 0) results.push({ tableId, entries });
      }
    }
  } catch (err) {
    console.warn('[redisStore] scanFairnessBuffers failed:', (err as Error)?.message);
  }
  return results;
}
