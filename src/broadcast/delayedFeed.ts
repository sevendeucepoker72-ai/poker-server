/**
 * 2026-11-02 (.online tournament broadcast, P5-S5 / S4-delayed; owner
 * 2026-11-02) — THE DELAYED SESSIONS: who gets the delayed hole-card feed, and
 * how it is released to them. The buffer and the release rule are
 * holeCardDelay.ts; this module never reads a hole card itself.
 *
 * A DELAYED SESSION is a /broadcast socket whose key holds the 'delayed' scope
 * (minted only for a q: / t: event, by an issuer in BROADCAST_HOLECARD_ISSUERS,
 * while BROADCAST_HOLECARD_POLICY is not 'off'), subscribed to that event while
 * the producer switch is ON (bc:producer:holeCardsSwitch {on:true}, again only
 * from an allowlisted issuer; the switch starts OFF at every boot). The
 * subscription ARMS the event: from then on the wire records it into the
 * buffer. At most DELAYED_SESSIONS_PER_EVENT_MAX (4) per event; one live session
 * per key (jti) — a second one replaces the first (bc:sessionReplaced). Hold'em
 * and Omaha tables only (anything else: holecards_off).
 *
 * RELEASE: every HOLECARD_RELEASE_TICK_MS (250 ms) each session is RE-VALIDATED
 * (policy, switch, allowlisted issuer, its key not revoked / expired, the event
 * still armed, its issuer not an entrant — else bc:authExpired {code} and the
 * socket is dropped) and then gets, by DIRECT socket.emit (never a room: nothing
 * that iterates rooms can pick it up), everything the buffer recorded at or
 * before now - delay, in order: bc:frame {kind:'program'|'event'|'table'} with
 * its own seq, at the ORIGINAL time. Table frames are the delayed featured table
 * (as recorded, or the producer's bc:producer:delayedPin); a hand's hole cards
 * ride only under holeCardDelay.releaseTableFrame (its live end AND the delay),
 * and the frame on screen is sent again, face up, the moment its hand ends live.
 * bc:heartbeat every 2 s {programNow: serverNow - delayMs, delayMs}.
 *
 * The delay: env BROADCAST_HOLECARD_DELAY_MIN (5 by default, 5 at least), or a
 * longer one a producer set on a channel showing the event (bc:producer:setFeed
 * {mode:'delayed', delayMin}); a change re-sends the snapshot.
 *
 * KILL SWITCH: the producer switch off, POST /api/broadcast/holecards {on:0}, or
 * the whole feed off — every delayed session is dropped (bc:authExpired
 * 'holecards_off') and the buffer is wiped at once.
 */
import type { Socket } from 'socket.io';
import {
  BC_EVENTS, DELAYED_SESSIONS_PER_EVENT_MAX, HOLECARD_RETAIN_EXTRA_MS, HOLECARD_SWITCH_AUDIT,
  type BroadcastTableFrame, type ChannelId, type Feed, type ProgramState, type Snapshot, type TickerEvent,
} from './contract';
import type { ResolvedEvent } from './eventKey';
import type { TickerRecord } from './broadcastTicker';
import {
  clampHoleCardDelayMs, downgradeNames, holeCardVariantOk, releaseTableFrame,
  type HoleCardConfig, type HoleCardDelayBuffer, type HeldReason, type ProgramEntry, type TableEntry,
} from './holeCardDelay';

type Follow = 'program' | 'none' | { tableId: string };
type Issuer = { masterUserId: string | null; userId: number | null };

