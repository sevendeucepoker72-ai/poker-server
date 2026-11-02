/**
 * 2026-11-02 (.online tournament broadcast, P2-S9) — THE PROGRAM STORE: what the
 * producer controls on each channel (spec R2, §3 ProgramState): the channel's
 * event binding, the scene (a producer pin, or auto), auto featured table on /
 * off and a featured-table lock, lower thirds, the feed mode, and ON AIR (with
 * rehearsal) — which auto-clears ON_AIR_MAX_MS (9 h) after it was set, or
 * ON_AIR_AFTER_FINISH_MS (2 h) after the channel's event finished.
 *
 * Channel BINDINGS persist in Postgres `broadcast_channels` (channel PK,
 * event_key, updated_by, updated_at; DDL in authManager initDB next to
 * qualifier_configs) so a mid-week redeploy keeps "the main channel shows the
 * Monthly". Everything else is in memory: a restart during an event cancels the
 * qualifier anyway (index.ts), and the producer re-arms on air.
 *
 * Pure state + validation; the wire applies it to each program (applyTo) and
 * the producer API (producer.ts) mutates it and audits every mutation. Never
 * throws into a caller; a DB failure keeps the in-memory value and says so.
 */
import {
  BROADCAST_CHANNELS, HOLECARD_MIN_DELAY_MS, LOWER_THIRDS_MAX, ON_AIR_AFTER_FINISH_MS, ON_AIR_MAX_MS,
  type ChannelId, type LowerThird, type ProgramState, type SceneId,
} from './contract';
import { channelDefaultBinding } from './eventKey';
import { cleanLabel, type TokenDb } from './broadcastToken';
import type { FeaturedLock } from './featuredTable';

export const SCENE_IDS: readonly SceneId[] = ['starting', 'table', 'break', 'hfh', 'finalIntro', 'results', 'slate', 'recap', 'room'];
const LOWER_THIRD_KINDS = ['host', 'info', 'player', 'legal', 'venue'] as const;
const ID_RE = /^[A-Za-z0-9_.:-]{1,40}$/;
/** A lower third's `until` at most this far ahead of the program clock. */
const LOWER_THIRD_MAX_MS = 24 * 60 * 60 * 1000;

export interface ChannelControl {
  channel: ChannelId;
  /** A producer binding ('q:<id>' | 't:<id>' | 'next:weekly' | 'next:monthly'), or null = the channel default. */
  stored: string | null;
  storedBy: string | null;
  scenePin: { id: SceneId; params?: Record<string, unknown>; since: number } | null;
  autoTable: boolean;
  lock: (FeaturedLock & { by: string }) | null;
  lowerThirds: LowerThird[];
  feed: { mode: 'public' | 'delayed'; delayMs: number };
  onAir: { on: boolean; rehearsal: boolean; since: number | null; by: string | null };
}

export interface ProgramStore {
  control(channel: ChannelId): ChannelControl;
  /** The binding in force: the producer's, else the channel default ('next:any' for main; null = unbound). */
  bindingOf(channel: ChannelId): string | null;
  load(): Promise<{ loaded: number; error?: string }>;
  setBinding(channel: ChannelId, eventKey: string | null, actor: string): Promise<{ persisted: boolean }>;
  pinScene(channel: ChannelId, id: SceneId | null, params?: Record<string, unknown>): void;
  setAutoTable(channel: ChannelId, on: boolean): void;
  setLock(channel: ChannelId, lock: (FeaturedLock & { by: string }) | null): void;
  lowerThird(channel: ChannelId, op: unknown, item: unknown, programNow: number): { ok: true; lowerThirds: LowerThird[] } | { ok: false; code: 'invalid_request' };
  setFeedPublic(channel: ChannelId): void;
  /** 2026-11-02 (P5) — the channel's DELAYED sessions run this delay (the caller clamps it: >= 5 min). */
  setFeedDelayed(channel: ChannelId, delayMs: number): void;
  setOnAir(channel: ChannelId, on: boolean, rehearsal: boolean, actor: string): ChannelControl['onAir'];
  /** Auto-clears on air (9 h after set; 2 h after the event finished) and drops lower thirds past `until`. */
  expire(channel: ChannelId, now: number, eventFinishedAt: number | null): { onAirCleared: 'max_age' | 'event_finished' | null; lowerThirdsDropped: number };
  /** The channel's program: the producer's scene / lower thirds / on air over the event's build. */
  applyTo(program: ProgramState, channel: ChannelId, auto: { sceneId: SceneId; since: number }): ProgramState;
  stats(): Record<string, unknown>;
}

