/**
 * 2026-11-02 (.online tournament broadcast, fix round 2, poker-server) — regression guards:
 *  SG  Sit & Go streaming is OFF unless env BROADCAST_SITGO is exactly '1'. Sit & Go
 *      players get no streaming notice and no opt-out UI yet, so with the flag unset a
 *      template Sit & Go's event key answers not_broadcastable everywhere: bc:subscribe
 *      (public and delayed keys), the key mint (output and delayed scopes), the producer's
 *      channel bind, the results route; GET /api/broadcast/events and the producer's event
 *      list name no Sit & Go; a key or a channel binding made while the flag was on carries
 *      nothing after a restart with it off. Qualifiers are unchanged. With the flag on the
 *      same calls work (the flag is the only new gate).
 *  RL  A keyed handshake whose persisted key list is still loading after a restart is
 *      refused 'registry_loading' (it was 'starting'; the poker-3d page keeps its key and
 *      retries on it). The contract's handshake refusal list names it.
 */
import { resolveEventKey } from '../src/broadcast/eventKey';
import { HANDSHAKE_REFUSAL_CODES } from '../src/broadcast/contract';
import type { Tournament } from '../src/game/TournamentManager';
import { broadcastRig, fakeRes, type Rig } from './helpers/broadcastRig';
import { fakeBroadcastDb, qualifierWorld, type BroadcastTestWorld } from './helpers/broadcastWorld';
import { HOLECARD_ENV, OWNER } from './helpers/delayedRig';

jest.setTimeout(60_000);

const NOT_BROADCASTABLE = { ok: false, code: 'not_broadcastable' };

/** The world's template Sit & Gos (TournamentManager creates one registering instance per template), listed as index.ts lists them. */
function withSitGos(w: BroadcastTestWorld): Tournament[] {
  const sitGos = w.tm.tournamentIdsWithStatus('registering')
    .map((id) => w.tm.getTournament(id)!)
    .filter((t) => t.config.fromTemplate === true && !t.config.unlisted);
  if (sitGos.length === 0) throw new Error('no template Sit & Go');
  w.world.sitGoTournaments = () => sitGos;
  return sitGos;
}

async function producer(r: Rig) {
  const k = await r.handle.mintToken({ ev: 'ch:*', scopes: ['producer'], label: 'Producer panel', ttlHours: 12 } as any, OWNER);
  if (!k.ok) throw new Error(`producer key: ${(k as any).code}`);
  const p = r.client('/broadcast', { auth: { key: k.token } });
  expect((await p.ready).ok).toBe(true);
  return p;
}

const route = (r: Rig, name: string, req: Record<string, unknown> = {}) => {
  const res = fakeRes();
  r.routes[name](req, res);
  return res;
};

// ================================================================ SG — pure resolver
describe('SG — resolveEventKey: a Sit & Go is broadcastable only when the world says Sit & Go streaming is on', () => {
  it('no switch (or false) → not_broadcastable for a live or archived template Sit & Go; true → ok; qualifier keys unchanged', () => {
    const w = qualifierWorld();
    const [sg] = withSitGos(w);
    const key = `t:${sg.config.tournamentId}`;
    expect(resolveEventKey(w.world, key)).toEqual(NOT_BROADCASTABLE);
    expect(resolveEventKey({ ...w.world, sitGoBroadcastOn: () => false } as any, key)).toEqual(NOT_BROADCASTABLE);
    expect(resolveEventKey({ ...w.world, sitGoBroadcastOn: () => true } as any, key))
      .toMatchObject({ ok: true, ev: { key, kind: 'sitgo', qualifierId: null, tournamentId: sg.config.tournamentId } });
    // A finished Sit & Go the engine already dropped (the broadcast's archive).
    const archived = { ...w.world, tournament: () => undefined, archived: (id: string) => (id === 'gone' ? { tournamentId: 'gone' } : undefined) };
    expect(resolveEventKey(archived as any, 't:gone')).toEqual(NOT_BROADCASTABLE);
    expect(resolveEventKey({ ...archived, sitGoBroadcastOn: () => true } as any, 't:gone')).toMatchObject({ ok: true, ev: { key: 't:gone', kind: 'sitgo' } });
    // Qualifiers: unchanged with Sit & Go streaming off.
    expect(resolveEventKey(w.world, `t:${w.tid}`)).toMatchObject({ ok: true, ev: { key: `q:${w.qualId}`, kind: 'weekly' } });
    expect(resolveEventKey(w.world, `q:${w.qualId}`)).toMatchObject({ ok: true, ev: { key: `q:${w.qualId}` } });
    expect(resolveEventKey(w.world, 'next:weekly')).toMatchObject({ ok: true, ev: { key: `q:${w.qualId}` } });
    expect(resolveEventKey(w.world, 'next:any')).toMatchObject({ ok: true, ev: { key: `q:${w.qualId}` } });
    // Club / custom stay not_broadcastable whatever the switch; unknown stays event_not_found.
    const club = w.tm.createTournament({ name: 'Club Night', buyIn: 0, prizePool: 0, maxPlayers: 9, startInterval: 0, unlisted: true, blindLevels: [{ sb: 10, bb: 20, ante: 0, duration: 300 }] } as any, { fromTemplate: true });
    expect(resolveEventKey({ ...w.world, sitGoBroadcastOn: () => true } as any, `t:${club}`)).toEqual(NOT_BROADCASTABLE);
    expect(resolveEventKey(w.world, 't:nope')).toEqual({ ok: false, code: 'event_not_found' });
  });
});

