/**
 * Test helper (2026-10-10): run REAL src/index.ts source text in a unit test.
 *
 * index.ts boots the whole server on import, so tests slice the functions /
 * socket handlers they exercise out of the source and transpile them with the
 * repo's TypeScript (the same approach as absentSeat.test.ts and
 * logoutSeatTeardown.test.ts). Those harnesses list every global by hand; a
 * buy-in handler touches dozens of module-level helpers on paths a test does
 * not care about, so `load` resolves an identifier the slice does not declare
 * in this order:
 *   1. the test's `scope` (the fakes the test asserts on),
 *   2. a real JS global (Promise, Map, JSON, Date, setTimeout, …),
 *   3. an inert stub — callable, returns undefined, every property another
 *      stub. Each stubbed name is recorded in `stubbed` so a test can assert
 *      that nothing it relies on was silently stubbed.
 */
import fs from 'fs';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ts = require('typescript');

export const SRC: string = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8');

export function slice(startNeedle: string, endNeedle: string, from = 0): string {
  const at = SRC.indexOf(startNeedle, from);
  if (at < 0) throw new Error(`not found in src/index.ts: ${startNeedle}`);
  const end = SRC.indexOf(endNeedle, at);
  if (end < 0) throw new Error(`no end for: ${startNeedle}`);
  return SRC.slice(at, end + endNeedle.length);
}

/** A top-level function, through its closing `}` line. */
export const fnSrc = (signature: string): string => slice(signature, '\n}\n');

/**
 * .online R2 (2026-10-11) — the ONE seat-teardown helper block of index.ts
 * (teardownSeat + its counters, aiSeatTakeableNow, takeAiSeatForJoin,
 * stripBotsWhenNoHumans / stripBotsAfterHandIfMarked), aiSeatsMutableNow (the
 * strip's between-hands test) and endCashReservation (every reservation
 * ending). Every leave / departure / ghost-cleanup / refused-restore /
 * reservation path calls them, so a harness slicing one of those paths
 * appends this. Scope it reads: pendingSeatRemovalAfterHand, sitOutTracker,
 * creditSeatStackToWallet, scheduleAIAction, syncSitOutToTable, aiProfiles,
 * aiTimeouts, pendingAutoStartTimers, tableManager, reservedSeats helpers.
 */
export const SEAT_TEARDOWN_SRC: string = [
  slice('// ========== Seat teardown — ONE helper', 'if (table) stripBotsWhenNoHumans(tableId, table);\n}\n'),
  fnSrc('function aiSeatsMutableNow('),
  fnSrc('function endCashReservation('),
].join('\n');

/** The `socket.on('<event>', …)` registration (either layout), through `endNeedle`. */
export function handlerSrc(event: string, endNeedle: string): string {
  let at = SRC.indexOf(`socket.on('${event}'`);
  if (at < 0) at = SRC.indexOf(`socket.on(\n    '${event}',`);
  if (at < 0) throw new Error(`handler for '${event}' not found in src/index.ts`);
  const end = SRC.indexOf(endNeedle, at);
  if (end < 0) throw new Error(`no end for handler '${event}'`);
  return SRC.slice(at, end + endNeedle.length);
}

const JS_GLOBALS = new Set(Object.getOwnPropertyNames(globalThis));
const NEVER_SCOPED = new Set(['module', 'exports', 'require']);

function inertStub(name: string, used: Set<string>): any {
  used.add(name);
  return new Proxy(function stub() { /* inert */ }, {
    get: (_t, p) => (p === 'then' || typeof p === 'symbol' ? undefined : inertStub(`${name}.${String(p)}`, used)),
    apply: () => undefined,
  });
}

export interface Loaded {
  exports: any;
  /** Names (and member paths) that resolved to an inert stub. */
  stubbed: Set<string>;
}

export function load(code: string, scope: Record<string, unknown>, exportsExpr: string): Loaded {
  const js: string = ts.transpileModule(`${code}\nmodule.exports = ${exportsExpr};\n`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText.replace(/^"use strict";\s*/m, '');
  const stubbed = new Set<string>();
  const env = new Proxy(scope, {
    has: (t, k) => typeof k === 'string' && !k.startsWith('__') && !NEVER_SCOPED.has(k) && (k in t || !JS_GLOBALS.has(k)),
    get: (t, k) => {
      if (typeof k !== 'string') return undefined;
      if (k in t) return (t as any)[k];
      return inertStub(k, stubbed);
    },
    set: (t, k, v) => { (t as any)[k] = v; return true; },
  });
  const mod: { exports: any } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('__env', 'module', 'exports', 'require', `with (__env) {\n${js}\n}`)(env, mod, mod.exports, require);
  return { exports: mod.exports, stubbed };
}

/** Let every pending promise continuation run. */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

export function deferred(): { p: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const p = new Promise<void>((r) => { resolve = r; });
  return { p, resolve };
}
