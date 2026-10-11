/**
 * 2026-10-11 — R1 contract #6 (audit AUTH-2 / OPS-1 / CLUBS-3): one bad socket
 * frame must never exit the process.
 *
 *   - src/socketGuard.ts: every listener registered on a guarded socket catches
 *     its own sync throws and promise rejections (`[socket-handler-error]`, an
 *     ack — if any — answered { success:false, error:'server_error' }) and a
 *     payload-taking listener refuses a non-object payload BEFORE its body.
 *   - src/processGuards.ts: unhandledRejection → logged, process keeps running;
 *     uncaughtException → logged, the graceful-shutdown flush runs (bounded),
 *     then exit(1).
 *   - src/index.ts wiring: the guard is installed before any socket.on, the
 *     @socket.io/redis-adapter block is gone, the IIFE-wrapped handlers return
 *     their promise, the crash handler flushes through gracefulShutdown.
 *
 * The integration tests spawn a REAL socket.io server (the repo's socket.io,
 * the transpiled guard modules) in a child process and talk the socket.io wire
 * protocol over a raw websocket (the `ws` package engine.io already ships), so
 * "the process did not exit" is observed, not assumed. A CONTROL runs the same
 * server without the guards and shows the very same frame killing it.
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import {
  guardSocketListener, installSocketListenerGuard, socketGuardStats, isPlainPayload,
  SOCKET_HANDLER_ERROR_TAG, SOCKET_PAYLOAD_REJECTED_TAG, _resetSocketGuardLogBudgetForTests,
} from '../src/socketGuard';
import { installProcessCrashHandlers, UNHANDLED_REJECTION_TAG, UNCAUGHT_EXCEPTION_TAG } from '../src/processGuards';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf8');
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

/** A fake socket: a real EventEmitter (socket.io's Socket is one) with an id. */
function fakeSocket(id = 'S1') {
  const s = new EventEmitter() as EventEmitter & { id: string };
  s.id = id;
  return s;
}

beforeEach(() => _resetSocketGuardLogBudgetForTests());