/** What the wire gives the delayed sessions. */
export interface DelayedHost {
  config: HoleCardConfig;
  buffer: HoleCardDelayBuffer;
  now(): number;
  socketOf(socketId: string): Socket | undefined;
  tokens: { stillValid(jti: string): { ok: true } | { ok: false; code: 'revoked' | 'expired' } };
  isEntrant(issuer: Issuer, ev: ResolvedEvent): boolean;
  liveTablesOf(ev: ResolvedEvent): string[];
  variantOf(tableId: string): string | undefined;
  /** The event's ticker so far (its byName pids are kept for release). */
  tickerOf(ev: ResolvedEvent): TickerRecord[];
  /** Start / stop RECORDING an event (the wire's recording program + its tables' frames). */
  startRecording(ev: ResolvedEvent): void;
  stopRecording(eventKey: string): void;
  /** The channel whose producer controls (scene pin, lower thirds, on air) apply to a delayed session. */
  controlChannelOf(ev: ResolvedEvent, subscribed: ChannelId | null): ChannelId | null;
  applyControls(program: ProgramState, channel: ChannelId): ProgramState;
  onAirOf(channel: ChannelId | null): boolean;
  /** The longest delay a producer set (setFeed delayed) on a channel showing the event; null = none. */
  channelDelayMs(eventKey: string): number | null;
  resolveTicker(ev: ResolvedEvent, rec: TickerRecord): TickerEvent | null;
  /** The pids of the event's entrants who are opted out (or unknown) NOW. */
  optedOutPids(ev: ResolvedEvent): Set<string>;
  eventFinishedAt(ev: ResolvedEvent): number | null;
  programSignature(p: ProgramState): string;
  frameSignature(f: BroadcastTableFrame): string;
  countRefusal(code: string): void;
  note(event: string, extra?: Record<string, unknown>): void;
  audit(actor: string, action: string, details: Record<string, unknown>): void;
}

interface Session {
  socketId: string;
  jti: string;
  eventKey: string;
  issuer: Issuer;
  subscribedChannel: ChannelId | null;
  layout: '16x9' | '9x16';
  role: 'viewer' | 'output';
  follow: Follow;
  delayMs: number;
  seq: number;
  /** Everything recorded at or before this (live) time has been sent. */
  cursorT: number;
  parked: boolean;
  program: ProgramEntry | null;
  lastProgramSig: string | null;
  lastProgramAt: number;
  tableId: string | null;
  /** The table frame on screen, and whether it went out face up. */
  /** settled: the release decision for it is final (faces merged, or allowed with nothing to merge): no re-release. */
  lastTable: { entry: TableEntry; faces: boolean; settled: boolean } | null;
}

export interface SubscribeDelayed {
  ev: ResolvedEvent;
  channel: ChannelId | null;
  layout: '16x9' | '9x16';
  role: 'viewer' | 'output';
  follow: Follow;
  jti: string;
  issuer: Issuer;
}

export type SwitchResult = { ok: true; on: boolean; previous: boolean; dropped: number } | { ok: false; code: 'holecards_off' | 'issuer_not_allowlisted' };
export type PinResult = { ok: true; tableId: string | null; events: string[] } | { ok: false; code: 'not_captured' | 'wrong_event' | 'producer_is_entrant' | 'table_not_in_event' };

export interface DelayedFeed {
  has(socketId: string): boolean;
  /** bc:subscribe from a 'delayed'-scope session: the ack. */
  subscribe(socket: Socket, req: SubscribeDelayed): Record<string, unknown>;
  resync(socket: Socket): void;
  leave(socket: Socket): void;
  /** The 250 ms release + re-validation. */
  releaseTick(): void;
  heartbeat(): void;
  /** The 1 s housekeeping: purge, disarm idle / ended events. */
  housekeeping(): void;
  switchOn(): boolean;
  setSwitch(on: boolean, actor: string, issuerMasterUserId: string | null, via: string): SwitchResult;
  pin(tableId: string | null, by: string, covers: (ev: ResolvedEvent) => boolean, entrantOf: (ev: ResolvedEvent) => boolean): PinResult;
  /** Every session dropped + every buffer wiped (the whole feed switched off). */
  reset(reason: string): void;
  sendCommand(channel: ChannelId, payload: { cmd: string; id: string }): void;
  outputs(channel?: ChannelId): number;
  delayMsFor(eventKey: string): number;
  stats(): Record<string, unknown>;
}

