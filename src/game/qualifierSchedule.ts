/**
 * 2026-10-11 (.online R2, S1) — online qualifiers from the MASTER schedule
 * (TOURNEY-2 / TOURNEY-3 / TOURNEY-13 / AUTH-9 / APPUI-44, contract C3).
 * Pure: parsing, windows, status, structure, the lobby item. index.ts owns the
 * registry, the master calls and the tournament.
 *
 * Before: syncQualifierSchedule read `body.schedule` while the master answers
 * `{ success, data: { schedule } }` — the registry was always EMPTY, so the
 * first Register created a FAKE event 7 days out ("Signup opens in 165h", 0
 * registrations in 30 days for 637 qualified players); the registry was per
 * TYPE (one 'weekly-qualifier' forever, never 'finished'); the server ran
 * 10/20 blinds on a 50,000 stack (never-ending) while the lobby advertised 15
 * levels of 20 minutes.
 */

export interface MasterScheduleEntry {
  id: string;
  name: string;
  type: string;
  clientQualifierId: string;
  scheduledAt: number;   // ms
  status: string;
  /** 2026-10-21 — the event's championship SEAT PACKAGE ({place: seats}); null = the standard award. */
  seatPackage: Record<number, number> | null;
}

/**
 * 2026-10-21 (owner: "1st gets 3 seats, 2nd thru 4th get 2 seats and 5th
 * through 10th get 1 seat") — the master's `seatPackage` ({"<place>": <seats>})
 * → {place: seats}, or null when absent / unusable. Same rules as the master's
 * championshipCap.normalizeSeatPackage: places 1-100, 1-10 seats each, at most
 * 100 seats.
 */
export function parseSeatPackage(raw: unknown): Record<number, number> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<number, number> = {};
  let total = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const place = Number(k);
    const seats = Number(v);
    if (!Number.isInteger(place) || place < 1 || place > 100) return null;
    if (!Number.isInteger(seats) || seats < 1 || seats > 10) return null;
    out[place] = seats;
    total += seats;
  }
  return total > 0 && total <= 100 ? out : null;
}

/** The lowest place that still wins a seat: the package's last place, else the standard rule. */
export function seatsForTopWith(type: string, pkg: Record<number, number> | null | undefined): number {
  if (pkg) return Math.max(...Object.keys(pkg).map(Number));
  return seatsForTopOf(type);
}

/** Championship seats a finish at `place` wins: the package's count, else 1 inside the standard top. */
export function seatsWonAt(type: string, pkg: Record<number, number> | null | undefined, place: number): number {
  if (!(place > 0)) return 0;
  if (pkg) return pkg[place] || 0;
  return place <= seatsForTopOf(type) ? 1 : 0;
}

/**
 * The master's `/qualifiers/schedule` answer — `{ success, data: { schedule } }`
 * (a bare `{ schedule }` is read too). Only entries with an id and a valid
 * scheduled time (an event without a time cannot be played online).
 */
export function parseMasterSchedule(body: unknown): MasterScheduleEntry[] {
  const b = body as { data?: { schedule?: unknown }; schedule?: unknown } | null;
  const list = Array.isArray(b?.data?.schedule) ? b!.data!.schedule as unknown[] : Array.isArray(b?.schedule) ? b!.schedule as unknown[] : [];
  const out: MasterScheduleEntry[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = r.id !== undefined && r.id !== null ? String(r.id) : '';
    const at = typeof r.scheduledAt === 'string' || typeof r.scheduledAt === 'number' ? new Date(r.scheduledAt as any).getTime() : NaN;
    if (!id || !Number.isFinite(at)) continue;
    const type = typeof r.type === 'string' && r.type ? r.type : 'weekly';
    out.push({
      id,
      name: typeof r.name === 'string' && r.name ? r.name.slice(0, 80) : 'Qualifier',
      type,
      clientQualifierId: typeof r.clientQualifierId === 'string' && r.clientQualifierId ? r.clientQualifierId : id,
      scheduledAt: at,
      status: typeof r.status === 'string' ? r.status : 'open',
      seatPackage: parseSeatPackage(r.seatPackage),
    });
  }
  return out;
}