// ================================================================ SG — the wire, flag unset (production default)
describe('SG — BROADCAST_SITGO unset: a Sit & Go answers not_broadcastable everywhere; qualifiers unchanged', () => {
  it('subscribe, events list (REST + producer hello), results route, mint (output / delayed), producer bind', async () => {
    const w = qualifierWorld();
    const [sg] = withSitGos(w);
    const key = `t:${sg.config.tournamentId}`;
    // The hole-card env is on so a delayed mint reaches the event check (otherwise holecards_off first).
    const r = await broadcastRig({ world: w, env: { ...HOLECARD_ENV } });
    try {
      const a = r.client('/broadcast');
      expect((await a.ready).ok).toBe(true);
      expect(await a.request('bc:subscribe', { v: 1, event: key, layout: '16x9' })).toEqual(NOT_BROADCASTABLE);
      expect(await a.request('bc:subscribe', { v: 1, event: key, layout: '9x16', follow: 'none' })).toEqual(NOT_BROADCASTABLE);
      // The qualifier is unchanged.
      expect((await a.request('bc:subscribe', { v: 1, event: `q:${w.qualId}`, layout: '16x9' })).ok).toBe(true);
      // Events list: the qualifier only.
      expect(r.handle.eventsList().map((e) => [e.eventKey, e.kind])).toEqual([[`q:${w.qualId}`, 'weekly']]);
      expect(route(r, 'GET /api/broadcast/events').body.map((e: any) => e.kind)).toEqual(['weekly']);
      // Results route: nothing for a Sit & Go key.
      expect(route(r, 'GET /api/broadcast/:eventKey/results', { params: { eventKey: key } }).statusCode).toBe(404);
      // Mint: an output key and a delayed key for the Sit & Go are refused not_broadcastable.
      expect(await r.handle.mintToken({ ev: key, scopes: ['output'], label: 'OBS Sit & Go' } as any, OWNER)).toEqual(NOT_BROADCASTABLE);
      expect(await r.handle.mintToken({ ev: key, scopes: ['delayed', 'output'], label: 'OBS Sit & Go delayed' } as any, OWNER)).toEqual(NOT_BROADCASTABLE);
      expect((await r.handle.mintToken({ ev: `q:${w.qualId}`, scopes: ['output'], label: 'OBS weekly' } as any, OWNER)).ok).toBe(true);
      // Producer: the event list names no Sit & Go; binding the sitgo channel to one is refused.
      const p = await producer(r);
      const hello = await p.request('bc:producer:hello', {});
      expect(hello.ok).toBe(true);
      expect(hello.events.map((e: any) => e.kind)).toEqual(['weekly']);
      expect(await p.request('bc:producer:setEvent', { channel: 'sitgo', event: key })).toEqual(NOT_BROADCASTABLE);
      expect(r.handle.store.bindingOf('sitgo')).toBeNull();
      // Binding a qualifier to the sitgo channel is unchanged.
      expect(await p.request('bc:producer:setEvent', { channel: 'sitgo', event: `q:${w.qualId}` }))
        .toMatchObject({ ok: true, channel: 'sitgo', binding: `q:${w.qualId}`, eventKey: `q:${w.qualId}` });
      expect((r.handle.health() as any).sitGoOn).toBe(false);
    } finally { await r.close(); }
  });

  it('only an exact "1" turns it on (unset, "0", "true", "yes" are off)', async () => {
    for (const [v, on] of [[undefined, false], ['0', false], ['true', false], ['yes', false], ['1', true], [' 1 ', true]] as const) {
      const r = await broadcastRig({ env: v === undefined ? {} : { BROADCAST_SITGO: v } });
      try { expect([v, (r.handle.health() as any).sitGoOn]).toEqual([v, on]); } finally { await r.close(); }
    }
  });

  it('a key and a channel binding made while it was ON carry nothing after a restart with it OFF', async () => {
    const db = fakeBroadcastDb();
    const w = qualifierWorld();
    const [sg] = withSitGos(w);
    const key = `t:${sg.config.tournamentId}`;
    let outKey = '';
    let delayedKey = '';
    const on = await broadcastRig({ world: w, db, env: { ...HOLECARD_ENV, BROADCAST_SITGO: '1' } });
    try {
      await on.handle.loadPersisted();
      const o = await on.handle.mintToken({ ev: key, scopes: ['output'], label: 'OBS Sit & Go' } as any, OWNER);
      const d = await on.handle.mintToken({ ev: key, scopes: ['delayed', 'output'], label: 'OBS Sit & Go delayed' } as any, OWNER);
      if (!o.ok || !d.ok) throw new Error('mint while on');
      outKey = o.token;
      delayedKey = d.token;
      const p = await producer(on);
      expect(await p.request('bc:producer:setEvent', { channel: 'sitgo', event: key })).toMatchObject({ ok: true, binding: key, eventKey: key });
    } finally { await on.close(); }

    const off = await broadcastRig({ world: w, db, env: { ...HOLECARD_ENV } });
    try {
      await off.handle.loadPersisted();
      const c = off.client('/broadcast', { auth: { key: outKey } });
      expect((await c.ready).ok).toBe(true);
      expect(await c.request('bc:subscribe', { v: 1, event: key, layout: '16x9', role: 'output' })).toEqual(NOT_BROADCASTABLE);
      const dl = off.client('/broadcast', { auth: { key: delayedKey } });
      expect((await dl.ready).ok).toBe(true);
      expect(await dl.request('bc:subscribe', { v: 1, event: key, layout: '16x9' })).toEqual(NOT_BROADCASTABLE);
      expect((off.handle.health() as any).delayedSessions).toBe(0);
      // The persisted binding is kept (never deleted) but resolves to nothing: no Sit & Go data on the channel.
      expect(off.handle.store.bindingOf('sitgo')).toBe(key);
      const a = off.client('/broadcast');
      expect((await a.ready).ok).toBe(true);
      expect(await a.request('bc:subscribe', { v: 1, channel: 'sitgo', layout: '16x9' })).toEqual({ ok: false, code: 'event_not_found', parked: true });
      expect(off.handle.onAirView().channels.find((x) => x.channel === 'sitgo')).toMatchObject({ eventKey: null });
    } finally { await off.close(); }
  });
});

