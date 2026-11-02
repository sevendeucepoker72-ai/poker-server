/**
 * 2026-11-02 (.online tournament broadcast, P2-S3 / S4 / S9 / S7a) — a REAL
 * in-process socket.io Server with the /broadcast namespace registered on a
 * broadcast test world (real TournamentManager + PokerTables), raw websocket
 * clients, captured routes / logs / audits, an optional fake Postgres and a
 * controllable clock. Timers off: tests drive tick / flushTables / heartbeat.
 */
import { createServer, Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { registerBroadcast, type BroadcastHandle } from '../../src/broadcast/wire';
import { clientIpFromHandshake } from '../../src/net/clientIp';
import { qualifierWorld, type BroadcastTestWorld } from './broadcastWorld';
import { rawClient, type RawClient } from './rawSocketClient';

export const TEST_SECRET = 'test-broadcast-secret-0123456789abcdef';

export interface Rig {
  http: HttpServer; io: Server; port: number; w: BroadcastTestWorld; handle: BroadcastHandle;
  routes: Record<string, (req: any, res: any) => void>; logs: string[]; audits: Array<{ actor: string; action: string; details: any }>;
  clients: RawClient[]; client(nsp: string, opts?: Parameters<typeof rawClient>[2]): RawClient;
  clock: { t: number | null };
  close(): Promise<void>;
}

export async function broadcastRig(o: {
  env?: Record<string, string>; tables?: number; world?: BroadcastTestWorld; db?: any; names?: string[];
  /** Player ids whose elimination is a deferred hand-for-hand bust (index.ts handForHandNoticeDeferred). */
  deferred?: Set<string>;
} = {}): Promise<Rig> {
  const http = createServer();
  const io = new Server(http);
  // The game's default namespace: nothing a /broadcast socket can reach.
  io.on('connection', () => { /* default namespace */ });
  const w = o.world || qualifierWorld({ tables: o.tables ?? 2, ...(o.names ? { names: o.names } : {}) });
  const routes: Record<string, (req: any, res: any) => void> = {};
  const logs: string[] = [];
  const audits: Rig['audits'] = [];
  const clock = { t: null as number | null };
  const handle = registerBroadcast(io, {
    world: w.world,
    realClientIp: (s) => clientIpFromHandshake(s.handshake as any),
    bannedIPs: new Set(),
    env: { BROADCAST_TOKEN_SECRET: TEST_SECRET, ...(o.env || {}) },
    internalTokenMatches: (given) => given === 'secret-token',
    auditLog: (actor, action, details) => audits.push({ actor, action, details }),
    commit: () => 'abc1234',
    app: { get: (p, h) => { routes[`GET ${p}`] = h; }, post: (p, h) => { routes[`POST ${p}`] = h; } },
    db: o.db ?? null,
    isDeferredBust: (pid) => typeof pid === 'string' && !!o.deferred?.has(pid),
    log: (l) => logs.push(l),
    now: () => (clock.t === null ? Date.now() : clock.t),
    timers: false,
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as any).port;
  const clients: RawClient[] = [];
  return {
    http, io, port, w, handle, routes, logs, audits, clients, clock,
    client: (nsp, opts) => { const c = rawClient(port, nsp, opts); clients.push(c); return c; },
    close: async () => {
      for (const c of clients) c.close();
      handle.stop();
      await new Promise<void>((done) => io.close(() => done()));
    },
  };
}

/** An Express-like response capture. */
export function fakeRes() {
  const out: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  out.set = (k: string, v: string) => { out.headers[k] = v; return out; };
  out.status = (c: number) => { out.statusCode = c; return out; };
  out.json = (b: unknown) => { out.body = b; return out; };
  return out;
}

export const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

/** The bc:frame payloads a client got, in order. */
export const framesOf = (c: RawClient) => c.events('bc:frame');