export function createDelayedFeed(host: DelayedHost): DelayedFeed {
  const cfg = host.config;
  const buffer = host.buffer;
  const sessions = new Map<string, Session>();
  const lastSessionAt = new Map<string, number>();
  let switchOn = false;
  let switchSince: number | null = null;
  let featuredSeq = 0;
  const st = {
    subscribes: 0, snapshots: 0, framesReleased: 0, facesReleased: 0, releaseStalls: 0, replaced: 0,
    sessionsDropped: 0, switchChanges: 0, releaseErrors: 0, dropped: {} as Record<string, number>,
  };

  const issuerOk = (m: string | null | undefined): boolean => !!m && cfg.issuers.has(m);
  const feedOf = (s: Session): Feed => ({ mode: 'delayed', delayMs: s.delayMs, holeCards: true, policy: cfg.policy });
  const controlOf = (s: Session): ChannelId | null => {
    const ev = buffer.eventOf(s.eventKey);
    return ev ? host.controlChannelOf(ev, s.subscribedChannel) : s.subscribedChannel;
  };

  function delayMsFor(eventKey: string): number {
    let ch: number | null = null;
    try { ch = host.channelDelayMs(eventKey); } catch { ch = null; }
    return clampHoleCardDelayMs(Math.max(cfg.defaultDelayMs, ch ?? 0));
  }

  function retentionMs(): number {
    let m = cfg.defaultDelayMs;
    for (const s of sessions.values()) if (s.delayMs > m) m = s.delayMs;
    for (const ek of buffer.armedEvents()) m = Math.max(m, delayMsFor(ek));
    return m + HOLECARD_RETAIN_EXTRA_MS;
  }

  // ---------------------------------------------------------------- per-tick caches (names, finish)
  let tickCache = new Map<string, { out: Set<string>; finished: boolean }>();
  function tickInfo(eventKey: string): { out: Set<string>; finished: boolean } {
    let c = tickCache.get(eventKey);
    if (c) return c;
    const ev = buffer.eventOf(eventKey);
    let out = new Set<string>();
    let finished = false;
    if (ev) {
      try { out = host.optedOutPids(ev); } catch { out = new Set(); }
      try { finished = host.eventFinishedAt(ev) !== null; } catch { finished = false; }
    }
    c = { out, finished };
    tickCache.set(eventKey, c);
    return c;
  }

  // ---------------------------------------------------------------- what a session shows
  /** The delayed feed's featured table at the session's time: the producer's pin (while in play then), else as recorded. */
  function delayedFeaturedOf(s: Session): string | null {
    if (!s.program) return null;
    const pin = buffer.pinOf(s.eventKey);
    if (pin && s.program.tables.some((x) => x.tableId === pin.tableId)) return pin.tableId;
    return s.program.program.featured.tableId;
  }

  /** The table whose frames the session gets: follow 'none' / a pinned table / the delayed featured table. */
  function targetOf(s: Session): string | null {
    if (s.follow === 'none' || !s.program) return null;
    if (typeof s.follow === 'object') {
      const want = s.follow.tableId;
      if (s.program.tables.some((x) => x.tableId === want)) return want;
    }
    return delayedFeaturedOf(s);
  }

  function programView(s: Session): ProgramState {
    const e = s.program as ProgramEntry;
    let p: ProgramState = e.program;
    const pin = buffer.pinOf(s.eventKey);
    if (pin && e.tables.some((x) => x.tableId === pin.tableId)) {
      const sum = e.tables.find((x) => x.tableId === pin.tableId);
      p = { ...p, featured: { tableId: pin.tableId, tableNo: sum ? sum.tableNo : null, tableName: sum ? sum.tableName : null, mode: 'producer', reason: 'producer', since: e.t } };
    }
    const ch = controlOf(s);
    if (ch) {
      try { p = host.applyControls(p, ch); } catch { /* the recorded program as is */ }
    }
    const info = tickInfo(s.eventKey);
    return downgradeNames({ ...p, programNow: e.t }, info.out, buffer.tickerBy(s.eventKey));
  }

  function release(s: Session, e: TableEntry, now: number): { frame: BroadcastTableFrame; faces: boolean; held: HeldReason } {
    const info = tickInfo(s.eventKey);
    const featured = delayedFeaturedOf(s);
    const r = releaseTableFrame(e.frame, buffer.hand(s.eventKey, e.tableId, e.handNumber), {
      now,
      delayMs: s.delayMs,
      policy: switchOn ? cfg.policy : 'off',
      show: cfg.show,
      tables: cfg.tables,
      featured: !!featured && featured === e.tableId,
      finalTable: !!s.program && s.program.program.featured.mode === 'final_table',
      eventFinished: info.finished,
    });
    return { ...r, frame: downgradeNames(r.frame, info.out, buffer.tickerBy(s.eventKey)) };
  }

  const emitTo = (s: Session, sock: Socket, msg: Record<string, unknown>) => {
    s.seq++;
    st.framesReleased++;
    sock.emit(BC_EVENTS.frame, { v: 1, seq: s.seq, ...msg });
  };

  function emitTable(s: Session, sock: Socket, e: TableEntry, now: number): void {
    const r = release(s, e, now);
    s.lastTable = { entry: e, faces: r.faces, settled: r.held === null };
    if (r.faces) st.facesReleased++;
    else if (r.held === 'hand_live') st.releaseStalls++;
    emitTo(s, sock, { at: e.t, kind: 'table', table: r.frame });
  }

  function emitProgramIfChanged(s: Session, sock: Socket, now: number): void {
    if (!s.program) return;
    s.lastProgramAt = now;
    const program = programView(s);
    const sig = host.programSignature(program);
    if (sig === s.lastProgramSig) return;
    s.lastProgramSig = sig;
    emitTo(s, sock, { at: s.program.t, kind: 'program', program });
  }

  /** A new table for the session: a 'featured' event, then that table's frame as it was at `at`. */
  function retarget(s: Session, sock: Socket, at: number, now: number): void {
    const want = targetOf(s);
    if (want === s.tableId) return;
    s.tableId = want;
    s.lastTable = null;
    if (!want) return;
    const sum = s.program?.tables.find((x) => x.tableId === want);
    const event: TickerEvent = { id: `d${(++featuredSeq).toString(36)}-${at.toString(36)}`, t: at, kind: 'featured', ...(sum && sum.tableNo !== null ? { tableNo: sum.tableNo } : {}) };
    emitTo(s, sock, { at, kind: 'event', event });
    const e = buffer.latestTable(s.eventKey, want, at);
    if (e) emitTable(s, sock, e, now);
  }

  /** The session's snapshot at its cursor (now - delay), or null: nothing that old recorded yet (parked). */
  function snapshotOf(s: Session, now: number): Snapshot | null {
    const due = now - s.delayMs;
    const p = buffer.latestProgram(s.eventKey, due);
    if (!p) return null;
    s.program = p;
    s.cursorT = due;
    s.tableId = targetOf(s);
    s.lastTable = null;
    let table: BroadcastTableFrame | null = null;
    if (s.tableId) {
      const e = buffer.latestTable(s.eventKey, s.tableId, due);
      if (e) {
        const r = release(s, e, now);
        table = r.frame;
        s.lastTable = { entry: e, faces: r.faces, settled: r.held === null };
        if (r.faces) st.facesReleased++;
      }
    }
    const program = programView(s);
    s.lastProgramSig = host.programSignature(program);
    s.lastProgramAt = now;
    st.snapshots++;
    return { v: 1, seq: s.seq, serverNow: now, feed: feedOf(s), program, table, tables: p.tables.map((x) => ({ ...x })) };
  }

  // ---------------------------------------------------------------- validation + drops
  function invalidOf(s: Session): string | null {
    if (cfg.policy === 'off' || !switchOn) return 'holecards_off';
    if (!issuerOk(s.issuer.masterUserId)) return 'holecards_off';
    const v = host.tokens.stillValid(s.jti);
    if (!v.ok) return v.code;
    if (!buffer.isArmed(s.eventKey)) return 'holecards_off';
    const ev = buffer.eventOf(s.eventKey);
    if (ev) {
      let entrant = false;
      try { entrant = host.isEntrant(s.issuer, ev); } catch { entrant = true; }   // fail closed: no cards
      if (entrant) return 'entrant';
    }
    return null;
  }

  function drop(s: Session, code: string, event: string = BC_EVENTS.authExpired): void {
    sessions.delete(s.socketId);
    st.sessionsDropped++;
    st.dropped[code] = (st.dropped[code] || 0) + 1;
    const sock = host.socketOf(s.socketId);
    if (!sock) return;
    try { sock.emit(event, event === BC_EVENTS.authExpired ? { code } : {}); } catch { /* gone */ }
    try { sock.disconnect(true); } catch { /* gone */ }
  }

  function disarm(eventKey: string, reason: string): void {
    buffer.disarm(eventKey, reason);
    lastSessionAt.delete(eventKey);
    try { host.stopRecording(eventKey); } catch { /* recording only */ }
  }

  // ---------------------------------------------------------------- the API
  function subscribe(socket: Socket, req: SubscribeDelayed): Record<string, unknown> {
    const t = host.now();
    const refuse = (code: string) => { host.countRefusal(code); return { ok: false, code }; };
    const ev = req.ev;
    if (cfg.policy === 'off' || !switchOn || !issuerOk(req.issuer.masterUserId) || !req.jti) return refuse('holecards_off');
    for (const tableId of host.liveTablesOf(ev)) {
      if (!holeCardVariantOk(host.variantOf(tableId))) {
        host.note('holecard_delay_refused', { eventKey: ev.key, reason: 'variant' });
        return refuse('holecards_off');
      }
    }
    // One live session per key: the newest replaces the old.
    for (const s of [...sessions.values()]) {
      if (s.jti === req.jti && s.socketId !== socket.id) { st.replaced++; drop(s, 'replaced', BC_EVENTS.sessionReplaced); }
    }
    let others = 0;
    for (const s of sessions.values()) if (s.eventKey === ev.key && s.socketId !== socket.id) others++;
    if (others >= DELAYED_SESSIONS_PER_EVENT_MAX) return refuse('too_many_sessions');
    const prev = sessions.get(socket.id);
    tickCache = new Map();   // the opt-outs as they are NOW (the release tick may not have run for a while)
    if (buffer.arm(ev, { ticker: host.tickerOf(ev) })) {
      try { host.startRecording(ev); } catch (e: any) { host.note('holecard_delay_record_failed', { error: String(e?.message || e).slice(0, 160) }); }
    }
    lastSessionAt.set(ev.key, t);
    const s: Session = {
      socketId: socket.id, jti: req.jti, eventKey: ev.key, issuer: req.issuer, subscribedChannel: req.channel,
      layout: req.layout, role: req.role, follow: req.follow, delayMs: delayMsFor(ev.key),
      seq: prev ? prev.seq : 0, cursorT: t, parked: false, program: null, lastProgramSig: null, lastProgramAt: 0,
      tableId: null, lastTable: null,
    };
    sessions.set(socket.id, s);
    st.subscribes++;
    const snap = snapshotOf(s, t);
    if (!snap) { s.parked = true; return { ok: false, code: 'event_not_found', parked: true }; }
    return { ok: true, snapshot: snap };
  }

  function releaseOne(s: Session, sock: Socket, t: number): void {
    const want = delayMsFor(s.eventKey);
    if (want !== s.delayMs) {
      // The delay changed (a producer's setFeed): the session starts again from its new cursor.
      s.delayMs = want;
      const snap = snapshotOf(s, t);
      s.parked = !snap;
      if (snap) sock.emit(BC_EVENTS.snapshot, snap);
      return;
    }
    if (s.parked) {
      const snap = snapshotOf(s, t);
      if (snap) { s.parked = false; sock.emit(BC_EVENTS.snapshot, snap); }
      return;
    }
    const due = t - s.delayMs;
    for (const e of buffer.entriesAfter(s.eventKey, s.cursorT, due)) {
      if (e.kind === 'program') {
        s.program = e;
        emitProgramIfChanged(s, sock, t);
        retarget(s, sock, e.t, t);
      } else if (e.kind === 'event') {
        const ev = buffer.eventOf(s.eventKey);
        const event = ev ? host.resolveTicker(ev, e.rec) : null;
        if (event) emitTo(s, sock, { at: e.rec.t, kind: 'event', event: downgradeNames(event, tickInfo(s.eventKey).out, buffer.tickerBy(s.eventKey)) });
      } else if (e.tableId === s.tableId) {
        emitTable(s, sock, e, t);
      }
    }
    if (due > s.cursorT) s.cursorT = due;
    // A pin set / released since (no recorded entry carries it), then the live controls (at most once a second).
    retarget(s, sock, s.cursorT, t);
    if (t - s.lastProgramAt >= 1000) emitProgramIfChanged(s, sock, t);
    // The frame on screen went out with backs and its hand has now ended live: the same frame, face up.
    if (s.lastTable && !s.lastTable.settled) {
      const r = release(s, s.lastTable.entry, t);
      if (r.held === null) s.lastTable.settled = true;
      if (r.faces) {
        s.lastTable = { entry: s.lastTable.entry, faces: true, settled: true };
        st.facesReleased++;
        emitTo(s, sock, { at: s.lastTable.entry.t, kind: 'table', table: r.frame });
      }
    }
  }

  function releaseTick(): void {
    if (sessions.size === 0) return;
    const t = host.now();
    tickCache = new Map();
    for (const s of [...sessions.values()]) {
      try {
        const sock = host.socketOf(s.socketId);
        if (!sock) { sessions.delete(s.socketId); continue; }
        const bad = invalidOf(s);
        if (bad) { drop(s, bad); continue; }
        releaseOne(s, sock, t);
      } catch (e: any) {
        st.releaseErrors++;
        host.note('holecard_delay_release_failed', { error: String(e?.message || e).slice(0, 160) });
      }
    }
  }

  function heartbeat(): void {
    if (sessions.size === 0) return;
    const t = host.now();
    for (const s of sessions.values()) {
      const sock = host.socketOf(s.socketId);
      if (!sock) continue;
      let onAir = false;
      try { onAir = host.onAirOf(controlOf(s)); } catch { onAir = false; }
      sock.emit(BC_EVENTS.heartbeat, { seq: s.seq, serverNow: t, programNow: t - s.delayMs, delayMs: s.delayMs, onAir });
    }
  }

  function housekeeping(): void {
    const armed = buffer.armedEvents();
    if (armed.length === 0) return;
    const t = host.now();
    const keep = retentionMs();
    buffer.purge(t, keep);
    for (const ek of armed) {
      let has = false;
      for (const s of sessions.values()) if (s.eventKey === ek) { has = true; break; }
      if (has) lastSessionAt.set(ek, t);
      const ev = buffer.eventOf(ek);
      let fin: number | null = null;
      try { fin = ev ? host.eventFinishedAt(ev) : null; } catch { fin = null; }
      if (fin !== null && t - fin >= keep) {
        for (const s of [...sessions.values()]) if (s.eventKey === ek) drop(s, 'expired');
        disarm(ek, 'event_end');
      } else if (!has && t - (lastSessionAt.get(ek) ?? t) >= keep) {
        disarm(ek, 'idle');
      }
    }
  }

  function setSwitch(on: boolean, actor: string, issuerMasterUserId: string | null, via: string): SwitchResult {
    const previous = switchOn;
    if (on) {
      if (cfg.policy === 'off') return { ok: false, code: 'holecards_off' };
      if (!issuerOk(issuerMasterUserId)) return { ok: false, code: 'issuer_not_allowlisted' };
      switchOn = true;
      if (!previous) { switchSince = host.now(); st.switchChanges++; }
      host.audit(actor, HOLECARD_SWITCH_AUDIT, { on: true, previous, via, policy: cfg.policy });
      host.note('holecard_switch_set', { on: true, previous, via });
      return { ok: true, on: true, previous, dropped: 0 };
    }
    switchOn = false;
    switchSince = null;
    if (previous) st.switchChanges++;
    let dropped = 0;
    for (const s of [...sessions.values()]) { drop(s, 'holecards_off'); dropped++; }
    for (const ek of buffer.armedEvents()) disarm(ek, 'switch_off');
    host.audit(actor, HOLECARD_SWITCH_AUDIT, { on: false, previous, via, dropped });
    host.note('holecard_switch_set', { on: false, previous, via, dropped });
    return { ok: true, on: false, previous, dropped };
  }

  function pin(tableId: string | null, by: string, covers: (ev: ResolvedEvent) => boolean, entrantOf: (ev: ResolvedEvent) => boolean): PinResult {
    if (tableId === null) {
      const events: string[] = [];
      for (const ek of buffer.armedEvents()) {
        const ev = buffer.eventOf(ek);
        if (ev && covers(ev) && buffer.pinOf(ek)) { buffer.setPin(ek, null); events.push(ek); }
      }
      return { ok: true, tableId: null, events };
    }
    const ek = buffer.eventOfTable(tableId);
    const ev = ek ? buffer.eventOf(ek) : null;
    if (!ek || !ev) return { ok: false, code: 'not_captured' };
    if (!covers(ev)) return { ok: false, code: 'wrong_event' };
    if (entrantOf(ev)) return { ok: false, code: 'producer_is_entrant' };
    if (!host.liveTablesOf(ev).includes(tableId)) return { ok: false, code: 'table_not_in_event' };
    buffer.setPin(ek, { tableId, at: host.now(), by });
    return { ok: true, tableId, events: [ek] };
  }

  return {
    has: (socketId) => sessions.has(socketId),
    subscribe,
    resync(socket) {
      const s = sessions.get(socket.id);
      if (!s) return;
      tickCache = new Map();
      const snap = snapshotOf(s, host.now());
      s.parked = !snap;
      if (snap) socket.emit(BC_EVENTS.snapshot, snap);
    },
    leave(socket) {
      const s = sessions.get(socket.id);
      if (!s) return;
      sessions.delete(socket.id);
      lastSessionAt.set(s.eventKey, host.now());
    },
    releaseTick,
    heartbeat,
    housekeeping,
    switchOn: () => switchOn,
    setSwitch,
    pin,
    reset(reason) {
      // Review fix (2026-11-02) — a reset (the whole feed off) also latches the switch OFF:
      // hole cards come back only through setSwitch(true) from an allowlisted issuer.
      if (switchOn) { switchOn = false; switchSince = null; st.switchChanges++; }
      for (const s of [...sessions.values()]) drop(s, 'holecards_off');
      sessions.clear();
      for (const ek of buffer.armedEvents()) disarm(ek, reason);
    },
    sendCommand(channel, payload) {
      for (const s of sessions.values()) {
        if (controlOf(s) !== channel) continue;
        try { host.socketOf(s.socketId)?.emit(BC_EVENTS.command, payload); } catch { /* gone */ }
      }
    },
    outputs(channel) {
      let n = 0;
      for (const s of sessions.values()) if (s.role === 'output' && (channel === undefined || controlOf(s) === channel)) n++;
      return n;
    },
    delayMsFor,
    /** Counts only (never a card, a key or an id). */
    stats() {
      const events = new Set<string>();
      let parked = 0;
      for (const s of sessions.values()) { events.add(s.eventKey); if (s.parked) parked++; }
      return { switchOn, switchSince, sessions: sessions.size, parked, events: events.size, ...st, dropped: { ...st.dropped } };
    },
  };
}