// ================================================================ SG — flag on (control)
describe('SG — BROADCAST_SITGO=1: the same calls work', () => {
  it('subscribe → a sitgo snapshot; the events list and producer hello name it; mint and producer bind succeed', async () => {
    const w = qualifierWorld();
    const sitGos = withSitGos(w);
    const key = `t:${sitGos[0].config.tournamentId}`;
    const r = await broadcastRig({ world: w, env: { BROADCAST_SITGO: '1' } });
    try {
      const a = r.client('/broadcast');
      expect((await a.ready).ok).toBe(true);
      const ack = await a.request('bc:subscribe', { v: 1, event: key, layout: '16x9' });
      expect(ack.ok).toBe(true);
      expect(ack.snapshot.program.event).toMatchObject({ kind: 'sitgo', tournamentId: sitGos[0].config.tournamentId });
      const kinds = r.handle.eventsList().map((e) => e.kind);
      expect(kinds.filter((k) => k === 'sitgo').length).toBe(sitGos.length);
      expect(kinds).toContain('weekly');
      expect((await r.handle.mintToken({ ev: key, scopes: ['output'], label: 'OBS Sit & Go' } as any, OWNER)).ok).toBe(true);
      const p = await producer(r);
      expect((await p.request('bc:producer:hello', {})).events.some((e: any) => e.eventKey === key)).toBe(true);
      expect(await p.request('bc:producer:setEvent', { channel: 'sitgo', event: key })).toMatchObject({ ok: true, channel: 'sitgo', binding: key, eventKey: key });
      expect((r.handle.health() as any).sitGoOn).toBe(true);
    } finally { await r.close(); }
  });
});

// ================================================================ RL — registry_loading
describe("RL — the key list still loading after a restart → 'registry_loading' (never 'starting')", () => {
  it('the contract lists registry_loading; a keyed handshake that outwaits the load is refused it, counted and logged under that code', async () => {
    expect(HANDSHAKE_REFUSAL_CODES).toContain('registry_loading');
    expect(HANDSHAKE_REFUSAL_CODES as readonly string[]).not.toContain('starting');
    const before = await broadcastRig({ db: fakeBroadcastDb() });
    let token = '';
    try {
      await before.handle.loadPersisted();
      const k = await before.handle.mintToken({ ev: 'ch:weekly', scopes: ['output'], label: 'OBS weekly' } as any, OWNER);
      if (!k.ok) throw new Error('mint');
      token = k.token;
    } finally { await before.close(); }
    const down = fakeBroadcastDb();
    down.fail = true;
    const r = await broadcastRig({ db: down, env: { BCAST_KEY_LIST_WAIT_MS: '150' } });
    try {
      await r.handle.loadPersisted();
      expect(r.handle.tokens.isLoaded()).toBe(false);
      const c = r.client('/broadcast', { auth: { key: token } });
      expect((await c.ready).error.data).toEqual({ code: 'registry_loading' });
      const refusals = (r.handle.health() as any).refusals;
      expect(refusals.registry_loading).toBe(1);
      expect(refusals.starting).toBeUndefined();
      expect(r.logs.some((l) => l.includes('"code":"registry_loading"'))).toBe(true);
      expect(r.logs.some((l) => l.includes('"code":"starting"'))).toBe(false);
    } finally { await r.close(); }
  });
});