describe('socketGuard — listener wrapper', () => {
  it('a SYNC throw is caught: logged with the event name (never the payload), the ack answered server_error, nothing rethrown', () => {
    const lines: string[] = [];
    const s = fakeSocket();
    installSocketListenerGuard(s, { log: (l) => lines.push(l) });
    s.on('checkUsername', (data: { username: string }) => { (data as any).nope.deeper = data.username; });
    const acks: unknown[] = [];
    expect(() => s.emit('checkUsername', { username: 'secret-token-123' }, (a: unknown) => acks.push(a))).not.toThrow();
    expect(acks).toEqual([{ success: false, error: 'server_error' }]);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(SOCKET_HANDLER_ERROR_TAG)).toBe(true);
    const rec = JSON.parse(lines[0].slice(SOCKET_HANDLER_ERROR_TAG.length + 1));
    expect(rec).toMatchObject({ event: 'checkUsername', kind: 'sync', socketId: 'S1' });
    expect(lines[0]).not.toContain('secret-token-123');
  });

  it('an ASYNC rejection is caught: logged as async, the ack answered server_error', async () => {
    const lines: string[] = [];
    const s = fakeSocket();
    installSocketListenerGuard(s, { log: (l) => lines.push(l) });
    s.on('getClubInfo', async (data: { clubId: number }) => { await null; throw new Error(`db down ${data.clubId}`); });
    const acks: unknown[] = [];
    s.emit('getClubInfo', { clubId: 7 }, (a: unknown) => acks.push(a));
    await flush();
    expect(acks).toEqual([{ success: false, error: 'server_error' }]);
    expect(JSON.parse(lines[0].slice(SOCKET_HANDLER_ERROR_TAG.length + 1))).toMatchObject({ event: 'getClubInfo', kind: 'async', error: 'db down 7' });
  });

  it('no ack → nothing new is emitted on an error (only the log line)', async () => {
    const lines: string[] = [];
    const s = fakeSocket();
    const emitted: unknown[] = [];
    const origEmit = s.emit.bind(s);
    installSocketListenerGuard(s, { log: (l) => lines.push(l) });
    s.on('action', (data: { tableId: string }) => { throw new Error(`x${data.tableId}`); });
    s.emit = ((ev: string, ...a: unknown[]) => { emitted.push(ev); return origEmit(ev, ...a); }) as any;
    s.emit('action', { tableId: 't' });
    await flush();
    expect(emitted).toEqual(['action']);
    expect(lines).toHaveLength(1);
  });

  it.each([
    ['missing', []],
    ['null', [null]],
    ['a string', ['t1']],
    ['a number', [5]],
    ['an array', [['t1']]],
    ['an ack in the payload slot', [() => undefined]],
  ])('a payload-taking listener given %s is refused BEFORE its body (ack: invalid_payload)', (_label, args) => {
    const lines: string[] = [];
    const s = fakeSocket();
    installSocketListenerGuard(s, { log: (l) => lines.push(l) });
    let ran = false;
    s.on('joinTable', (data: { tableId: string }) => { ran = true; void data.tableId; });
    const acks: unknown[] = [];
    const ack = (a: unknown) => acks.push(a);
    const argv = args.length && typeof args[args.length - 1] === 'function' ? [...args] : [...args, ack];
    const before = socketGuardStats.payloadsRejected;
    s.emit('joinTable', ...argv);
    expect(ran).toBe(false);
    expect(socketGuardStats.payloadsRejected).toBe(before + 1);
    expect(lines[0].startsWith(SOCKET_PAYLOAD_REJECTED_TAG)).toBe(true);
    if (argv[argv.length - 1] === ack) expect(acks).toEqual([{ success: false, error: 'invalid_payload' }]);
  });

  it('listeners that legitimately take no payload run whatever is sent: () => …, (data = {}) => …, (...args) => …, and the reserved disconnect', () => {
    const s = fakeSocket();
    installSocketListenerGuard(s, { log: () => {} });
    const ran: string[] = [];
    s.on('getStakes', () => { ran.push('getStakes'); });
    s.on('rebuy', (data: { amount?: number } = {}) => { ran.push(`rebuy:${data.amount ?? 'none'}`); });
    s.on('returnToTournamentSeat', (...args: unknown[]) => { ran.push(`return:${args.length}`); });
    s.on('disconnect', (reason: string) => { ran.push(`disconnect:${reason}`); });
    s.emit('getStakes', 'garbage');
    s.emit('rebuy');
    s.emit('returnToTournamentSeat', () => undefined);
    s.emit('disconnect', 'transport close');
    expect(ran).toEqual(['getStakes', 'rebuy:none', 'return:1', 'disconnect:transport close']);
  });

  it('a plain-object payload reaches the body unchanged, `this` and the return value are preserved', () => {
    const s = fakeSocket();
    installSocketListenerGuard(s, { log: () => {} });
    let seen: unknown = null;
    let self: unknown = null;
    s.on('chatMessage', function (this: unknown, data: { message: string }) { seen = data; self = this; return 42; });
    const payload = { message: 'gg' };
    s.emit('chatMessage', payload);
    expect(seen).toBe(payload);
    expect(self).toBe(s);
    // A re-dispatch through socket.listeners() (joinClubTable → joinTable) runs the guarded listener.
    expect((s.listeners('chatMessage')[0] as Function)({ message: 'again' })).toBe(42);
    expect(seen).toEqual({ message: 'again' });
  });

  it('addListener / prependListener are guarded too; installing twice wraps once', () => {
    const lines: string[] = [];
    const s = fakeSocket();
    installSocketListenerGuard(s, { log: (l) => lines.push(l) });
    installSocketListenerGuard(s, { log: (l) => lines.push(l) });
    s.addListener('a', (d: { x: number }) => { throw new Error(String(d.x)); });
    s.prependListener('b', (d: { x: number }) => { throw new Error(String(d.x)); });
    expect(() => s.emit('a', { x: 1 })).not.toThrow();
    expect(() => s.emit('b', { x: 2 })).not.toThrow();
    expect(lines).toHaveLength(2);
  });

  it('the shared log budget caps a flood of bad frames (60 lines / minute) and counts the rest', () => {
    const lines: string[] = [];
    let now = 1_000_000;
    const s = fakeSocket();
    installSocketListenerGuard(s, { log: (l) => lines.push(l), now: () => now });
    s.on('spam', (d: { n: number }) => { throw new Error(String(d.n)); });
    const before = socketGuardStats.logLinesSuppressed;
    for (let i = 0; i < 100; i++) s.emit('spam', { n: i });
    expect(lines).toHaveLength(60);
    expect(socketGuardStats.logLinesSuppressed - before).toBe(40);
    now += 60_000;
    s.emit('spam', { n: 101 });
    expect(lines[60]).toContain('"suppressedLines":40');
  });

  it('guardSocketListener alone: isPlainPayload rules', () => {
    expect(isPlainPayload({})).toBe(true);
    expect(isPlainPayload(Object.create(null))).toBe(true);
    for (const v of [undefined, null, 'x', 1, true, [], () => 0]) expect(isPlainPayload(v)).toBe(false);
    const g = guardSocketListener('e', (d: unknown) => d, { log: () => {} });
    expect(g({ a: 1 })).toEqual({ a: 1 });
    expect(g('nope')).toBeUndefined();
  });
});

