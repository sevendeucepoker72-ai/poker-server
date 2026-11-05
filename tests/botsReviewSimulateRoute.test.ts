/**
 * Bots review 2026-11-04 (A-simulate) — POST /api/tournament/simulate FAILS
 * CLOSED, like /api/qualifiers/overflow.
 *
 * Before: the X-Internal-Token was checked only when INTERNAL_NOTIFY_TOKEN was
 * set (an unset token let ANY caller start a bot tournament of up to 1000
 * players), untrimmed, with a non-constant-time !==.
 * Now: internalTokenMatches (trimmed env, sha256 + timingSafeEqual; an unset
 * token never matches) → 403 {error:'forbidden'}. The body and the 2..1000
 * clamp are unchanged.
 *
 * REAL src/index.ts text (the route + internalTokenMatches), a fake app.
 */
import { createHash, timingSafeEqual } from 'crypto';
import { slice, fnSrc, load } from './helpers/indexSource';

const ROUTE = slice("app.post('/api/tournament/simulate'", '\n});\n');
const TOKEN = fnSrc('function internalTokenMatches(');

function world(env: Record<string, string | undefined>) {
  const routes = new Map<string, (req: any, res: any) => void>();
  const started: Array<[number, boolean]> = [];
  const scope: Record<string, unknown> = {
    app: { post: (p: string, fn: any) => { routes.set(p, fn); } },
    process: { env },
    createHash, timingSafeEqual,
    startMultiTableTournament: (n: number, _a: unknown, _b: unknown, _c: unknown, turbo: boolean) => { started.push([n, turbo]); return { tournamentId: 't1', tableCount: Math.ceil(n / 9) }; },
  };
  const { stubbed } = load(`${TOKEN}\n${ROUTE}`, scope, '{}');
  const post = (headers: Record<string, unknown>, body: any = {}) => {
    const out: { status: number; body: any } = { status: 200, body: null };
    const res = { status: (c: number) => { out.status = c; return res; }, json: (b: any) => { out.body = b; return res; } };
    routes.get('/api/tournament/simulate')!({ headers, body }, res);
    return out;
  };
  return { post, started, stubbed };
}

describe('/api/tournament/simulate fails closed (internalTokenMatches)', () => {
  it('no INTERNAL_NOTIFY_TOKEN configured → 403 forbidden, nothing started (0dc1b96: 200 and a tournament started)', () => {
    const w = world({});
    expect(w.post({}, { playerCount: 50 })).toEqual({ status: 403, body: { error: 'forbidden' } });
    expect(w.post({ 'x-internal-token': '' }, { playerCount: 50 })).toEqual({ status: 403, body: { error: 'forbidden' } });
    expect(w.started).toEqual([]);
    expect([...w.stubbed]).toEqual([]);
  });

  it('a whitespace-only token configured is "unset" → 403', () => {
    const w = world({ INTERNAL_NOTIFY_TOKEN: '  \n' });
    expect(w.post({ 'x-internal-token': '  \n' }).status).toBe(403);
    expect(w.started).toEqual([]);
  });

  it('env " tok \\n" (trimmed) with header "tok" → 200, the tournament started', () => {
    const w = world({ INTERNAL_NOTIFY_TOKEN: ' tok \n' });
    const r = w.post({ 'x-internal-token': 'tok' }, { playerCount: 27, turbo: true });
    expect(r).toEqual({ status: 200, body: { success: true, tournamentId: 't1', tableCount: 3, playerCount: 27, turbo: true } });
    expect(w.started).toEqual([[27, true]]);
  });

  it('GUARD (passes at 0dc1b96 too) — a wrong, missing or array header → 403', () => {
    const w = world({ INTERNAL_NOTIFY_TOKEN: 'tok' });
    expect(w.post({ 'x-internal-token': 'nope' }).status).toBe(403);
    expect(w.post({}).status).toBe(403);
    expect(w.post({ 'x-internal-token': ['tok'] }).status).toBe(403);
    expect(w.started).toEqual([]);
  });

  it('GUARD (passes at 0dc1b96 too) — playerCount is still clamped: 99999 → 1000, 1 → 2, missing → 200', () => {
    const w = world({ INTERNAL_NOTIFY_TOKEN: 'tok' });
    expect(w.post({ 'x-internal-token': 'tok' }, { playerCount: 99999 }).body.playerCount).toBe(1000);
    expect(w.post({ 'x-internal-token': 'tok' }, { playerCount: 1 }).body.playerCount).toBe(2);
    expect(w.post({ 'x-internal-token': 'tok' }, {}).body.playerCount).toBe(200);
    expect(w.started.map(([n]) => n)).toEqual([1000, 2, 200]);
  });
});
