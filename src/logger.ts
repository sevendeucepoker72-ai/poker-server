/**
 * Structured logger (pino).
 *
 * Hot-path code (broadcastGameState, action handlers, AI scheduler) should
 * use `log.*` instead of `console.*` so production logs are JSON-parseable,
 * level-filterable, and searchable by tableId / handNumber / userId.
 *
 * Existing `console.log` calls are NOT broken — they still go to stdout.
 * Migrate a file at a time; there is no big-bang cutover.
 *
 * Usage:
 *   import { log, tableLog } from '../logger';
 *   log.info({ tableId }, 'table created');
 *   const l = tableLog(tableId);
 *   l.warn({ handNumber, seat }, 'wedge detected');
 */
import pino from 'pino';

const level =
  process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// In production (Railway, Docker) emit JSON. In local dev make it human-
// readable. `pino-pretty` is a devDependency — if it's not installed, fall
// back to raw JSON rather than crashing.
let transport: pino.TransportSingleOptions | undefined;
if (process.env.NODE_ENV !== 'production') {
  try {
    require.resolve('pino-pretty');
    transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
    };
  } catch {
    transport = undefined;
  }
}

export const log = pino({
  level,
  base: { svc: 'poker-server' },
  redact: {
    paths: ['password', '*.password', 'token', '*.token', 'authorization'],
    censor: '[REDACTED]',
  },
  ...(transport ? { transport } : {}),
});

export function tableLog(tableId: string) {
  return log.child({ tableId });
}

export function handLog(tableId: string, handNumber: number) {
  return log.child({ tableId, handNumber });
}

export function userLog(userId: string) {
  return log.child({ userId });
}