/** Validate a scene's params: a small flat object of short primitives. */
export function cleanSceneParams(raw: unknown): Record<string, unknown> | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 8) return null;
  for (const [k, v] of entries) {
    if (!ID_RE.test(k)) return null;
    if (typeof v === 'string') out[k] = cleanLabel(v, 80);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else return null;
  }
  return out;
}

/** A lower third as sent by the producer → the stored item, or null (invalid). Plain text only. */
export function cleanLowerThird(raw: unknown, programNow: number): LowerThird | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  const kind = (LOWER_THIRD_KINDS as readonly string[]).includes(r.kind as string) ? (r.kind as LowerThird['kind']) : null;
  const title = cleanLabel(r.title, 80);
  if (!kind || !title) return null;
  let until: number | null = null;
  if (r.until !== undefined && r.until !== null) {
    const u = Number(r.until);
    if (!Number.isFinite(u) || u <= programNow || u > programNow + LOWER_THIRD_MAX_MS) return null;
    until = u;
  }
  const sub = cleanLabel(r.sub, 120);
  return { id: r.id, kind, title, ...(sub ? { sub } : {}), until };
}

export function createProgramStore(deps: { db?: TokenDb | null; now?: () => number; log?: (line: string) => void } = {}): ProgramStore {
  const now = deps.now || Date.now;
  const log = deps.log || ((l: string) => console.log(l));
  const note = (event: string, extra: Record<string, unknown>) => {
    try { log(`[broadcast] ${JSON.stringify({ event, ...extra })}`); } catch { /* logging only */ }
  };
  const st = { loaded: 0, loadErrors: 0, saveErrors: 0, bindings: 0, onAirExpired: 0 };
  const controls = new Map<ChannelId, ChannelControl>();
  for (const channel of BROADCAST_CHANNELS) {
    controls.set(channel, {
      channel, stored: null, storedBy: null, scenePin: null, autoTable: true, lock: null, lowerThirds: [],
      feed: { mode: 'public', delayMs: 0 }, onAir: { on: false, rehearsal: false, since: null, by: null },
    });
  }
  const ctl = (channel: ChannelId): ChannelControl => controls.get(channel) as ChannelControl;

  return {
    control: ctl,

    bindingOf(channel) {
      const c = ctl(channel);
      return c.stored ?? channelDefaultBinding(channel);
    },

    async load() {
      if (!deps.db) return { loaded: 0 };
      try {
        const { rows } = await deps.db.query(`SELECT channel, event_key, updated_by FROM broadcast_channels`);
        let n = 0;
        for (const r of rows) {
          if (!(BROADCAST_CHANNELS as readonly string[]).includes(r.channel)) continue;
          const c = ctl(r.channel as ChannelId);
          // A binding set in this process before the load finished wins.
          if (c.storedBy !== null) continue;
          c.stored = typeof r.event_key === 'string' && r.event_key ? r.event_key : null;
          c.storedBy = r.updated_by ? String(r.updated_by) : 'db';
          n++;
        }
        st.loaded += n;
        return { loaded: n };
      } catch (e: any) {
        st.loadErrors++;
        const error = String(e?.message || e).slice(0, 160);
        note('broadcast_channels_load_failed', { error });
        return { loaded: 0, error };
      }
    },

    async setBinding(channel, eventKey, actor) {
      const c = ctl(channel);
      c.stored = eventKey;
      c.storedBy = actor;
      c.lock = null;   // a lock on the old event's table means nothing on the new one
      st.bindings++;
      if (!deps.db) return { persisted: false };
      try {
        await deps.db.query(
          `INSERT INTO broadcast_channels (channel, event_key, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
           ON CONFLICT (channel) DO UPDATE SET event_key = EXCLUDED.event_key, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
          [channel, eventKey, actor],
        );
        return { persisted: true };
      } catch (e: any) {
        st.saveErrors++;
        note('broadcast_channel_save_failed', { channel, error: String(e?.message || e).slice(0, 160) });
        return { persisted: false };
      }
    },

    pinScene(channel, id, params) {
      const c = ctl(channel);
      if (id === null) { c.scenePin = null; return; }
      c.scenePin = { id, ...(params ? { params } : {}), since: now() };
    },

    setAutoTable(channel, on) { ctl(channel).autoTable = on; },

    setLock(channel, lock) { ctl(channel).lock = lock; },

    lowerThird(channel, op, item, programNow) {
      const c = ctl(channel);
      if (op === 'hide') {
        const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
        if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, code: 'invalid_request' };
        c.lowerThirds = c.lowerThirds.filter((x) => x.id !== id);
        return { ok: true, lowerThirds: c.lowerThirds.slice() };
      }
      if (op !== 'show') return { ok: false, code: 'invalid_request' };
      const lt = cleanLowerThird(item, programNow);
      if (!lt) return { ok: false, code: 'invalid_request' };
      const rest = c.lowerThirds.filter((x) => x.id !== lt.id);
      rest.push(lt);
      c.lowerThirds = rest.slice(-LOWER_THIRDS_MAX);
      return { ok: true, lowerThirds: c.lowerThirds.slice() };
    },

    setFeedPublic(channel) { ctl(channel).feed = { mode: 'public', delayMs: 0 }; },

    setFeedDelayed(channel, delayMs) { ctl(channel).feed = { mode: 'delayed', delayMs: Math.max(HOLECARD_MIN_DELAY_MS, delayMs) }; },

    setOnAir(channel, on, rehearsal, actor) {
      const c = ctl(channel);
      c.onAir = on ? { on: true, rehearsal: !!rehearsal, since: now(), by: actor } : { on: false, rehearsal: false, since: null, by: null };
      return { ...c.onAir };
    },

    expire(channel, t, eventFinishedAt) {
      const c = ctl(channel);
      let onAirCleared: 'max_age' | 'event_finished' | null = null;
      if (c.onAir.on && c.onAir.since !== null) {
        if (t - c.onAir.since >= ON_AIR_MAX_MS) onAirCleared = 'max_age';
        // 2 h after the finish — or after going on air, for a producer who went on air for the results later.
        else if (eventFinishedAt !== null && t - Math.max(eventFinishedAt, c.onAir.since) >= ON_AIR_AFTER_FINISH_MS) onAirCleared = 'event_finished';
        if (onAirCleared) {
          c.onAir = { on: false, rehearsal: false, since: null, by: null };
          st.onAirExpired++;
          note('broadcast_on_air_expired', { channel, reason: onAirCleared });
        }
      }
      const before = c.lowerThirds.length;
      if (before > 0) c.lowerThirds = c.lowerThirds.filter((x) => x.until === null || x.until > t);
      if (c.lock && c.lock.until !== null && c.lock.until <= t) c.lock = null;
      return { onAirCleared, lowerThirdsDropped: before - c.lowerThirds.length };
    },

    applyTo(program, channel, auto) {
      const c = ctl(channel);
      const scene: ProgramState['scene'] = c.scenePin
        ? { id: c.scenePin.id, auto: false, since: c.scenePin.since, ...(c.scenePin.params ? { params: c.scenePin.params } : {}) }
        : { id: auto.sceneId, auto: true, since: auto.since };
      return {
        ...program,
        channel,
        onAir: c.onAir.on,
        rehearsal: c.onAir.on && c.onAir.rehearsal,
        scene,
        lowerThirds: c.lowerThirds.filter((x) => x.until === null || x.until > program.programNow).map((x) => ({ ...x })),
      };
    },

    stats() {
      const onAir: Record<string, boolean> = {};
      for (const [k, c] of controls) onAir[k] = c.onAir.on;
      return { ...st, onAir, minDelayMin: HOLECARD_MIN_DELAY_MS / 60_000 };
    },
  };
}
