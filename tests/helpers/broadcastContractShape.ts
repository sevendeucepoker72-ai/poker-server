/**
 * 2026-11-02 (.online tournament broadcast, P2-S7a) — the SHAPE of the wire
 * contract v1 as the broadcast page checks it: a port of poker-3d's
 * tests/broadcast/helpers/contractShape.mjs (the page's node:test copy of §3,
 * plus `liveHandEndedAt`). The recorded fixtures (tests/fixtures/broadcast/*.json)
 * must pass it here, so they pass it there once copied into
 * src/broadcast/dev/fixtures/. Returns the problems ([] = the payload matches).
 */
import { BROADCAST_LEGAL_LINE, HOLECARD_MIN_DELAY_MS, TICKER_KINDS } from '../../src/broadcast/contract';

const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isInt = Number.isInteger;
const isStr = (v: unknown) => typeof v === 'string';
const nullOr = (pred: (v: any) => boolean) => (v: unknown) => v === null || pred(v);
const SCENES = ['starting', 'table', 'break', 'hfh', 'finalIntro', 'results', 'slate', 'recap', 'room'];
const STATUSES = ['scheduled', 'registering', 'tables_open', 'running', 'finished', 'cancelled'];
const FEATURED_MODES = ['auto', 'producer', 'final_table'];
/** Keys no broadcast payload may ever carry (§3 "No payload ever carries …"). */
export const FORBIDDEN_KEYS = ['playerId', 'masterUserId', 'userId', 'publicId', 'seed', 'deck', 'burn', 'burnCards', 'playerName', 'yourCards', 'yourSeat'];

function need(errs: string[], path: string, ok: boolean) { if (!ok) errs.push(path); }
export const cardOk = (c: any) => isObj(c) && isInt(c.rank) && c.rank >= 2 && c.rank <= 14 && isInt(c.suit) && c.suit >= 0 && c.suit <= 3;

export function checkFeed(feed: any, path = 'feed'): string[] {
  const e: string[] = [];
  need(e, path, isObj(feed));
  if (!isObj(feed)) return e;
  need(e, `${path}.mode`, ['public', 'delayed'].includes(feed.mode));
  need(e, `${path}.delayMs`, isNum(feed.delayMs));
  need(e, `${path}.holeCards`, typeof feed.holeCards === 'boolean');
  need(e, `${path}.policy`, ['off', 'after_event', 'delayed'].includes(feed.policy));
  if (feed.holeCards === true) need(e, `${path}.holeCards needs delayed >= 5 min`, feed.mode === 'delayed' && feed.delayMs >= HOLECARD_MIN_DELAY_MS);
  return e;
}

export function checkTableFrame(t: any, path = 'table'): string[] {
  const e: string[] = [];
  if (!isObj(t)) return [path];
  for (const k of ['t', 'handNumber', 'maxSeats', 'pot', 'dealerSeat', 'smallBlindSeat', 'bigBlindSeat', 'activeSeat']) need(e, `${path}.${k}`, isNum(t[k]));
  need(e, `${path}.tableId`, isStr(t.tableId));
  need(e, `${path}.tableNo`, nullOr(isInt)(t.tableNo));
  need(e, `${path}.tableName`, isStr(t.tableName));
  need(e, `${path}.featured`, typeof t.featured === 'boolean');
  need(e, `${path}.phase`, isStr(t.phase));
  need(e, `${path}.handLevel`, isObj(t.handLevel) && isNum(t.handLevel.sb) && isNum(t.handLevel.bb) && isNum(t.handLevel.ante));
  need(e, `${path}.turnStartedAt`, nullOr(isNum)(t.turnStartedAt));
  need(e, `${path}.turnTimeout`, nullOr(isNum)(t.turnTimeout));
  need(e, `${path}.board`, Array.isArray(t.board) && t.board.length <= 5 && t.board.every(cardOk));
  if ('liveHandEndedAt' in t) need(e, `${path}.liveHandEndedAt`, nullOr(isNum)(t.liveHandEndedAt));
  need(e, `${path}.seats`, Array.isArray(t.seats));
  (t.seats || []).forEach((s: any, i: number) => {
    const p = `${path}.seats[${i}]`;
    need(e, p, isObj(s));
    if (!isObj(s)) return;
    need(e, `${p}.seatIndex`, isInt(s.seatIndex));
    need(e, `${p}.pid`, isStr(s.pid) && /^b-[0-9a-f]{16}$/.test(s.pid));
    need(e, `${p}.name`, isStr(s.name));
    for (const k of ['chips', 'bet']) need(e, `${p}.${k}`, isNum(s[k]));
    for (const k of ['folded', 'allIn', 'sittingOut', 'eliminated', 'hasCards']) need(e, `${p}.${k}`, typeof s[k] === 'boolean');
    need(e, `${p}.holeCards`, s.holeCards === null || (Array.isArray(s.holeCards) && s.holeCards.every(cardOk)));
  });
  if (t.handResult !== null) {
    const hr = t.handResult;
    need(e, `${path}.handResult`, isObj(hr) && Array.isArray(hr.winners) && Array.isArray(hr.showdownSeats) && Array.isArray(hr.muckedSeats));
  }
  return e;
}