/**
 * Signup opens 3h before the start; registration (late entry and re-entry
 * included) closes QUALIFIER_LATE_REG_MS after it.
 * 2026-10-22 (owner: "There should be late entries until 2pm") — 3 hours (was
 * 90 minutes = 12:30): the weekly (Sunday) and the monthly (3rd Saturday) both
 * start at 11:00 AM Denver, so 11:00 + 3h = 2:00 PM Denver. The ONE late-entry
 * constant: the register window, the late seat, the re-entry window, the
 * too-few-players cancel, the no-show notice and the lobby's lateRegUntil /
 * signupClosesAt all follow it. Owner-correctable here.
 */
export const QUALIFIER_SIGNUP_OPENS_BEFORE_MS = 3 * 60 * 60 * 1000;
export const QUALIFIER_LATE_REG_MS = 180 * 60 * 1000;

/**
 * 2026-10-22 (owner: "re entries if they have more credits and each entry
 * consume a credit") — the per-event re-entry cap. null = NO cap: a busted
 * entrant may re-enter (until QUALIFIER_LATE_REG_MS) as often as he holds an
 * unused credit of the event's tier, and every entry — the first and each
 * re-entry — consumes exactly one (the master's atomic consume is the limit).
 * Was a hard-coded 3. A number here caps every event (a per-event
 * `maxReEntries` still overrides it). Owner-correctable here.
 */
export const QUALIFIER_MAX_REENTRIES: number | null = null;

/**
 * 2026-10-22 (owner: "Build it for Sunday") — OVERFLOW tables. When a late
 * entrant or a re-entrant finds every seat of a RUNNING qualifier alive (no
 * empty seat, no busted one), index.ts opens a new table for him instead of
 * refusing `no_seat` (openQualifierOverflowTable). A new table opens only when
 * every seat of every table — earlier overflow tables included — is alive, so
 * at most one table is ever under-filled; this cap is the blast-radius guard:
 * at most this many overflow tables of one event in play at once (6 = 54
 * extra seats). Reached → the next arrival gets the old no_seat refund.
 * Railway env `QUALIFIER_OVERFLOW_TABLES_MAX` sets it at boot; 0 = OFF (the
 * kill switch: exactly the behaviour before overflow tables). Review fix-up:
 * it can ALSO be changed while the server runs, with no restart (a restart
 * cancels a running qualifier) — POST /api/qualifiers/overflow {max} with the
 * X-Internal-Token (index.ts setQualifierOverflowTablesMax; 0 also stops the
 * feed). That value lasts until the next restart, which reads the env again.
 *
 * 2026-10-23 — OWNER (2026-10-22): "No cap on extra tables". The default is now
 * UNLIMITED (Infinity): a new overflow table opens whenever every seat is alive,
 * however many are already in play. 0 is still the kill switch (OFF). A number
 * still sets a cap (floored, at least 0, no upper clamp); "unlimited" means no
 * cap. JSON surfaces show it via qualifierOverflowCapLabel ('unlimited').
 */
export const QUALIFIER_OVERFLOW_TABLES_MAX = Infinity;

/** The overflow-table cap from the env value: unset / blank / "unlimited" / not a number → unlimited (Infinity); else floored, at least 0 (0 = off). */
export function qualifierOverflowTablesCap(raw: string | undefined): number {
  if (raw === undefined || raw === null) return QUALIFIER_OVERFLOW_TABLES_MAX;
  const text = String(raw).trim().toLowerCase();
  if (text === '' || text === 'unlimited') return QUALIFIER_OVERFLOW_TABLES_MAX;
  const n = Number(text);
  if (!Number.isFinite(n)) return QUALIFIER_OVERFLOW_TABLES_MAX;
  return Math.max(0, Math.floor(n));
}

