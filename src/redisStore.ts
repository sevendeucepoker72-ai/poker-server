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

let client: RedisClientType | null = null;
let ready = false;
let connectAttempted = false;

const pendingTimers = new Map<string, NodeJS.Timeout>();
const pendingValues = new Map<string, string>();

export function isRedisReady(): boolean {
  return ready && !!client;
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
    console.log('[redisStore] REDIS_URL not set — hand persistence disabled');
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
