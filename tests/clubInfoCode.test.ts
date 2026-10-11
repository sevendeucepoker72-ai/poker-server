/**
 * R1 (2026-10-11) — CLUBS-2: getClubInfo returns the club's join code only to
 * an ACTIVE member.
 *
 * getClubInfo answered any socket for any SERIAL club id and included
 * `clubCode`, so anyone could walk the ids, read every PRIVATE club's code and
 * join it. Real clubManager.getClubInfo against a routed fake pool. The owner's
 * name goes through the public-name rules too (never a login handle).
 */
const rows: Record<string, (params: unknown[]) => any[]> = {
  'SELECT * FROM clubs WHERE id = $1': (p) => (p[0] === 5 ? [{ id: 5, clubcode: '482913', name: 'Night Owls', description: '', ownerid: 70, settings: '{"isPrivate":true}', createdat: '2026-10-01' }] : []),
  'SELECT COUNT(*)::int as cnt FROM club_members WHERE clubId = $1 AND status = $2': () => [{ cnt: 3 }],
  'SELECT role FROM club_members WHERE clubId = $1 AND userId = $2 AND status = $3': (p) => (p[1] === 71 && p[2] === 'active' ? [{ role: 'member' }] : []),
  'SELECT badge, clubXp, clubLevel FROM clubs WHERE id = $1': () => [{ badge: '♠', clublevel: 2, clubxp: 40 }],
  'SELECT display_name FROM users WHERE id = $1': () => [{ display_name: '3035551234' }],
};
const fakePool = {
  query: async (text: string, params: unknown[] = []) => {
    const route = rows[text.trim()];
    if (!route) throw new Error(`unexpected SQL: ${text}`);
    return { rows: route(params) };
  },
};
jest.mock('../src/auth/authManager', () => ({ getPool: () => fakePool }));
// eslint-disable-next-line import/first
import { getClubInfo } from '../src/clubs/clubManager';

describe('getClubInfo — the join code only for active members (CLUBS-2)', () => {
  it('a stranger (or a signed-out socket) gets the club without its code', async () => {
    for (const requester of [99, undefined]) {
      const r = await getClubInfo(5, requester);
      expect(r.success).toBe(true);
      expect(r.club).toMatchObject({ id: 5, name: 'Night Owls', memberCount: 3 });
      expect(r.club).not.toHaveProperty('clubCode');
      expect(JSON.stringify(r)).not.toContain('482913');
    }
  });

  it('an active member gets the code (and his role)', async () => {
    const r = await getClubInfo(5, 71);
    expect(r.club).toMatchObject({ clubCode: '482913', myRole: 'member' });
  });

  it('the owner\'s name is public-name filtered (a phone-number display name shows as Player)', async () => {
    expect((await getClubInfo(5, 71)).club!.ownerName).toBe('Player');
  });

  it('an unknown club', async () => {
    expect(await getClubInfo(6, 71)).toEqual({ success: false, error: 'Club not found' });
  });
});