/** The cap as JSON can carry it: a number, or 'unlimited' for no cap (JSON has no Infinity). */
export function qualifierOverflowCapLabel(cap: number): number | 'unlimited' {
  return Number.isFinite(cap) ? cap : 'unlimited';
}

/**
 * Review fix-up (2026-10-22) — the cap an operator asks for WHILE THE SERVER
 * RUNS (POST /api/qualifiers/overflow {max}). Stricter than the env read: a
 * missing / blank / non-numeric value is refused (null → 400, nothing changes)
 * instead of quietly meaning the default. A number (or numeric string) is
 * floored, at least 0, no upper clamp (2026-10-23, owner: no cap); 0 = OFF;
 * the string "unlimited" = no cap.
 */
export function parseQualifierOverflowCapUpdate(raw: unknown): number | null {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const text = String(raw).trim().toLowerCase();
  if (text === 'unlimited') return Infinity;
  if (text === '') return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

/**
 * 2026-10-23 (qualifier lifecycle S4, owner 2026-10-22: "open the rooms 10
 * minutes before game start so people can join and then start the game on
 * time") — EARLY ROOMS. This many minutes before the start, the tables are
 * created and every registrant who is online is SEATED (more join as they come
 * online), but the tournament is held ('prestart' pause): no card and no blind
 * clock until the scheduled start second, when the no-shows are released and
 * refunded exactly as before and every table is dealt at once (index.ts
 * openQualifierTablesEarly / runPreStartDeal). Railway env
 * QUALIFIER_TABLES_OPEN_BEFORE_MIN sets it at boot (clamped 0..30, garbage →
 * 10); **0 = OFF** = the 11:00 start of before S4. While the server runs:
 * POST /api/qualifiers/tables-open {minutes} (X-Internal-Token; a restart
 * cancels a running qualifier, so never change the env during an event).
 * Owner-correctable here.
 */
export const QUALIFIER_TABLES_OPEN_BEFORE_MIN = 10;
const QUALIFIER_TABLES_OPEN_BEFORE_HARD_MAX = 30;

/** The early-rooms lead (minutes) from the env value: unset / blank / not a number → 10; else floored and clamped to 0..30 (0 = off). */
export function qualifierTablesOpenBeforeMin(raw: string | undefined): number {
  if (raw === undefined || raw === null) return QUALIFIER_TABLES_OPEN_BEFORE_MIN;
  const text = String(raw).trim();
  if (text === '') return QUALIFIER_TABLES_OPEN_BEFORE_MIN;
  const n = Number(text);
  if (!Number.isFinite(n)) return QUALIFIER_TABLES_OPEN_BEFORE_MIN;
  return Math.min(QUALIFIER_TABLES_OPEN_BEFORE_HARD_MAX, Math.max(0, Math.floor(n)));
}

/**
 * S4 — the lead an operator asks for WHILE THE SERVER RUNS (POST
 * /api/qualifiers/tables-open {minutes}). Stricter than the env read: a missing
 * / blank / non-numeric value is refused (null → 400, nothing changes) instead
 * of quietly meaning 10. A number (or numeric string) is floored and clamped to
 * 0..30 like the env value; 0 = OFF.
 */
export function parseQualifierTablesOpenUpdate(raw: unknown): number | null {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const text = String(raw).trim();
  if (text === '') return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return qualifierTablesOpenBeforeMin(text);
}

/**
 * 2026-10-22 — the re-entries a busted (or still-playing) entrant may still
 * make: his unused credits of the tier (`creditsHeld`, each re-entry consumes
 * one), within the cap if one is set (`cap - used`). null = not known (the
 * credit list was never read and there is no cap) — the lobby then relies on
 * the player's qualifications.
 */
export function qualifierReEntriesLeft(creditsHeld: number | null, cap: number | null | undefined, used: number): number | null {
  const capLeft = cap === null || cap === undefined || !Number.isFinite(cap) ? null : Math.max(0, Math.floor(cap) - Math.max(0, Math.floor(used || 0)));
  const held = creditsHeld === null || !Number.isFinite(creditsHeld) ? null : Math.max(0, Math.floor(creditsHeld));
  if (held === null) return capLeft;
  return capLeft === null ? held : Math.min(capLeft, held);
}

export function qualifierWindows(scheduledAt: number): { signupOpensAt: number; signupClosesAt: number; lateRegUntil: number } {
  return {
    signupOpensAt: scheduledAt - QUALIFIER_SIGNUP_OPENS_BEFORE_MS,
    signupClosesAt: scheduledAt + QUALIFIER_LATE_REG_MS,
    lateRegUntil: scheduledAt + QUALIFIER_LATE_REG_MS,
  };
}

export type QualifierPhase = 'pending' | 'running' | 'finished';
export type QualifierStatus = 'scheduled' | 'registering' | 'running' | 'finished';

/** C3 status: before signup opens 'scheduled'; then 'registering' until it starts; 'running'; 'finished' (incl. cancelled). */
export function qualifierStatusOf(phase: QualifierPhase, scheduledAt: number, now: number): QualifierStatus {
  if (phase === 'finished') return 'finished';
  if (phase === 'running') return 'running';
  return now < qualifierWindows(scheduledAt).signupOpensAt ? 'scheduled' : 'registering';
}

/** Championship seats the master awards from a finish (its recordQualifierResults rules). */
export function seatsForTopOf(type: string): number {
  if (type === 'weekly' || type === 'console_weekly') return 3;
  if (type === 'monthly' || type === 'console_monthly') return 6;
  if (type === 'toc') return 1;
  return 0;
}

/**
 * The structure the server RUNS (C3 `structure`): the lobby's advertised 15
 * levels (25/50 … 3000/6000, designed for a 50,000 stack), scaled to the real
 * starting stack, then continued until one big blind is four starting stacks —
 * a qualifier always ends (the blind clock stops at the LAST level).
 * 2026-10-20 (owner: "about 4-5 hours") — 12-minute levels (were 20: 6-9
 * hours). A field of 20-150 reaches its last few levels in roughly 4-5 hours.
 */
export const QUALIFIER_BASE_STACK = 50_000;
const ADVERTISED: Array<[number, number, number]> = [
  [25, 50, 0], [50, 100, 0], [75, 150, 25], [100, 200, 25], [150, 300, 50], [200, 400, 50], [300, 600, 75],
  [400, 800, 100], [500, 1000, 100], [600, 1200, 200], [800, 1600, 200], [1000, 2000, 300], [1500, 3000, 500],
  [2000, 4000, 500], [3000, 6000, 1000],
];
const CONTINUATION: Array<[number, number, number]> = [
  [4000, 8000, 1000], [5000, 10000, 1500], [6000, 12000, 2000], [8000, 16000, 2000], [10000, 20000, 3000],
  [15000, 30000, 5000], [20000, 40000, 5000], [30000, 60000, 10000], [50000, 100000, 10000],
  [75000, 150000, 25000], [100000, 200000, 25000],
];
export const QUALIFIER_LEVEL_MINUTES = 12;

/**
 * 2026-10-23 (qualifier lifecycle S3, owner: "take breaks") — a 5-minute break
 * after every 5th level (the usual live-room rhythm: about one an hour). With
 * 12-minute levels from 11:00 the breaks fall at 12:00, 1:05, 2:10, 3:15 and
 * 4:20 MT; never after the last level. The engine runs it (TournamentManager
 * `config.breaks`); the lobby shows it (`structure.breaks`, additive). Runtime
 * switch: POST /api/qualifiers/breaks {on} (index.ts); Railway env
 * QUALIFIER_BREAKS=0 turns it off at boot. Owner-correctable here.
 */
export const QUALIFIER_BREAK_EVERY_LEVELS = 5;
export const QUALIFIER_BREAK_MINUTES = 5;

export function qualifierStructure(startingStack: number = QUALIFIER_BASE_STACK): {
  startingStack: number;
  levels: Array<{ sb: number; bb: number; ante: number; minutes: number }>;
  breaks: { everyLevels: number; minutes: number };
} {
  const stack = Number.isFinite(startingStack) && startingStack > 0 ? Math.floor(startingStack) : QUALIFIER_BASE_STACK;
  const k = stack / QUALIFIER_BASE_STACK;
  const scale = (n: number) => (n <= 0 ? 0 : Math.max(1, Math.round(n * k)));
  const levels = [...ADVERTISED, ...CONTINUATION].map(([sb, bb, ante]) => {
    const s = scale(sb);
    return { sb: s, bb: Math.max(s * 2, scale(bb)), ante: scale(ante), minutes: QUALIFIER_LEVEL_MINUTES };
  });
  return { startingStack: stack, levels, breaks: { everyLevels: QUALIFIER_BREAK_EVERY_LEVELS, minutes: QUALIFIER_BREAK_MINUTES } };
}

/**
 * S3 — the RIG-ONLY time scale (env QUALIFIER_TEST_TIME_SCALE): the engine's
 * level durations and break length are divided by it so a local rig can play
 * a 12-minute level in 12 s. ALWAYS 1 in production: NODE_ENV=production, or
 * ANY Railway runtime variable set (Railway's nixpacks build does NOT set
 * NODE_ENV — authManager.ts JWT guard — so a NODE_ENV-only test would leave the
 * knob live on Railway). Otherwise the value floored and clamped to 1..120;
 * unset / blank / not a number → 1. The lobby's advertised 12-minute levels
 * never change; /api/health r2Play.qualifiers.testTimeScale shows it.
 */
const RAILWAY_RUNTIME_VARS = [
  'RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_DEPLOYMENT_ID',
];
export function qualifierTestTimeScale(env: Record<string, string | undefined> = process.env): number {
  if (!env) return 1;
  if (env.NODE_ENV === 'production') return 1;
  for (const k of RAILWAY_RUNTIME_VARS) if (env[k]) return 1;
  const raw = env.QUALIFIER_TEST_TIME_SCALE;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 1;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return 1;
  return Math.min(120, Math.max(1, Math.floor(n)));
}

/** A time scale as the engine uses it: a finite number >= 1, else 1. */
function engineTimeScale(timeScale: unknown): number {
  return typeof timeScale === 'number' && Number.isFinite(timeScale) && timeScale >= 1 ? timeScale : 1;
}

/**
 * The same structure as TournamentManager BlindLevels (duration in seconds).
 * S3 — `timeScale` (the rig knob, qualifierTestTimeScale; 1 = real time)
 * divides the duration (at least 1 s). Production always passes 1.
 */
export function qualifierBlindLevels(startingStack: number = QUALIFIER_BASE_STACK, timeScale: number = 1): Array<{ sb: number; bb: number; ante: number; duration: number }> {
  const k = engineTimeScale(timeScale);
  return qualifierStructure(startingStack).levels.map((l) => ({ sb: l.sb, bb: l.bb, ante: l.ante, duration: Math.max(1, Math.round((l.minutes * 60) / k)) }));
}

/** S3 — the engine's break schedule (TournamentManager `config.breaks`): every 5th level, 5 minutes (divided by the rig's time scale, at least 1 s). */
export function qualifierBreakConfig(timeScale: number = 1): { everyLevels: number; seconds: number } {
  const k = engineTimeScale(timeScale);
  return { everyLevels: QUALIFIER_BREAK_EVERY_LEVELS, seconds: Math.max(1, Math.round((QUALIFIER_BREAK_MINUTES * 60) / k)) };
}

/**
 * 2026-10-24 (owner 2026-10-23: "Build it for Sunday") — HAND-FOR-HAND at the
 * qualifier's SEAT BUBBLE (index.ts, the hand-for-hand block of the rebalance
 * helpers). When the last player out of the seats is about to bust, every table
 * plays ONE hand at a time and waits for the others between hands, so nobody can
 * stall into a seat; players busted in the SAME such hand (at one table or
 * several) are placed by their stack at the START of that hand.
 *
 * Engages only when ALL hold (handForHandApplies): the late registration has
 * CLOSED (now > lateRegUntil — no field change, no place shift, can be ahead);
 * two or more tables are in play; alive === seatsForTop + 1 (the event's seat
 * package: Sunday's top 10 → 11 alive); and the field does not fit one table
 * (alive > QUALIFIER_TABLE_SEATS — Rule 1 merges a field of 9 or fewer onto
 * the final table). The weekly default (top 3) and the monthly (top 6) never
 * engage. It ends the moment alive <= seatsForTop or one table is left.
 * The WATCHDOG (QUALIFIER_HAND_FOR_HAND_WATCHDOG_MS) releases every held table
 * when a round has not settled in time — fail OPEN; never during a break or a
 * director pause. Railway env QUALIFIER_HAND_FOR_HAND at boot ('0' = off, unset
 * = on); while the server runs: POST /api/qualifiers/hand-for-hand {on}
 * (X-Internal-Token). Owner-correctable here.
 */
export const QUALIFIER_HAND_FOR_HAND_WATCHDOG_MS = 240_000;
export const QUALIFIER_HAND_FOR_HAND_MIN_WATCHDOG_MS = 5_000;
/** The seats of a qualifier table (TournamentManager.checkRebalance's own 9). */
export const QUALIFIER_TABLE_SEATS = 9;

/** The hand-for-hand switch at boot from env QUALIFIER_HAND_FOR_HAND: '0' = OFF, unset / anything else = ON (the QUALIFIER_TABLE_BALANCE pattern). */
export function qualifierHandForHandOnAtBoot(raw: string | undefined): boolean {
  return raw !== '0';
}

/**
 * The watchdog's length: 4 minutes, divided by the RIG time scale
 * (qualifierTestTimeScale — always 1 on Railway / NODE_ENV=production), never
 * under 5 s. Garbage → 4 minutes.
 */
export function qualifierHandForHandWatchdogMs(timeScale: number = 1): number {
  return Math.max(QUALIFIER_HAND_FOR_HAND_MIN_WATCHDOG_MS, Math.round(QUALIFIER_HAND_FOR_HAND_WATCHDOG_MS / engineTimeScale(timeScale)));
}

/** Does hand-for-hand apply right now? Pure; every input must be a real number (an event with no scheduled time never engages). */
export function handForHandApplies(o: { now: number; lateRegUntil: number; alive: number; seatsForTop: number; tablesInPlay: number }): boolean {
  if (!o || typeof o !== 'object') return false;
  const { now, lateRegUntil, alive, seatsForTop, tablesInPlay } = o;
  if (!Number.isFinite(now) || !Number.isFinite(lateRegUntil) || !(now > lateRegUntil)) return false;
  if (!Number.isFinite(tablesInPlay) || tablesInPlay < 2) return false;
  if (!Number.isInteger(seatsForTop) || seatsForTop < 1) return false;
  if (!Number.isInteger(alive) || alive !== seatsForTop + 1) return false;
  return alive > QUALIFIER_TABLE_SEATS;
}

/** What every table room is told when hand-for-hand starts (the existing 'serverAnnouncement' toast; ASCII, <= 200 chars). */
export function qualifierHandForHandOnText(alive: number, seatsForTop: number): string {
  return `Hand-for-hand: ${alive} players left and the top ${seatsForTop} win seats. Every table now plays one hand at a time; your table waits for the others between hands.`;
}
/** The table clock's banner while hand-for-hand is on (tournamentClock.handForHandText). */
export const QUALIFIER_HAND_FOR_HAND_TEXT = 'Hand-for-hand: waiting for the other tables to finish their hand';
/** What every table room is told when hand-for-hand ends. */
export const QUALIFIER_HAND_FOR_HAND_OFF_TEXT = 'Hand-for-hand is over: normal play resumes.';
