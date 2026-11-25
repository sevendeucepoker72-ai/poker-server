/**
 * 2026-10-20 (owner: "Remove + refund at start") — qualifier NO-SHOWS.
 *
 * A registrant who is not online when the qualifier starts used to be dealt in
 * absent: auto-folded / auto-checked, losing only blinds, so an empty seat
 * could last for hours and hold a place nobody earned. Now, at the start, each
 * one is removed and the credit is refunded; they can still late-register
 * while a seat is free.
 *
 * "Online at the start" = a live socket at the start, OR one seen in the last
 * QUALIFIER_NO_SHOW_GRACE_MS (a phone that blipped or a tab reloading at 11:00
 * is not a no-show). The auto-start tick samples who is online every 30 s from
 * QUALIFIER_PRESENCE_LEAD_MS before the start, and a registration counts as a
 * sighting. Pure: no sockets, no clock — the caller passes both.
 */
export const QUALIFIER_NO_SHOW_GRACE_MS = 2 * 60 * 1000;
export const QUALIFIER_PRESENCE_LEAD_MS = 15 * 60 * 1000;

export interface PresenceRegistrant {
  /** Last time the auto-start tick saw a live socket of this account. */
  lastOnlineAt?: number;
  registeredAt?: number;
}

/** Stamp `lastOnlineAt = now` on every registrant `isOnline` says is connected. */
export function samplePresence<T extends PresenceRegistrant>(players: T[], isOnline: (p: T) => boolean, now: number): void {
  for (const p of players) {
    if (isOnline(p)) p.lastOnlineAt = now;
  }
}

/** Last sighting: the newer of the tick's sample and the registration itself (0 = never). */
export function lastSeenAt(p: PresenceRegistrant): number {
  return Math.max(p.lastOnlineAt || 0, p.registeredAt || 0);
}

/** Split the field at the start: present (seen within the grace) vs absent. Order kept. */
export function partitionByPresence<T extends PresenceRegistrant>(
  players: T[], now: number, graceMs: number = QUALIFIER_NO_SHOW_GRACE_MS,
): { present: T[]; absent: T[] } {
  const present: T[] = [];
  const absent: T[] = [];
  for (const p of players) (lastSeenAt(p) >= now - graceMs ? present : absent).push(p);
  return { present, absent };
}

/**
 * 2026-11-25 (owner: "It currently says if your not online at start you are
 * removed. It should seat you and blind you out", then "Online League only")
 * — an ONLINE LEAGUE night (kind 'league') KEEPS its no-shows. Each one is
 * seated ABSENT at the start and blinded out: dealt in, blinds posted, acted
 * for by the absent act (check when nothing is owed, else fold) until a
 * sign-in or "Go to my table" puts them back on the seat. Nothing is
 * released, no notice waits for the sign-in. The Sunday weekly and the
 * monthly keep the rule above (released, credit refunded).
 */
export function noShowsSeatedAbsent(kind: string | null | undefined): boolean {
  return kind === 'league';
}

/**
 * How many registrants must be HERE (partitionByPresence) before the start
 * deals: 2 for the weekly / monthly (2026-10-20, unchanged); 1 for a league
 * night, whose no-shows are seated and blinded out, so one player here plays
 * the field. Nobody here: it waits, and is cancelled at its late close, as
 * before. Every start still needs 2 registrants.
 */
export function presentNeededToStart(kind: string | null | undefined): number {
  return noShowsSeatedAbsent(kind) ? 1 : 2;
}
