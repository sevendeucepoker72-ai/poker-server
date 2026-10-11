/**
 * 2026-10-11 — process-level crash handlers (R1 contract #6; audit OPS-1,
 * AUTH-2, CLUBS-3).
 *
 * Before this the server registered NO 'unhandledRejection' / 'uncaughtException'
 * listener, so on Node >= 15 ANY stray rejected promise or listener throw exited
 * the process — live on 2026-09-12: the @socket.io/redis-adapter's fire-and-forget
 * publish rejected with ECONNRESET during a Railway Redis redeploy and took the
 * server down. A crash also skipped gracefulShutdown, the only path that credits
 * seated players' stacks back to their wallets.
 *
 *   unhandledRejection → one structured `[process-unhandled-rejection]` line
 *     (+ the capture hook) and KEEP RUNNING. A stray rejection is a bug to fix,
 *     never a reason to drop every table.
 *   uncaughtException → one `[process-uncaught-exception]` line (+ capture), then
 *     the graceful-shutdown flush (`flush` — cash out every seated / reserved
 *     stack, flush progress: the SIGTERM path) with a BOUNDED wait, then exit(1).
 *     Node's guidance is that the process state is unknown after an uncaught
 *     exception, so it restarts — but never before the stacks are credited.
 *     A second exception during the flush is logged; the deadline still exits.
 */

export const UNHANDLED_REJECTION_TAG = '[process-unhandled-rejection]';
export const UNCAUGHT_EXCEPTION_TAG = '[process-uncaught-exception]';
/** Bounded wait for the crash flush (SIGTERM's own budget from Railway is ~30s). */
export const CRASH_FLUSH_TIMEOUT_MS = 20_000;

/** /api/health → crashSafety.process. Counts only. */
export const processCrashStats = {
  installed: false,
  unhandledRejections: 0,
  uncaughtExceptions: 0,
  crashFlushesStarted: 0,
  logLinesSuppressed: 0,
  lastUnhandledRejectionAt: null as string | null,
  lastUncaughtExceptionAt: null as string | null,
};

type ProcessLike = { on(event: string, listener: (...args: any[]) => void): unknown };

export interface ProcessCrashHandlerOptions {
  /** The graceful-shutdown flush (cash-outs + progress). Awaited, bounded. */
  flush: (reason: string) => Promise<unknown> | unknown;
  flushTimeoutMs?: number;
  log?: (line: string) => void;
  /** Extra reporting (e.g. Sentry). Must not throw. */
  capture?: (err: unknown, kind: 'unhandledRejection' | 'uncaughtException') => void;
  /** Exit (tests inject a fake). Default process.exit. */
  exit?: (code: number) => void;
  /** The process to listen on (tests inject an EventEmitter). Default process. */
  proc?: ProcessLike;
  now?: () => number;
}

function describe(err: unknown): { error: string; name: string | null; where: string | null } {
  const e = err as { message?: unknown; name?: unknown; stack?: unknown } | null;
  const message = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(err);
  const stack = e && typeof e === 'object' && typeof e.stack === 'string' ? e.stack : '';
  const frame = stack.split('\n').slice(1).find((l) => l.trim().startsWith('at '));
  return {
    error: message.slice(0, 300),
    name: e && typeof e === 'object' && typeof e.name === 'string' ? e.name : null,
    where: frame ? frame.trim().slice(0, 200) : null,
  };
}

/** Install both handlers once. Returns false if they were already installed. */
export function installProcessCrashHandlers(opts: ProcessCrashHandlerOptions): boolean {
  const proc: ProcessLike = opts.proc || process;
  const marker = proc as unknown as Record<string, unknown>;
  if (marker.__pokerCrashHandlersInstalled) return false;
  marker.__pokerCrashHandlersInstalled = true;

  const log = opts.log || ((line: string) => console.error(line));
  const exit = opts.exit || ((code: number) => process.exit(code));
  const now = opts.now || Date.now;
  const flushTimeoutMs = opts.flushTimeoutMs ?? CRASH_FLUSH_TIMEOUT_MS;

  // A rejection storm must not flood the log: 60 lines a minute, then counted.
  let windowStart = 0;
  let linesInWindow = 0;
  const logLimited = (line: string) => {
    const t = now();
    if (t - windowStart >= 60_000) { windowStart = t; linesInWindow = 0; }
    if (linesInWindow >= 60) { processCrashStats.logLinesSuppressed++; return; }
    linesInWindow++;
    try { log(line); } catch { /* never throw out of a crash handler */ }
  };

  proc.on('unhandledRejection', (reason: unknown) => {
    processCrashStats.unhandledRejections++;
    processCrashStats.lastUnhandledRejectionAt = new Date(now()).toISOString();
    logLimited(`${UNHANDLED_REJECTION_TAG} ${JSON.stringify({ ...describe(reason), keptRunning: true })}`);
    try { opts.capture?.(reason, 'unhandledRejection'); } catch { /* reporting never throws out */ }
  });

  let crashing = false;
  proc.on('uncaughtException', (err: unknown, origin?: unknown) => {
    processCrashStats.uncaughtExceptions++;
    processCrashStats.lastUncaughtExceptionAt = new Date(now()).toISOString();
    try {
      log(`${UNCAUGHT_EXCEPTION_TAG} ${JSON.stringify({
        ...describe(err), origin: typeof origin === 'string' ? origin : null,
        action: crashing ? 'already_flushing' : 'flush_then_exit', flushTimeoutMs,
      })}`);
    } catch { /* never throw out of a crash handler */ }
    try { opts.capture?.(err, 'uncaughtException'); } catch { /* reporting never throws out */ }
    if (crashing) return;
    crashing = true;
    processCrashStats.crashFlushesStarted++;
    let exited = false;
    const finish = (how: string) => {
      if (exited) return;
      exited = true;
      try { log(`${UNCAUGHT_EXCEPTION_TAG} ${JSON.stringify({ action: 'exit', code: 1, flush: how })}`); } catch { /* ignore */ }
      exit(1);
    };
    const deadline = setTimeout(() => finish('timed_out'), flushTimeoutMs);
    Promise.resolve()
      .then(() => opts.flush('uncaughtException'))
      .then(
        () => { clearTimeout(deadline); finish('done'); },
        (e) => {
          clearTimeout(deadline);
          try { log(`${UNCAUGHT_EXCEPTION_TAG} ${JSON.stringify({ action: 'flush_failed', ...describe(e) })}`); } catch { /* ignore */ }
          finish('failed');
        },
      );
  });

  processCrashStats.installed = true;
  return true;
}
