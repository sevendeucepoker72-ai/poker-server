/**
 * 2026-11-02 (.online tournament broadcast, P2-S9) — THE PRODUCER API on
 * /broadcast (spec §3 "Producer events"): the poker-3d producer panel drives a
 * channel's program with these. Every call needs a session holding the
 * 'producer' scope (a token minted by a signed-in admin: 'broadcastIssueToken'
 * {ev:'ch:*', scopes:['producer']}); anything else is answered 'not_producer'.
 * A producer key bound to one channel / event drives only that ('wrong_event');
 * an issuer registered in the channel's event is refused 'producer_is_entrant'
 * (owner rule: streamers may not play an event they broadcast).
 *
 *   hello {}                          → {ok, channels:ChannelSummary[], events:EventSummary[]}
 *   watch {channel}                   → {ok}; then bc:producer:state at most twice a second
 *   setEvent {channel, event|null}    bind the channel (persisted; null = the default)
 *   setScene {channel, scene, params?} pin a scene (auto off)
 *   setAuto {channel, scene?, table?} auto scenes / auto featured table on or off
 *   feature {channel, tableId|null, lockMinutes?:0..240}  lock / release the featured table
 *   lowerThird {channel, op:'show'|'hide', item}
 *   setFeed {channel, mode, delayMin} 'public', or 'delayed' (P5): the delay of the channel's
 *                                     DELAYED sessions (delay_below_minimum under 5 min;
 *                                     holecards_off while the policy is 'off'; at most 240)
 *   onAir {channel, onAir, rehearsal} the producer's on-air toggle (auto-clears)
 *   command {channel, cmd:'reload'|'identify'} → bc:command to the channel's sources
 *   mintKey {ev, scopes, label, ttlHours<=12, notBefore?} → {ok, token (shown once), jti, scopes, nbf, exp}
 *                                     'output' keys (a producer key cannot mint a producer key:
 *                                     'scope_not_allowed'; 'delayed' (P5): holecards_off while the
 *                                     policy is 'off', issuer_not_allowlisted unless the key's
 *                                     issuer is in BROADCAST_HOLECARD_ISSUERS)
 *   revokeKey {jti, withChildren?}    → {ok}; every session on it is dropped (bc:authExpired); withChildren:
 *                                     also every key minted from it (review fix). Only keys the caller
 *                                     covers ('ch:*' all; else its own, its children, its channel's / event's)
 *   listKeys {ev?}                    → {ok, keys:[{jti, label, scopes, nbf, exp, revoked, connected,
 *                                     parentJti, children}]} (never a token; only keys the caller covers)
 *   delayedPin {tableId|null}         P5: the table the DELAYED feed shows (and the only one whose
 *                                     hole cards it releases) for that table's armed event;
 *                                     null = back to the recorded featured table (not_captured:
 *                                     no armed event has the table; table_not_in_event)
 *   holeCardsSwitch {on}              P5: on needs the policy (holecards_off) AND this key's issuer
 *                                     in BROADCAST_HOLECARD_ISSUERS (issuer_not_allowlisted); off
 *                                     (any producer) drops every delayed session + wipes the buffer.
 *                                     Audited BROADCAST_HOLECARDS_SET (durable) as well.
 * P6 (recapHands) is not registered here.
 *
 * Every successful mutation is written to auditLog as BROADCAST_PRODUCER_ACTION
 * (keys: BROADCAST_TOKEN_ISSUED / BROADCAST_TOKEN_REVOKED), actor 'user:<local id>'
 * of the key's issuer. Calls are rate-limited per socket. A producer never receives
 * a hole card: everything it reads is public-feed data.
 */
import type { Socket } from 'socket.io';
import { createWindowRateLimiter, type WindowRateLimiter } from '../auth/rateLimit';
import {
  BROADCAST_CHANNELS, BROADCAST_PRODUCER_AUDIT, FEATURE_LOCK_MAX_MINUTES, HOLECARD_MIN_DELAY_MS, PRODUCER_EVENTS,
  type ChannelId, type ChannelSummary, type EventSummary, type HoleCardPolicy, type SceneId,
} from './contract';
import { clampHoleCardDelayMs } from './holeCardDelay';
import type { PinResult, SwitchResult } from './delayedFeed';
import { parseEventKey, resolveEventKey, type EventWorld, type ResolvedEvent } from './eventKey';
import { cleanSceneParams, SCENE_IDS, type ProgramStore } from './programStore';
import {
  BROADCAST_TOKEN_AUDIT_REVOKED, parseTokenEv,
  type IssueResult, type MintIssuer, type MintRequest, type TokenClaims, type TokenRegistry, type TokenRow,
} from './broadcastToken';

