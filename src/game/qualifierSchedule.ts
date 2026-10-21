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

/** Signup opens 3h before the start; registration (late included) closes 90 minutes after it. */
export const QUALIFIER_SIGNUP_OPENS_BEFORE_MS = 3 * 60 * 60 * 1000;
export const QUALIFIER_LATE_REG_MS = 90 * 60 * 1000;

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

export function qualifierStructure(startingStack: number = QUALIFIER_BASE_STACK): { startingStack: number; levels: Array<{ sb: number; bb: number; ante: number; minutes: number }> } {
  const stack = Number.isFinite(startingStack) && startingStack > 0 ? Math.floor(startingStack) : QUALIFIER_BASE_STACK;
  const k = stack / QUALIFIER_BASE_STACK;
  const scale = (n: number) => (n <= 0 ? 0 : Math.max(1, Math.round(n * k)));
  const levels = [...ADVERTISED, ...CONTINUATION].map(([sb, bb, ante]) => {
    const s = scale(sb);
    return { sb: s, bb: Math.max(s * 2, scale(bb)), ante: scale(ante), minutes: QUALIFIER_LEVEL_MINUTES };
  });
  return { startingStack: stack, levels };
}

/** The same structure as TournamentManager BlindLevels (duration in seconds). */
export function qualifierBlindLevels(startingStack: number = QUALIFIER_BASE_STACK): Array<{ sb: number; bb: number; ante: number; duration: number }> {
  return qualifierStructure(startingStack).levels.map((l) => ({ sb: l.sb, bb: l.bb, ante: l.ante, duration: l.minutes * 60 }));
}