export function checkProgram(p: any, path = 'program'): string[] {
  const e: string[] = [];
  if (!isObj(p)) return [path];
  need(e, `${path}.v`, p.v === 1);
  need(e, `${path}.channel`, isStr(p.channel));
  need(e, `${path}.eventKey`, isStr(p.eventKey) && /^(q:|t:|next:)/.test(p.eventKey));
  need(e, `${path}.onAir`, typeof p.onAir === 'boolean');
  need(e, `${path}.rehearsal`, typeof p.rehearsal === 'boolean');
  need(e, `${path}.programNow`, isNum(p.programNow));
  const ev = p.event;
  need(e, `${path}.event`, isObj(ev));
  if (isObj(ev)) {
    need(e, `${path}.event.kind`, ['weekly', 'monthly', 'sitgo'].includes(ev.kind));
    need(e, `${path}.event.status`, STATUSES.includes(ev.status));
    need(e, `${path}.event.name`, isStr(ev.name));
    need(e, `${path}.event.levels`, Array.isArray(ev.levels));
    need(e, `${path}.event.prizes`, isObj(ev.prizes) && ['seats', 'chips'].includes(ev.prizes.kind) && Array.isArray(ev.prizes.rows));
    need(e, `${path}.event.lateReg`, isObj(ev.lateReg));
  }
  need(e, `${path}.scene`, isObj(p.scene) && SCENES.includes(p.scene.id) && typeof p.scene.auto === 'boolean');
  need(e, `${path}.featured`, isObj(p.featured) && FEATURED_MODES.includes(p.featured.mode));
  need(e, `${path}.standings`, isObj(p.standings) && Array.isArray(p.standings.leaders) && p.standings.leaders.length <= 10);
  need(e, `${path}.ticker`, Array.isArray(p.ticker) && p.ticker.length <= 30 && p.ticker.every((x: any) => isObj(x) && (TICKER_KINDS as readonly string[]).includes(x.kind)));
  need(e, `${path}.lowerThirds`, Array.isArray(p.lowerThirds));
  need(e, `${path}.legal`, isObj(p.legal) && p.legal.line === BROADCAST_LEGAL_LINE);
  need(e, `${path}.results`, p.results === null || Array.isArray(p.results));
  need(e, `${path}.finalTable`, p.finalTable === null || (isObj(p.finalTable) && Array.isArray(p.finalTable.seats)));
  return e;
}

export function checkSnapshot(s: any): string[] {
  const e: string[] = [];
  if (!isObj(s)) return ['snapshot'];
  need(e, 'snapshot.v', s.v === 1);
  need(e, 'snapshot.seq', isInt(s.seq));
  need(e, 'snapshot.serverNow', isNum(s.serverNow));
  e.push(...checkFeed(s.feed, 'snapshot.feed'));
  e.push(...checkProgram(s.program, 'snapshot.program'));
  if (s.table !== null) e.push(...checkTableFrame(s.table, 'snapshot.table'));
  return e;
}

export function checkFrameMsg(msg: any, i = 0): string[] {
  const p = `frames[${i}]`;
  if (!isObj(msg)) return [p];
  if (msg.kind === 'table') return checkTableFrame(msg.table, `${p}.table`);
  if (msg.kind === 'program') return checkProgram(msg.program, `${p}.program`);
  if (msg.kind === 'event') return isObj(msg.event) && (TICKER_KINDS as readonly string[]).includes(msg.event.kind) ? [] : [`${p}.event`];
  return [`${p}.kind`];
}

/** Every forbidden key anywhere in a payload, as paths. */
export function forbiddenKeyPaths(value: unknown, path = '$', out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v, i) => forbiddenKeyPaths(v, `${path}[${i}]`, out));
  else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.includes(k)) out.push(`${path}.${k}`);
      forbiddenKeyPaths(v, `${path}.${k}`, out);
    }
  }
  return out;
}