export interface ProducerSession {
  scopes: readonly string[];
  claims: TokenClaims | null;
  row: TokenRow | null;
}

/** What the wire gives the producer API. */
export interface ProducerHost {
  world: EventWorld;
  store: ProgramStore;
  tokens: TokenRegistry | null;
  now(): number;
  policy(): HoleCardPolicy;
  sessionOf(socket: Socket): ProducerSession | null;
  /** The event a channel shows right now (null = unbound / nothing to show). */
  channelEvent(channel: ChannelId): ResolvedEvent | null;
  isEntrant(issuer: { masterUserId: string | null; userId: number | null }, ev: ResolvedEvent): boolean;
  /** The event's tables in play (the featured-table candidates). */
  liveTablesOf(ev: ResolvedEvent): string[];
  /** What the channel shows now: its scene id (setAuto {scene:false} pins it). */
  currentSceneOf(channel: ChannelId): SceneId;
  channelSummaries(): ChannelSummary[];
  events(): EventSummary[];
  /** Start (channel) or stop (null) pushing bc:producer:state to this socket. */
  watch(socket: Socket, channel: ChannelId | null): void;
  /** The channel's program changed (the next flush rebuilds it; featured: re-run the recommender now). */
  programChanged(channel: ChannelId, opts?: { featured?: boolean }): void;
  /** bc:command to every source of the channel; returns the command id. */
  sendCommand(channel: ChannelId, cmd: 'reload' | 'identify'): string;
  /** The minting path broadcastIssueToken uses (event, entrant and scope rules). */
  mint(req: MintRequest, issuer: MintIssuer): Promise<IssueResult>;
  /** Drop every /broadcast session on a jti (bc:authExpired {code}). */
  dropSessionsOf(jti: string, code: 'revoked' | 'expired'): number;
  connectedOf(jti: string): number;
  audit(actor: string, action: string, details: Record<string, unknown>): void;
  note(event: string, extra?: Record<string, unknown>): void;
  /** 2026-11-02 (P5) — the delayed hole-card feed (absent = every P5 call answers holecards_off). */
  delayedCards?: {
    status(): Record<string, unknown>;
    setSwitch(on: boolean, actor: string, issuerMasterUserId: string | null): SwitchResult;
    pin(tableId: string | null, by: string, covers: (ev: ResolvedEvent) => boolean, entrantOf: (ev: ResolvedEvent) => boolean): PinResult;
  };
}

const TABLE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

type Reply = Record<string, unknown> & { ok: boolean };
const refused = (code: string, extra: Record<string, unknown> = {}): Reply => ({ ok: false, code, ...extra });

export interface ProducerStats { calls: number; refusals: Record<string, number>; mutations: number }

/** One namespace-wide set: calls per socket (40 / 10 s), keys minted per issuer (30 / hour: each is a DB row). */
export function createProducerLimiters(): { calls: WindowRateLimiter; mint: WindowRateLimiter } {
  return { calls: createWindowRateLimiter(40, 10_000), mint: createWindowRateLimiter(30, 60 * 60_000) };
}