describe('processGuards — process-level crash handlers', () => {
  function proc() { return new EventEmitter(); }

  it('unhandledRejection: logged, the process keeps running (exit never called)', () => {
    const p = proc();
    const lines: string[] = [];
    const exits: number[] = [];
    expect(installProcessCrashHandlers({ proc: p, flush: async () => {}, log: (l) => lines.push(l), exit: (c) => exits.push(c) })).toBe(true);
    p.emit('unhandledRejection', new Error('ECONNRESET'));
    expect(exits).toEqual([]);
    expect(lines[0].startsWith(UNHANDLED_REJECTION_TAG)).toBe(true);
    expect(lines[0]).toContain('ECONNRESET');
  });

  it('uncaughtException: the flush runs FIRST, then exit(1)', async () => {
    const p = proc();
    const order: string[] = [];
    installProcessCrashHandlers({
      proc: p, log: () => {}, flushTimeoutMs: 5000,
      flush: async (reason) => { order.push(`flush:${reason}`); await flush(); order.push('flushed'); },
      exit: (c) => order.push(`exit:${c}`),
    });
    p.emit('uncaughtException', new Error('boom'), 'uncaughtException');
    expect(order).toEqual([]);           // nothing synchronous: the flush is awaited
    await flush(); await flush();
    expect(order).toEqual(['flush:uncaughtException', 'flushed', 'exit:1']);
  });

  it('uncaughtException with a flush that never finishes: exit(1) at the deadline; a second exception never starts a second flush', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const p = proc();
      const exits: number[] = [];
      let flushes = 0;
      const lines: string[] = [];
      installProcessCrashHandlers({
        proc: p, log: (l) => lines.push(l), flushTimeoutMs: 20_000,
        flush: () => { flushes++; return new Promise(() => {}); },
        exit: (c) => exits.push(c),
      });
      p.emit('uncaughtException', new Error('one'));
      await flush();
      p.emit('uncaughtException', new Error('two'));
      await flush();
      expect(flushes).toBe(1);
      expect(exits).toEqual([]);
      jest.advanceTimersByTime(19_999);
      expect(exits).toEqual([]);
      jest.advanceTimersByTime(1);
      expect(exits).toEqual([1]);
      expect(lines.some((l) => l.includes('"already_flushing"'))).toBe(true);
      expect(lines.some((l) => l.includes('"timed_out"'))).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a flush that throws still exits(1), logged flush_failed', async () => {
    const p = proc();
    const exits: number[] = [];
    const lines: string[] = [];
    installProcessCrashHandlers({ proc: p, log: (l) => lines.push(l), flush: async () => { throw new Error('db gone'); }, exit: (c) => exits.push(c) });
    p.emit('uncaughtException', new Error('boom'));
    await flush(); await flush();
    expect(exits).toEqual([1]);
    expect(lines.some((l) => l.startsWith(UNCAUGHT_EXCEPTION_TAG) && l.includes('flush_failed'))).toBe(true);
  });

  it('installs once per process object', () => {
    const p = proc();
    expect(installProcessCrashHandlers({ proc: p, flush: () => {}, log: () => {}, exit: () => {} })).toBe(true);
    expect(installProcessCrashHandlers({ proc: p, flush: () => {}, log: () => {}, exit: () => {} })).toBe(false);
    expect(p.listenerCount('uncaughtException')).toBe(1);
    expect(p.listenerCount('unhandledRejection')).toBe(1);
  });
});

