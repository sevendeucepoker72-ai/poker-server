/**
 * 2026-10-11 — crash safety for socket listeners (R1 contract #6; audit AUTH-2,
 * OPS-1, CLUBS-3).
 *
 * WHY. socket.io calls a listener synchronously from the transport's message
 * handler and IGNORES what it returns. So:
 *   - a listener that THROWS synchronously (`data.tableId` on a frame sent with
 *     no payload, e.g. `42["action"]`) throws out of the websocket 'message'
 *     handler: an uncaught exception, and the process EXITS;
 *   - an async listener that REJECTS is an unhandled rejection, which (Node >= 15
 *     default, no process-level handler) also EXITS the process.
 * One crafted frame from ANY socket — no sign-in needed — dropped every table on
 * the server (reproduced with `checkUsername` and no payload), and Railway's
 * ON_FAILURE restart budget (3) made the fourth crash final.
 *
 * WHAT. `installSocketListenerGuard(socket)` replaces `socket.on` (and its
 * aliases) on that socket INSTANCE before any handler is registered, so EVERY
 * listener registered on it afterwards runs inside `guardSocketListener`:
 *   1. Payload guard. A listener that DECLARES a payload parameter
 *      (`listener.length >= 1`) runs only when its first argument is a plain
 *      object; anything else — missing, null, a string / number / boolean, an
 *      array, an ack function in the payload slot — is refused BEFORE the body
 *      runs (`[socket-payload-rejected]`, an ack — if any — gets
 *      { success:false, error:'invalid_payload' }, nothing else is emitted).
 *      Listeners with no required parameter — `() => …`, `(data = {}) => …`,
 *      `(...args) => …` (they parse their own arguments) — legitimately take no
 *      payload and are never checked; nor are socket.io's reserved events
 *      (`disconnect` receives a reason STRING). Every payload-taking handler
 *      poker-3d emits is sent an object (audited 2026-10-11).
 *   2. Error guard. A synchronous throw and a rejection of the returned promise
 *      are caught: ONE structured `[socket-handler-error]` line with the event
 *      name (never the payload — it can carry tokens); if the LAST argument is
 *      an ack function it is called with { success:false, error:'server_error' }
 *      (socket.io ignores a second call of an ack, so a handler that already
 *      answered is unaffected). Nothing else is emitted.
 * Work a listener starts but does not RETURN (a fire-and-forget IIFE) is still
 * covered by the process-level unhandledRejection logger (processGuards.ts):
 * logged, never fatal. Listener bodies that wrap themselves in an IIFE return it
 * so their errors land here, with the event name.
 */

export const SOCKET_HANDLER_ERROR_TAG = '[socket-handler-error]';
export const SOCKET_PAYLOAD_REJECTED_TAG = '[socket-payload-rejected]';

/** socket.io / EventEmitter reserved events: never payload-checked. */
export const SOCKET_RESERVED_EVENTS: ReadonlySet<string> = new Set([
  'disconnect', 'disconnecting', 'error', 'newListener', 'removeListener',
]);

/** /api/health → crashSafety.socketListeners. Counts only. */
export const socketGuardStats = {
  socketsGuarded: 0,
  listenersWrapped: 0,
  handlerErrors: 0,
  syncThrows: 0,
  asyncRejections: 0,
  payloadsRejected: 0,
  acksAnswered: 0,
  logLinesSuppressed: 0,
  lastErrorEvent: null as string | null,
  lastErrorAt: null as string | null,
};

export type SocketListener = (...args: any[]) => unknown;

export interface SocketGuardOptions {
  /** Where the structured lines go (default console.error). */
  log?: (line: string) => void;
  /** Extra reporting for a caught handler error (e.g. Sentry). Must not throw. */
  onHandlerError?: (event: string, err: unknown) => void;
  /** The socket's id, for the log line (an opaque id, not personal data). */
  socketId?: string;
  /** Clock (tests). */
  now?: () => number;
}

