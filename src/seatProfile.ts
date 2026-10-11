/**
 * 2026-10-11 — what a seat shows to EVERY player at the table (R1 contract #3;
 * audit AUTH-6, AUTH-10, APPUI-13, TOURNEY-12).
 *
 * AVATARS. Every seat path (joinTable, quickPlay, joinAdditionalTable,
 * joinByInviteCode, the reservation restores) stored the client's `avatar`
 * object verbatim on the session, and getGameStateForPlayer sent it to every
 * viewer: an arbitrary `photo` (image URL or data URI — unmoderated, and an
 * IP-logging beacon for every player at the table), arbitrary CSS strings as
 * `seatColor` / `skinTone` (rendered as a CSS `background`), any key at all.
 * `sanitizeSeatAvatar` keeps ONLY the customizer's known fields: style ids
 * (short lowercase identifiers), colors as #RGB / #RRGGBB hex, the face sliders
 * as numbers clamped to 0..1. `photo` is never kept — a seat photo goes through
 * the moderated master-API avatar pipeline, never the socket.
 *
 * NAMES: see auth/displayName.ts (accountDisplayName) and index.ts
 * seatNameForSocket.
 */

export const SEAT_AVATAR_STYLE_KEYS = ['bodyType', 'hairStyle', 'topStyle', 'bottomStyle', 'accessory'] as const;
export const SEAT_AVATAR_COLOR_KEYS = ['skinTone', 'hairColor', 'eyeColor', 'topColor', 'bottomColor', 'seatColor'] as const;
export const SEAT_AVATAR_FACE_KEYS = ['jawWidth', 'noseLength', 'cheekHeight', 'browHeight', 'lipFullness', 'eyeSize'] as const;

const STYLE_ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export type SeatAvatar = Partial<Record<(typeof SEAT_AVATAR_STYLE_KEYS)[number] | (typeof SEAT_AVATAR_COLOR_KEYS)[number], string>> & {
  faceShape?: Partial<Record<(typeof SEAT_AVATAR_FACE_KEYS)[number], number>>;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The allowlisted avatar to show at a seat, or undefined (nothing valid / not an object). */
export function sanitizeSeatAvatar(raw: unknown): SeatAvatar | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: SeatAvatar = {};
  for (const k of SEAT_AVATAR_STYLE_KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && STYLE_ID_RE.test(v)) out[k] = v;
  }
  for (const k of SEAT_AVATAR_COLOR_KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && HEX_COLOR_RE.test(v)) out[k] = v;
  }
  if (isPlainObject(raw.faceShape)) {
    const face: Record<string, number> = {};
    for (const k of SEAT_AVATAR_FACE_KEYS) {
      const v = (raw.faceShape as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v)) face[k] = Math.min(1, Math.max(0, v));
    }
    if (Object.keys(face).length) out.faceShape = face;
  }
  return Object.keys(out).length ? out : undefined;
}