describe('index.ts wiring', () => {
  it('the listener guard is installed FIRST in the connection handler, before any socket.on', () => {
    const at = SRC.indexOf("io.on('connection', (socket: Socket) => {");
    expect(at).toBeGreaterThan(-1);
    const install = SRC.indexOf('installSocketListenerGuard(socket, {', at);
    const firstOn = SRC.indexOf('socket.on(', at);
    expect(install).toBeGreaterThan(at);
    expect(install).toBeLessThan(firstOn);
    // Only one connection handler, so every socket listener is guarded.
    expect(SRC.split("io.on('connection'").length - 1).toBe(1);
  });

  it('the @socket.io/redis-adapter block is gone (single replica; its publish rejection crashed the process)', () => {
    expect(SRC).not.toContain("import('@socket.io/redis-adapter')");
    expect(SRC).not.toContain('io.adapter(');
    // The hand-snapshot store is separate and stays.
    expect(SRC).toContain("from './redisStore'");
  });

  it('the process crash handlers are installed and flush through gracefulShutdown with exit code 1', () => {
    expect(SRC).toContain("installProcessCrashHandlers({\n  flush: () => gracefulShutdown('uncaughtException', 1),");
    expect(SRC).toContain('function gracefulShutdown(signal: string, exitCode: number = 0): Promise<void> {');
    expect(SRC).toContain('if (shutdownPromise) return shutdownPromise;');
    expect(SRC).toContain('setTimeout(() => process.exit(shutdownExitCode), 500);');
  });

  it('IIFE-wrapped handlers RETURN their promise (so the guard sees their errors); none discards it', () => {
    expect(SRC).not.toMatch(/=> \{ \(async \(\) => \{/);
    expect(SRC.split('=> { return (async () => {').length - 1).toBe(3); // joinTable, quickPlay, rebuy
  });
});

// ── Integration: a real socket.io server in a child process ─────────────────

const CHILD_TIMEOUT_MS = 25_000;
let tmpDir = '';

function transpileTo(dir: string, srcRel: string, outName: string): void {
  const code = fs.readFileSync(path.join(ROOT, srcRel), 'utf8');
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  fs.writeFileSync(path.join(dir, outName), js);
}

const SERVER_SCRIPT = `
const path = require('path');
const { createServer } = require('http');
const { Server } = require(process.env.SOCKET_IO_PATH);
const guarded = process.env.GUARDED === '1';
const { installSocketListenerGuard } = require(path.join(__dirname, 'socketGuard.js'));
const { installProcessCrashHandlers } = require(path.join(__dirname, 'processGuards.js'));
if (guarded) {
  installProcessCrashHandlers({
    flush: async () => { await new Promise((r) => setTimeout(r, 50)); console.log('FLUSHED'); },
    flushTimeoutMs: 3000,
    log: (l) => console.log(l),
  });
}
const httpServer = createServer();
const io = new Server(httpServer, { maxHttpBufferSize: 16 * 1024 });
io.on('connection', (socket) => {
  if (guarded) installSocketListenerGuard(socket, { log: (l) => console.log(l) });
  // The prod checkUsername body (no payload -> TypeError).
  socket.on('checkUsername', async (data) => {
    const name = (data.username || '').trim();
    socket.emit('checkUsernameResult', { available: true, username: name });
  });
  socket.on('throwsSync', (data, ack) => { throw new Error('sync boom ' + typeof data); });
  socket.on('rejectsAsync', async (data, ack) => { await null; throw new Error('async boom'); });
  socket.on('acksThenThrows', (data, ack) => { ack({ success: true }); throw new Error('late boom'); });
  socket.on('strayRejection', (data) => { Promise.reject(new Error('stray')); });
  socket.on('crashHard', (data) => { setImmediate(() => { throw new Error('uncaught boom'); }); });
  socket.on('ping2', (data, ack) => ack({ pong: true, pid: process.pid }));
});
httpServer.listen(0, '127.0.0.1', () => console.log('PORT ' + httpServer.address().port));
`;

interface Child { proc: ChildProcess; port: number; out: () => string; exited: Promise<{ code: number | null }> }

function startServer(guarded: boolean): Promise<Child> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(tmpDir, 'server.js')], {
      env: { ...process.env, GUARDED: guarded ? '1' : '0', SOCKET_IO_PATH: require.resolve('socket.io') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const exited = new Promise<{ code: number | null }>((r) => proc.on('exit', (code) => r({ code })));
    proc.stdout!.on('data', (d) => {
      out += String(d);
      const m = /PORT (\d+)/.exec(out);
      if (m) resolve({ proc, port: Number(m[1]), out: () => out, exited });
    });
    proc.stderr!.on('data', (d) => { out += String(d); });
    proc.on('error', reject);
    const startTimer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 10_000);
    startTimer.unref();
    proc.on("exit", () => clearTimeout(startTimer));
  });
}