/** A plain object payload: not null, not an array, not a function. */
export function isPlainPayload(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function payloadKind(v: unknown): string {
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function errorText(err: unknown): string {
  const e = err as { message?: unknown } | null;
  const msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(err);
  return msg.slice(0, 200);
}

/** The first stack frame below the message — where it threw (no payload data). */
function errorWhere(err: unknown): string | null {
  const stack = (err as { stack?: unknown } | null)?.stack;
  if (typeof stack !== 'string') return null;
  const frame = stack.split('\n').slice(1).find((l) => l.trim().startsWith('at '));
  return frame ? frame.trim().slice(0, 160) : null;
}

// One shared, bounded log budget: a client looping a bad frame must not be able
// to flood the log. The first line of the next window reports what was dropped.
const LOG_WINDOW_MS = 60_000;
const LOG_MAX_LINES_PER_WINDOW = 60;
let logWindowStart = 0;
let logLinesInWindow = 0;
let logSuppressedInWindow = 0;

function emitLogLine(line: string, opts: SocketGuardOptions): void {
  const now = (opts.now || Date.now)();
  if (now - logWindowStart >= LOG_WINDOW_MS) {
    const dropped = logSuppressedInWindow;
    logWindowStart = now;
    logLinesInWindow = 0;
    logSuppressedInWindow = 0;
    if (dropped > 0) {
      try { (opts.log || console.error)(`${SOCKET_HANDLER_ERROR_TAG} ${JSON.stringify({ event: '*', suppressedLines: dropped })}`); } catch { /* logging never throws out */ }
    }
  }
  if (logLinesInWindow >= LOG_MAX_LINES_PER_WINDOW) {
    logSuppressedInWindow++;
    socketGuardStats.logLinesSuppressed++;
    return;
  }
  logLinesInWindow++;
  try { (opts.log || console.error)(line); } catch { /* logging never throws out */ }
}

function answerAck(ack: ((...a: unknown[]) => unknown) | null, body: Record<string, unknown>): void {
  if (!ack) return;
  try {
    ack(body);
    socketGuardStats.acksAnswered++;
  } catch { /* an ack that throws must not become a second crash */ }
}

function reportHandlerError(
  event: string, err: unknown, kind: 'sync' | 'async',
  ack: ((...a: unknown[]) => unknown) | null, opts: SocketGuardOptions,
): void {
  socketGuardStats.handlerErrors++;
  if (kind === 'sync') socketGuardStats.syncThrows++; else socketGuardStats.asyncRejections++;
  socketGuardStats.lastErrorEvent = event;
  socketGuardStats.lastErrorAt = new Date((opts.now || Date.now)()).toISOString();
  emitLogLine(`${SOCKET_HANDLER_ERROR_TAG} ${JSON.stringify({
    event, kind, socketId: opts.socketId ?? null, error: errorText(err), where: errorWhere(err),
  })}`, opts);
  try { opts.onHandlerError?.(event, err); } catch { /* reporting never throws out */ }
  answerAck(ack, { success: false, error: 'server_error' });
}

/**
 * Wrap one listener (see the module comment). The wrapper keeps `this` and
 * returns whatever the listener returned (socket.io ignores it).
 */
export function guardSocketListener(event: string, listener: SocketListener, opts: SocketGuardOptions = {}): SocketListener {
  const takesPayload = listener.length >= 1 && !SOCKET_RESERVED_EVENTS.has(event);
  socketGuardStats.listenersWrapped++;
  return function guardedSocketListener(this: unknown, ...args: unknown[]): unknown {
    const last = args.length > 0 ? args[args.length - 1] : undefined;
    const ack = typeof last === 'function' ? (last as (...a: unknown[]) => unknown) : null;
    if (takesPayload && !isPlainPayload(args[0])) {
      socketGuardStats.payloadsRejected++;
      emitLogLine(`${SOCKET_PAYLOAD_REJECTED_TAG} ${JSON.stringify({
        event, payload: payloadKind(args[0]), socketId: opts.socketId ?? null,
      })}`, opts);
      answerAck(ack, { success: false, error: 'invalid_payload' });
      return undefined;
    }
    let out: unknown;
    try {
      out = listener.apply(this, args);
    } catch (err) {
      reportHandlerError(event, err, 'sync', ack, opts);
      return undefined;
    }
    if (out !== null && (typeof out === 'object' || typeof out === 'function')
        && typeof (out as { then?: unknown }).then === 'function') {
      Promise.resolve(out as PromiseLike<unknown>).then(undefined, (err) => reportHandlerError(event, err, 'async', ack, opts));
    }
    return out;
  };
}

const GUARD_INSTALLED = Symbol.for('poker-server.socketListenerGuard');
// `once` / `prependOnceListener` are not overridden: Node implements them through
// `this.on` / `this.prependListener`, so they are error-guarded already (their
// one-shot wrapper declares no parameter, so not payload-checked), and wrapping
// them too would wrap twice. index.ts registers socket listeners with `on`.
const REGISTRATION_METHODS = ['on', 'addListener', 'prependListener'] as const;

/**
 * Make every listener registered on `socket` from now on a guarded one. Call it
 * FIRST in the connection handler, before any `socket.on(...)`. Idempotent.
 */
export function installSocketListenerGuard(socket: object & { id?: string }, opts: SocketGuardOptions = {}): void {
  const s = socket as Record<string | symbol, any>;
  if (s[GUARD_INSTALLED]) return;
  const guardOpts: SocketGuardOptions = { ...opts, socketId: opts.socketId ?? socket.id };
  for (const method of REGISTRATION_METHODS) {
    const original = s[method];
    if (typeof original !== 'function') continue;
    const guardedRegistration = function (this: unknown, event: unknown, listener: unknown, ...rest: unknown[]) {
      const wrapped = typeof listener === 'function'
        ? guardSocketListener(String(event), listener as SocketListener, guardOpts)
        : listener;
      return original.call(this, event, wrapped, ...rest);
    };
    Object.defineProperty(s, method, { value: guardedRegistration, configurable: true, writable: true, enumerable: false });
  }
  Object.defineProperty(s, GUARD_INSTALLED, { value: true, configurable: true, enumerable: false });
  socketGuardStats.socketsGuarded++;
}

/** Test hook: reset the shared log budget. */
export function _resetSocketGuardLogBudgetForTests(): void {
  logWindowStart = 0;
  logLinesInWindow = 0;
  logSuppressedInWindow = 0;
}
