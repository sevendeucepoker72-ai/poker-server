/**
 * The economy's calendar (2026-10-11, .online R2 — ECON-4 / C5 / C6 / C9).
 *
 * Every "once per day / per month" thing a player can claim — the daily login
 * reward and its streak, the daily spin, the daily missions, the VIP monthly
 * bonus, the monthly season — runs on the America/Denver calendar, the same
 * calendar the claim ledger (`user_daily_claims.claim_date =
 * (NOW() AT TIME ZONE 'America/Denver')::date`) has always used. Before R2 the
 * login streak compared a UTC "yesterday" with that Denver date, so a claim
 * made after 18:00 MDT (00:00 UTC) reset the streak (45 of 51 evening claims).
 *
 * Pure functions on epoch milliseconds (Intl, no dependencies), DST-correct.
 */

export const ECONOMY_TIME_ZONE = 'America/Denver';

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ECONOMY_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

interface ZonedParts { y: number; m: number; d: number; hh: number; mm: number; ss: number }

/** Wall-clock fields of `ms` in Denver. */
export function denverParts(ms: number = Date.now()): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { y: out.year, m: out.month, d: out.day, hh: out.hour % 24, mm: out.minute, ss: out.second };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' — the Denver calendar date of `ms`. */
export function denverDateKey(ms: number = Date.now()): string {
  const p = denverParts(ms);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/** 'YYYY-MM' — the Denver calendar month of `ms` (the season key). */
export function denverMonthKey(ms: number = Date.now()): string {
  const p = denverParts(ms);
  return `${p.y}-${pad2(p.m)}`;
}

/** Offset of Denver from UTC at `ms`, in ms (negative: -6h MDT / -7h MST). */
function denverOffsetMs(ms: number): number {
  const p = denverParts(ms);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Epoch ms of the Denver wall-clock time y-m-d hh:mm (DST-correct). */
export function denverWallTimeToMs(y: number, m: number, d: number, hh = 0, mm = 0): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  let ms = guess - denverOffsetMs(guess);
  // A second pass settles the offset on DST-transition days.
  ms = guess - denverOffsetMs(ms);
  return ms;
}

function parseDateKey(key: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** `key` ± `days` on the calendar ('2026-03-01' - 1 = '2026-02-28'). */
export function addDaysToDateKey(key: string, days: number): string {
  const p = parseDateKey(key);
  if (!p) return key;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** Epoch ms of the next Denver midnight after `ms` (when a daily claim reopens). */
export function nextDenverMidnightMs(ms: number = Date.now()): number {
  const tomorrow = parseDateKey(addDaysToDateKey(denverDateKey(ms), 1))!;
  return denverWallTimeToMs(tomorrow.y, tomorrow.m, tomorrow.d);
}

/** Epoch ms of 00:00 Denver on the first day of the month after `ms` (season end). */
export function nextDenverMonthStartMs(ms: number = Date.now()): number {
  const p = denverParts(ms);
  const y = p.m === 12 ? p.y + 1 : p.y;
  const m = p.m === 12 ? 1 : p.m + 1;
  return denverWallTimeToMs(y, m, 1);
}

/** 'YYYY-MM' of the Denver month before the one `ms` falls in. */
export function previousDenverMonthKey(ms: number = Date.now()): string {
  const p = denverParts(ms);
  const y = p.m === 1 ? p.y - 1 : p.y;
  const m = p.m === 1 ? 12 : p.m - 1;
  return `${y}-${pad2(m)}`;
}

/** First and last Denver calendar dates ('YYYY-MM-DD') of a 'YYYY-MM' month key. */
export function monthDateRange(monthKey: string): { first: string; last: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { first: `${y}-${pad2(mo)}-01`, last: `${y}-${pad2(mo)}-${pad2(lastDay)}` };
}

/**
 * The Denver week (Sunday-start) containing `ms`: first and last dates. Used by
 * the leaderboard's 'weekly' window (chips won since Sunday 00:00 Denver).
 */
export function denverWeekRange(ms: number = Date.now()): { first: string; last: string } {
  const today = denverDateKey(ms);
  const p = parseDateKey(today)!;
  const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); // 0 = Sunday
  const first = addDaysToDateKey(today, -dow);
  return { first, last: addDaysToDateKey(first, 6) };
}