/** A minimal socket.io v4 client over a raw websocket (engine.io v4 framing). */
function connectClient(port: number): Promise<{ send: (frame: string) => void; next: (pred: (m: string) => boolean, ms?: number) => Promise<string | null>; close: () => void }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const WS = require('ws');
  return new Promise((resolve, reject) => {
    const ws = new WS(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    const inbox: string[] = [];
    const waiters: Array<{ pred: (m: string) => boolean; done: (m: string | null) => void }> = [];
    ws.on('message', (raw: Buffer) => {
      const m = String(raw);
      if (m === '2') { ws.send('3'); return; }
      if (m.startsWith('0')) { ws.send('40'); return; }
      if (m.startsWith('40')) {
        resolve({
          send: (f) => ws.send(f),
          next: (pred, ms = 3000) => new Promise((done) => {
            const hit = inbox.find(pred);
            if (hit) { done(hit); return; }
            const w = { pred, done };
            waiters.push(w);
            setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); done(null); } }, ms).unref();
          }),
          close: () => { try { ws.terminate(); } catch { /* gone */ } },
        });
        return;
      }
      inbox.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.done(m); }
    });
    ws.on('error', reject);
  });
}

describe('integration — a real socket.io server in a child process', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-safety-'));
    transpileTo(tmpDir, 'src/socketGuard.ts', 'socketGuard.js');
    transpileTo(tmpDir, 'src/processGuards.ts', 'processGuards.js');
    fs.writeFileSync(path.join(tmpDir, 'server.js'), SERVER_SCRIPT);
  });
  afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('CONTROL — WITHOUT the guards, `checkUsername` with no payload exits the process', async () => {
    const child = await startServer(false);
    try {
      const c = await connectClient(child.port);
      c.send('42["checkUsername"]');
      const res = await Promise.race([child.exited, new Promise<null>((r) => setTimeout(() => r(null), 8000).unref())]);
      expect(res).not.toBeNull();
      expect(res!.code).not.toBe(0);
      expect(child.out()).toMatch(/TypeError|Cannot read/);
      c.close();
    } finally { child.proc.kill(); }
  }, CHILD_TIMEOUT_MS);

  it('WITH the guards: no payload, a sync throw, an async rejection, a late throw after an ack and a stray rejection — the process stays up and keeps answering', async () => {
    const child = await startServer(true);
    try {
      const c = await connectClient(child.port);
      c.send('42["checkUsername"]');                       // missing payload
      c.send('421["throwsSync",{}]');                      // sync throw, ack id 1
      c.send('422["rejectsAsync",{}]');                    // async rejection, ack id 2
      c.send('423["acksThenThrows",{}]');                  // acked, then throws: ONE ack
      c.send('42["strayRejection",{}]');                   // unhandled rejection
      expect(await c.next((m) => m.startsWith('431'))).toBe('431[{"success":false,"error":"server_error"}]');
      expect(await c.next((m) => m.startsWith('432'))).toBe('432[{"success":false,"error":"server_error"}]');
      expect(await c.next((m) => m.startsWith('433'))).toBe('433[{"success":true}]');
      c.send('424["ping2",{}]');
      const pong = await c.next((m) => m.startsWith('434'));
      expect(pong).toMatch(/^434\[\{"pong":true,"pid":\d+\}\]$/);
      // The missing-payload frame never reached the body (no checkUsernameResult).
      expect(await c.next((m) => m.includes('checkUsernameResult'), 300)).toBeNull();
      const out = child.out();
      expect(out).toContain('[socket-payload-rejected] {"event":"checkUsername","payload":"missing"');
      expect(out).toContain('[socket-handler-error] {"event":"throwsSync","kind":"sync"');
      expect(out).toContain('[socket-handler-error] {"event":"rejectsAsync","kind":"async"');
      expect(out).toContain('[socket-handler-error] {"event":"acksThenThrows","kind":"sync"');
      expect(out).toContain('[process-unhandled-rejection]');
      expect(child.proc.exitCode).toBeNull();
      c.close();
    } finally { child.proc.kill(); }
  }, CHILD_TIMEOUT_MS);

  it('WITH the guards: a genuinely uncaught exception runs the flush, THEN exits 1', async () => {
    const child = await startServer(true);
    try {
      const c = await connectClient(child.port);
      c.send('42["crashHard",{}]');
      const res = await Promise.race([child.exited, new Promise<null>((r) => setTimeout(() => r(null), 8000).unref())]);
      expect(res).toEqual({ code: 1 });
      const out = child.out();
      expect(out).toContain('[process-uncaught-exception]');
      expect(out.indexOf('FLUSHED')).toBeGreaterThan(out.indexOf('[process-uncaught-exception]'));
      expect(out).toContain('"flush":"done"');
      c.close();
    } finally { child.proc.kill(); }
  }, CHILD_TIMEOUT_MS);
});
