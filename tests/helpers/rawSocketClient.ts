/**
 * 2026-11-02 (.online tournament broadcast) — a minimal Socket.IO v4 client over
 * a raw websocket (engine.io v4 framing), for tests against a REAL in-process
 * socket.io Server: no socket.io-client dependency (the repo has none — the
 * crashSafety.test.ts pattern, extended to namespaces, acks and connect errors).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WS = require('ws');

export interface Packet { type: number; nsp: string; id: number | null; data: any }

export function parsePacket(m: string): Packet | null {
  if (m[0] !== '4') return null;
  const type = Number(m[1]);
  let rest = m.slice(2);
  let nsp = '/';
  if (rest.startsWith('/')) {
    const i = rest.indexOf(',');
    nsp = i < 0 ? rest : rest.slice(0, i);
    rest = i < 0 ? '' : rest.slice(i + 1);
  }
  let id: number | null = null;
  const idm = /^(\d+)/.exec(rest);
  if (idm && (type === 2 || type === 3)) { id = Number(idm[1]); rest = rest.slice(idm[1].length); }
  return { type, nsp, id, data: rest ? JSON.parse(rest) : undefined };
}

export interface RawClient {
  /** Resolves when the namespace answered: {ok:true} or {ok:false, error:{message, data}}. */
  ready: Promise<{ ok: boolean; error?: any }>;
  packets: Packet[];
  emit(event: string, payload?: unknown): void;
  /** Sends the RAW frame (after the engine "4"): e.g. `2/broadcast,["bc:subscribe"]`. */
  sendRaw(frame: string): void;
  request(event: string, payload: unknown, ms?: number): Promise<any>;
  /** Payloads of `event` received so far. */
  events(event: string): any[];
  /** Waits for a packet matching pred (already received or future), or null after ms. */
  next(pred: (p: Packet) => boolean, ms?: number): Promise<Packet | null>;
  disconnected(): boolean;
  close(): void;
}

export function rawClient(port: number, nsp: string, opts: { auth?: Record<string, unknown>; headers?: Record<string, string> } = {}): RawClient {
  const ws = new WS(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, { headers: opts.headers || {} });
  const prefix = nsp === '/' ? '' : `${nsp},`;
  const packets: Packet[] = [];
  const waiters: Array<{ pred: (p: Packet) => boolean; done: (p: Packet | null) => void }> = [];
  let ackId = 0;
  let nspDisconnected = false;
  let resolveReady!: (r: { ok: boolean; error?: any }) => void;
  const ready = new Promise<{ ok: boolean; error?: any }>((r) => { resolveReady = r; });
  ws.on('message', (raw: Buffer) => {
    const m = String(raw);
    if (m === '2') { ws.send('3'); return; }
    if (m.startsWith('0')) { ws.send(`40${prefix}${JSON.stringify(opts.auth || {})}`); return; }
    const p = parsePacket(m);
    if (!p || p.nsp !== nsp) return;
    if (p.type === 0) { resolveReady({ ok: true }); return; }
    if (p.type === 4) { resolveReady({ ok: false, error: p.data }); return; }
    if (p.type === 1) nspDisconnected = true;
    packets.push(p);
    for (const w of [...waiters]) if (w.pred(p)) { waiters.splice(waiters.indexOf(w), 1); w.done(p); }
  });
  ws.on('close', () => { nspDisconnected = true; resolveReady({ ok: false, error: { message: 'closed' } }); });
  ws.on('error', () => { /* surfaced through ready / close */ });
  const send = (frame: string) => { try { ws.send(`4${frame}`); } catch { /* closed */ } };
  const next = (pred: (p: Packet) => boolean, ms = 2000) => new Promise<Packet | null>((done) => {
    const hit = packets.find(pred);
    if (hit) { done(hit); return; }
    const w = { pred, done };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); done(null); } }, ms).unref();
  });
  return {
    ready,
    packets,
    emit: (event, payload) => send(`2${prefix}${JSON.stringify(payload === undefined ? [event] : [event, payload])}`),
    sendRaw: (frame) => send(frame),
    request: async (event, payload, ms = 2000) => {
      const id = ++ackId;
      send(`2${prefix}${id}${JSON.stringify([event, payload])}`);
      const p = await next((x) => x.type === 3 && x.id === id, ms);
      return p ? p.data[0] : null;
    },
    events: (event) => packets.filter((p) => p.type === 2 && Array.isArray(p.data) && p.data[0] === event).map((p) => p.data[1]),
    next,
    disconnected: () => nspDisconnected,
    close: () => { try { ws.terminate(); } catch { /* gone */ } },
  };
}
