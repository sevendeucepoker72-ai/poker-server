/**
 * R1 (2026-10-11) — TABLEUI-7, contract #5: the per-socket gameState delta
 * sends `null` for a key that disappeared.
 *
 * shallowDiff put `undefined` in the delta for a removed key and JSON dropped
 * it, so the client never learned the key was gone: after a chopped pot,
 * `isChoppedPot` / `chopDetails` stayed true in the client's merged state and
 * the "Split Pot!" banner came back at the NEXT hand's showdown (reproduced in
 * the TABLEUI sim); stale trainingData / potBreakdown the same way. Real
 * emitGameState + shallowDiff (sliced from src/index.ts), the wire (JSON), and
 * poker-3d's merge (`{ ...prev, ...delta }`, App.jsx gameState handler).
 */
import { slice, fnSrc, load } from './helpers/indexSource';

function wire() {
  const code = slice('const ALWAYS_EMIT_KEYS', ';\n') + fnSrc('function shallowDiff(') + fnSrc('function pickAlwaysEmit(') + fnSrc('function emitGameState(');
  const { exports: e } = load(code, { lastSentState: new Map(), lastSentJson: new Map() }, '{ emitGameState, shallowDiff }');
  const frames: any[] = [];
  const sock = { id: 'S1', emit: (_ev: string, d: any) => frames.push(JSON.parse(JSON.stringify(d))) };   // what the socket carries
  let client: any = null;
  const send = (state: any, full = false) => {
    e.emitGameState(sock, state, full);
    const f = frames[frames.length - 1];
    client = f.full ? f.state : { ...client, ...f.delta };                                                  // poker-3d's merge
    return f;
  };
  return { e, send, frames, get client() { return client; } };
}

const base = (over: Record<string, unknown>) => ({
  tableId: 'T', phase: 'PreFlop', handNumber: 1, pot: 150, activeSeatIndex: 2, turnStartedAt: 1, turnTimeout: 30000,
  seats: [{ seatIndex: 0 }, { seatIndex: 1 }], ...over,
});

describe('shallowDiff / emitGameState: a removed key is sent as null (contract #5)', () => {
  it('THE SIM: a chopped pot never leaves a stale "Split Pot!" banner on the next hand', () => {
    const w = wire();
    w.send(base({}), true);
    w.send(base({ phase: 'HandComplete', handResult: { winners: [{ seatIndex: 0 }, { seatIndex: 1 }] }, isChoppedPot: true, chopDetails: [{ seatIndex: 0, share: 75 }, { seatIndex: 1, share: 75 }], potBreakdown: [{ amount: 150 }] }));
    const next = w.send(base({ handNumber: 2, phase: 'PreFlop' }));
    expect(next.delta).toMatchObject({ isChoppedPot: null, chopDetails: null, potBreakdown: null, handResult: null });
    w.send(base({ handNumber: 2, phase: 'HandComplete', handResult: { winners: [{ seatIndex: 1 }] } }));
    const gs = w.client;
    const bannerShown = !!(gs.isChoppedPot && gs.chopDetails && (gs.phase === 'Showdown' || gs.phase === 'HandComplete'));
    expect(bannerShown).toBe(false);
    expect(gs.chopDetails).toBeNull();
  });

  it('a cleared key is not re-sent while it stays absent; it comes back when it reappears', () => {
    const w = wire();
    w.send(base({ trainingData: { equity: 40 } }), true);
    expect(w.send(base({})).delta).toMatchObject({ trainingData: null });
    expect('trainingData' in w.send(base({ pot: 200 })).delta).toBe(false);   // absent again: nothing to say
    expect(w.send(base({ pot: 200, trainingData: { equity: 55 } })).delta).toMatchObject({ trainingData: { equity: 55 } });
    expect(w.client.trainingData).toEqual({ equity: 55 });
  });

  it('a key that is null in both frames is never sent; an explicit null that replaces a value still is', () => {
    const w = wire();
    w.send(base({ insuranceQuote: null, missedBlinds: 50 }), true);
    const f = w.send(base({ insuranceQuote: null, missedBlinds: null }));
    expect('insuranceQuote' in f.delta).toBe(false);
    expect(f.delta.missedBlinds).toBeNull();
  });

  it('shallowDiff itself: removed -> null; undefined -> undefined / null -> undefined are no change', () => {
    const { e } = wire();
    expect(e.shallowDiff({ a: 1, b: { x: 1 }, c: null, d: undefined }, { })).toEqual({ a: null, b: null });
    expect(e.shallowDiff({ a: null }, { a: undefined })).toBeNull();
    expect(e.shallowDiff({}, { a: undefined })).toBeNull();
  });
});