/** Producer handlers on one /broadcast socket. Registered for every socket; the scope is checked per call. */
export function attachProducerHandlers(socket: Socket, host: ProducerHost, stats: ProducerStats, limiters = createProducerLimiters()): void {
  const limiter = limiters.calls;
  const actorOf = (s: ProducerSession): string => (s.row && s.row.issuedByUser !== null ? `user:${s.row.issuedByUser}` : `bcast:${String(s.claims?.jti || '').slice(0, 8)}`);
  const issuerOf = (s: ProducerSession) => ({ masterUserId: s.row?.issuedByMaster ?? s.claims?.iss_m ?? null, userId: s.row?.issuedByUser ?? null });

  /** May this producer key drive `channel`? 'ch:*' any; 'ch:<c>' that one; q: / t: the channel showing that event. */
  const keyCovers = (s: ProducerSession, channel: ChannelId): boolean => {
    const ev = s.claims?.ev || '';
    if (ev === 'ch:*' || ev === `ch:${channel}`) return true;
    const p = parseTokenEv(ev);
    if (!p || p.kind === 'ch') return false;
    const want = resolveEventKey(host.world, ev);
    const have = host.channelEvent(channel);
    return want.ok && !!have && want.ev.key === have.key;
  };

  /** P5: may this producer key act on `ev` (delayedPin)? 'ch:*' any; 'ch:<c>' the event that channel shows; q: / t: its own. */
  const keyCoversEvent = (s: ProducerSession, ev: ResolvedEvent): boolean => {
    const own = s.claims?.ev || '';
    if (own === 'ch:*') return true;
    const p = parseTokenEv(own);
    if (!p) return false;
    if (p.kind === 'ch') { const have = host.channelEvent(p.channel as ChannelId); return !!have && have.key === ev.key; }
    const want = resolveEventKey(host.world, own);
    return want.ok && want.ev.key === ev.key;
  };

  /**
   * Review fix (2026-11-02) — the keys a producer key may LIST and REVOKE: 'ch:*' all; any
   * other producer key only its own, the keys it minted, and keys bound to what it may drive
   * (its channel / event, or the event of a channel it covers). Never a 'ch:*' panel key.
   */
  const keyCoversRow = (s: ProducerSession, row: TokenRow): boolean => {
    const own = s.claims?.ev || '';
    if (own === 'ch:*') return true;
    if (s.claims && (row.jti === s.claims.jti || row.parentJti === s.claims.jti)) return true;
    const p = parseTokenEv(row.ev);
    if (!p) return false;
    if (p.kind === 'ch') return p.channel !== '*' && keyCovers(s, p.channel as ChannelId);
    if (row.ev === own) return true;
    const r = resolveEventKey(host.world, row.ev);
    return r.ok && keyCoversEvent(s, r.ev);
  };

  const channelOf = (d: Record<string, unknown>): ChannelId | null =>
    (BROADCAST_CHANNELS as readonly string[]).includes(d.channel as string) ? (d.channel as ChannelId) : null;

  /** The common gate of a channel call: known channel, covered by the key, issuer not an entrant of its event. */
  const gateChannel = (s: ProducerSession, d: Record<string, unknown>): { channel: ChannelId; ev: ResolvedEvent | null } | Reply => {
    const channel = channelOf(d);
    if (!channel) return refused('channel_unknown');
    if (!keyCovers(s, channel)) return refused('wrong_event');
    const ev = host.channelEvent(channel);
    if (ev && host.isEntrant(issuerOf(s), ev)) return refused('producer_is_entrant');
    return { channel, ev };
  };
  const isReply = (x: unknown): x is Reply => !!x && typeof x === 'object' && 'ok' in (x as object);

  const audit = (s: ProducerSession, action: string, details: Record<string, unknown>) => {
    stats.mutations++;
    try { host.audit(actorOf(s), BROADCAST_PRODUCER_AUDIT, { action, ...details, jti: s.claims?.jti ?? null }); } catch { /* audit is best effort */ }
  };

  const on = (event: string, fn: (d: Record<string, unknown>, s: ProducerSession) => Reply | Promise<Reply>) => {
    socket.on(event, async (data: Record<string, unknown>, ack?: (r: unknown) => void) => {
      const answer = (r: Reply) => {
        if (!r.ok) stats.refusals[String(r.code)] = (stats.refusals[String(r.code)] || 0) + 1;
        if (typeof ack === 'function') ack(r);
      };
      stats.calls++;
      const s = host.sessionOf(socket);
      if (!s || !s.scopes.includes('producer')) return answer(refused('not_producer'));
      // Re-checked on every call: a key revoked / expired since the handshake drives nothing.
      if (s.claims && host.tokens) {
        const v = host.tokens.stillValid(s.claims.jti);
        if (!v.ok) return answer(refused('not_producer'));
      }
      if (!limiter.hit(socket.id)) return answer(refused('rate_limited'));
      answer(await fn(data && typeof data === 'object' ? data : {}, s));
    });
  };

  on(PRODUCER_EVENTS.hello, () => ({
    ok: true, channels: host.channelSummaries(), events: host.events(),
    // P5 — the hole-card policy / switch / delay as counts and settings (never a card).
    delayed: host.delayedCards ? host.delayedCards.status() : { policy: host.policy(), on: false },
  }));

  on(PRODUCER_EVENTS.watch, (d, s) => {
    if (d.channel === null) { host.watch(socket, null); return { ok: true, channel: null }; }
    const g = gateChannel(s, d);
    if (isReply(g)) return g;
    host.watch(socket, g.channel);
    return { ok: true, channel: g.channel };
  });

  on(PRODUCER_EVENTS.setEvent, async (d, s) => {
    const channel = channelOf(d);
    if (!channel) return refused('channel_unknown');
    if (!keyCovers(s, channel)) return refused('wrong_event');
    let stored: string | null = null;
    let ev: ResolvedEvent | null = null;
    if (d.event !== null && d.event !== undefined && d.event !== '') {
      if (!parseEventKey(d.event)) return refused('event_not_found');
      const r = resolveEventKey(host.world, String(d.event));
      if (!r.ok) return refused(r.code);
      stored = String(d.event);
      ev = r.ev;
      // A key bound to one event cannot bind its channel to another.
      const p = parseTokenEv(s.claims?.ev);
      if (p && p.kind !== 'ch') {
        const own = resolveEventKey(host.world, String(s.claims?.ev));
        if (!own.ok || own.ev.key !== ev.key) return refused('wrong_event');
      }
      if (host.isEntrant(issuerOf(s), ev)) return refused('producer_is_entrant');
    }
    const previous = host.store.bindingOf(channel);
    const { persisted } = await host.store.setBinding(channel, stored, actorOf(s));
    audit(s, 'setEvent', { channel, previous, binding: stored, eventKey: ev ? ev.key : null, persisted });
    host.programChanged(channel, { featured: true });
    return { ok: true, channel, binding: host.store.bindingOf(channel), eventKey: ev ? ev.key : (host.channelEvent(channel)?.key ?? null), persisted };
  });

  on(PRODUCER_EVENTS.setScene, (d, s) => {
    const g = gateChannel(s, d);
    if (isReply(g)) return g;
    const scene = d.scene as SceneId;
    // 'recap' plays the cards-up replays (P6): not in this build.
    if (!SCENE_IDS.includes(scene) || scene === 'recap') return refused('scene_not_allowed');
    const params = cleanSceneParams(d.params);
    if (params === null) return refused('invalid_request');
    host.store.pinScene(g.channel, scene, params);
    audit(s, 'setScene', { channel: g.channel, scene });
    host.programChanged(g.channel);
    return { ok: true, channel: g.channel, scene, auto: false };
  });

  on(PRODUCER_EVENTS.setAuto, (d, s) => {
    const g = gateChannel(s, d);
    if (isReply(g)) return g;
    const sceneAuto = typeof d.scene === 'boolean' ? d.scene : undefined;
    const tableAuto = typeof d.table === 'boolean' ? d.table : undefined;
    if (sceneAuto === undefined && tableAuto === undefined) return refused('invalid_request');
    if (sceneAuto === true) host.store.pinScene(g.channel, null);
    // Auto scenes off: the scene on screen now stays (pinned).
    if (sceneAuto === false && !host.store.control(g.channel).scenePin) host.store.pinScene(g.channel, host.currentSceneOf(g.channel));
    if (tableAuto !== undefined) host.store.setAutoTable(g.channel, tableAuto);
    audit(s, 'setAuto', { channel: g.channel, ...(sceneAuto !== undefined ? { scene: sceneAuto } : {}), ...(tableAuto !== undefined ? { table: tableAuto } : {}) });
    host.programChanged(g.channel, { featured: tableAuto !== undefined });
    const c = host.store.control(g.channel);
    return { ok: true, channel: g.channel, scene: !c.scenePin, table: c.autoTable };
  });

  on(PRODUCER_EVENTS.feature, (d, s) => {
    const g = gateChannel(s, d);
    if (isReply(g)) return g;
    if (d.tableId === null || d.tableId === undefined) {
      host.store.setLock(g.channel, null);
      audit(s, 'feature', { channel: g.channel, tableId: null });
      host.programChanged(g.channel, { featured: true });
      return { ok: true, channel: g.channel, tableId: null, mode: 'auto', lockedUntil: null };
    }
    if (!g.ev) return refused('event_not_found');
    const tableId = String(d.tableId);
    if (!host.liveTablesOf(g.ev).includes(tableId)) return refused('table_not_in_event');
    let minutes = 0;
    if (d.lockMinutes !== undefined && d.lockMinutes !== null) {
      minutes = Number(d.lockMinutes);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > FEATURE_LOCK_MAX_MINUTES) return refused('invalid_request');
    }
    const until = minutes > 0 ? host.now() + minutes * 60_000 : null;
    host.store.setLock(g.channel, { tableId, until, by: actorOf(s) });
    audit(s, 'feature', { channel: g.channel, tableId, lockMinutes: minutes });
    host.programChanged(g.channel, { featured: true });
    return { ok: true, channel: g.channel, tableId, mode: 'producer', lockedUntil: until };
  });

  on(PRODUCER_EVENTS.lowerThird, (d, s) => {
    const g = gateChannel(s, d);
    if (isReply(g)) return g;
    const r = host.store.lowerThird(g.channel, d.op, d.item, host.now());
    if (!r.ok) return refused(r.code);
    const id = d.item && typeof d.item === 'object' ? (d.item as { id?: unknown }).id : undefined;
    audit(s, 'lowerThird', { channel: g.channel, op: d.op, id: typeof id === 'string' ? id : null });
    host.programChanged(g.channel);
    return { ok: true, channel: g.channel, lowerThirds: r.lowerThirds };
  });

  on(PRODUCER_EVENTS.setFeed, (d, s) => {
    const g = gateChannel(s, d);
    if (isReply(g)) return g;
    if (d.mode === 'public') {
      host.store.setFeedPublic(g.channel);
      audit(s, 'setFeed', { channel: g.channel, mode: 'public' });
      host.programChanged(g.channel);
      return { ok: true, channel: g.channel, mode: 'public', delayMs: 0 };
    }
    if (d.mode !== 'delayed') return refused('invalid_request');
    const delayMin = Number(d.delayMin);
    if (!Number.isFinite(delayMin) || delayMin * 60_000 < HOLECARD_MIN_DELAY_MS) return refused('delay_below_minimum', { minDelayMin: HOLECARD_MIN_DELAY_MS / 60_000 });
    // P5 (built dark): no delayed feed while the policy is 'off'.
    if (host.policy() === 'off' || !host.delayedCards) return refused('holecards_off', { policy: host.policy() });
    // Owner 2026-11-02: 5 minutes at least (the floor above), configurable upward (at most 240).
    const delayMs = clampHoleCardDelayMs(delayMin * 60_000);
    host.store.setFeedDelayed(g.channel, delayMs);
    audit(s, 'setFeed', { channel: g.channel, mode: 'delayed', delayMs });
    host.programChanged(g.channel);
    return { ok: true, channel: g.channel, mode: 'delayed', delayMs };
  });

  // ---------------------------------------------------------------- P5: the delayed hole-card feed
  on(PRODUCER_EVENTS.holeCardsSwitch, (d, s) => {
    if (typeof d.on !== 'boolean') return refused('invalid_request');
    if (!host.delayedCards) return refused('holecards_off', { policy: host.policy() });
    // On: the policy AND an allowlisted issuer (this key's). Off: any producer (the kill switch).
    const r = host.delayedCards.setSwitch(d.on, actorOf(s), issuerOf(s).masterUserId);
    if (!r.ok) return refused(r.code, { policy: host.policy() });
    audit(s, 'holeCardsSwitch', { on: r.on, previous: r.previous, dropped: r.dropped });
    return { ok: true, on: r.on, policy: host.policy(), dropped: r.dropped };
  });

  on(PRODUCER_EVENTS.delayedPin, (d, s) => {
    if (!host.delayedCards || host.policy() === 'off') return refused('holecards_off', { policy: host.policy() });
    let tableId: string | null;
    if (d.tableId === null || d.tableId === undefined || d.tableId === '') tableId = null;
    else if (typeof d.tableId === 'string' && TABLE_ID_RE.test(d.tableId)) tableId = d.tableId;
    else return refused('invalid_request');
    const r = host.delayedCards.pin(tableId, actorOf(s), (ev) => keyCoversEvent(s, ev), (ev) => host.isEntrant(issuerOf(s), ev));
    if (!r.ok) return refused(r.code);
    audit(s, 'delayedPin', { tableId, events: r.events });
    return { ok: true, tableId: r.tableId, events: r.events };
  });

  on(PRODUCER_EVENTS.onAir, (d, s) => {
    const g = gateChannel(s, d);
    if (isReply(g)) return g;
    if (typeof d.onAir !== 'boolean') return refused('invalid_request');
    const r = host.store.setOnAir(g.channel, d.onAir, d.rehearsal === true, actorOf(s));
    audit(s, 'onAir', { channel: g.channel, onAir: r.on, rehearsal: r.rehearsal, eventKey: g.ev ? g.ev.key : null });
    host.programChanged(g.channel);
    return { ok: true, channel: g.channel, onAir: r.on, rehearsal: r.rehearsal, since: r.since };
  });

  on(PRODUCER_EVENTS.command, (d, s) => {
    const g = gateChannel(s, d);
    if (isReply(g)) return g;
    if (d.cmd !== 'reload' && d.cmd !== 'identify') return refused('invalid_request');
    const id = host.sendCommand(g.channel, d.cmd);
    audit(s, 'command', { channel: g.channel, cmd: d.cmd, id });
    return { ok: true, channel: g.channel, cmd: d.cmd, id };
  });

  on(PRODUCER_EVENTS.mintKey, async (d, s) => {
    if (!host.tokens || !host.tokens.secretConfigured()) return refused('secret_unset');
    const scopes = Array.isArray(d.scopes) ? d.scopes : [];
    // A producer key never mints a producer key (a leaked panel key must not renew itself).
    if (scopes.includes('producer')) return refused('scope_not_allowed');
    // A key bound to one channel / event mints keys for that only.
    const own = s.claims?.ev || '';
    if (own !== 'ch:*' && d.ev !== own) return refused('wrong_event');
    const issuer = issuerOf(s);
    if (!limiters.mint.hit(issuer.userId !== null ? `u:${issuer.userId}` : `j:${s.claims?.jti ?? socket.id}`)) return refused('rate_limited');
    // Review fix: the child is bound to THIS key (capped at its exp, revoked with it, audited with its jti).
    const r = await host.mint(
      { ev: d.ev, scopes, label: d.label, ttlHours: d.ttlHours, notBefore: d.notBefore },
      { ...issuer, username: actorOf(s), parent: s.claims ? { jti: s.claims.jti } : null },
    );
    if (!r.ok) return refused(r.code === 'issuer_is_entrant' ? 'producer_is_entrant' : r.code);
    stats.mutations++;   // the mint path audits BROADCAST_TOKEN_ISSUED itself
    return { ...r };
  });

  on(PRODUCER_EVENTS.revokeKey, async (d, s) => {
    if (!host.tokens) return refused('secret_unset');
    const target = typeof d.jti === 'string' ? host.tokens.row(d.jti) : undefined;
    if (!target) return refused('invalid_request');
    if (!keyCoversRow(s, target)) return refused('wrong_event');
    // withChildren: also every key minted from it (a leaked panel key: its OBS / delayed keys).
    // Not by default: the panel retires its own key on Close / renewal, and its OBS keys stay.
    const { row, persisted, children } = await host.tokens.revoke(target.jti, { cascade: d.withChildren === true });
    // The key's sessions AND those of every key revoked with it. The CALLER's own key (the panel
    // retiring its key on Close / renewal): answered first, its sessions dropped right after
    // (they used to be dropped before the ack, so the panel never heard "ok").
    let dropped: number;
    if (s.claims && s.claims.jti === target.jti) {
      dropped = host.connectedOf(target.jti);
      setImmediate(() => { try { host.dropSessionsOf(target.jti, 'revoked'); } catch { /* gone */ } });
    } else dropped = host.dropSessionsOf(target.jti, 'revoked');
    for (const c of children) dropped += host.dropSessionsOf(c, 'revoked');
    stats.mutations++;
    try {
      host.audit(actorOf(s), BROADCAST_TOKEN_AUDIT_REVOKED, { jti: target.jti, ev: row?.ev ?? null, scopes: row?.scopes ?? [], dropped, persisted, children, byJti: s.claims?.jti ?? null });
    } catch { /* audit is best effort */ }
    return { ok: true, jti: target.jti, dropped, persisted, ...(children.length > 0 ? { children: children.length } : {}) };
  });

  on(PRODUCER_EVENTS.listKeys, (d, s) => {
    if (!host.tokens) return { ok: true, keys: [] };
    const ev = typeof d.ev === 'string' && d.ev ? d.ev : undefined;
    const keys = host.tokens.list(ev).filter((r) => keyCoversRow(s, r)).map((r) => ({
      jti: r.jti, ev: r.ev, label: r.label, scopes: r.scopes.slice(), nbf: r.nbf, exp: r.exp,
      revoked: r.revokedAt !== null, connected: host.connectedOf(r.jti),
      // Review fix: the key it was minted from (null = an admin's own), and how many live keys it made.
      parentJti: r.parentJti, children: host.tokens ? host.tokens.childrenOf(r.jti).length : 0,
    }));
    return { ok: true, keys };
  });
}
