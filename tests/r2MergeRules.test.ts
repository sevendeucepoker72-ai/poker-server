/**
 * 2026-10-11 (.online R2 merge) — the rules decided when the three server lanes
 * (S1 tournaments / quick games, S2 engine / bots, S3 economy) were merged.
 *
 * 1. Season / leaderboard "chips won" counts PUBLIC cash tables only (owner-
 *    approved anti-collusion rule): a private home game or a club table is a
 *    room of the players' own choosing, where friends could feed one account a
 *    paid season place. A club table still feeds its club's own stats.
 * 2. One fixed-roster predicate: S2's bot step asks S1's isFixedRosterTable.
 */
import { SRC, fnSrc, load } from './helpers/indexSource';

function chipsWonWorld(kinds: Record<string, string>, tournaments: string[] = []) {
  const code = [fnSrc('function tableCountsForChipsWon('), fnSrc('function tableFeedsClubStats(')].join('\n');
  const scope = {
    isTournamentTable: (id: string) => tournaments.includes(id),
    tableKindOf: (id: string) => kinds[id] ?? 'cash',
  };
  return load(code, scope, '{ tableCountsForChipsWon, tableFeedsClubStats }').exports;
}

describe('R2 merge — season "chips won" is public cash only', () => {
  const kinds = {
    cash: 'cash', home: 'private', club: 'club', hu: 'headsup', spin: 'spingo', career: 'career', aof: 'allinorfold',
  };

  it('only a public cash table counts toward the season / leaderboard bucket', () => {
    const m = chipsWonWorld(kinds);
    expect(m.tableCountsForChipsWon('cash')).toBe(true);
    for (const id of ['home', 'club', 'hu', 'spin', 'career', 'aof']) expect(m.tableCountsForChipsWon(id)).toBe(false);
  });

  it('a tournament table never counts, whatever its kind', () => {
    const m = chipsWonWorld(kinds, ['cash']);
    expect(m.tableCountsForChipsWon('cash')).toBe(false);
  });

  it('a club table still feeds its own club stats; nothing else does', () => {
    const m = chipsWonWorld(kinds);
    expect(m.tableFeedsClubStats('club')).toBe(true);
    for (const id of ['cash', 'home', 'hu', 'spin', 'career', 'aof']) expect(m.tableFeedsClubStats(id)).toBe(false);
    expect(chipsWonWorld(kinds, ['club']).tableFeedsClubStats('club')).toBe(false);
  });

  it('wiring: the season write is gated on tableCountsForChipsWon, the club entry on tableFeedsClubStats', () => {
    const hc = fnSrc('async function handleHandComplete(');
    expect(hc).toContain('const countsForChipsWon = tableCountsForChipsWon(tableId);');
    expect(hc).toContain('const feedsClubStats = tableFeedsClubStats(tableId);');
    expect(hc).toMatch(/if \(countsForChipsWon\) \{\s+recordChipWins\(/);
    expect(hc).toContain('if (feedsClubStats) clubHandEntries.push(');
    // the only recordChipWins call in the server is that gated one
    expect(SRC.split('recordChipWins(auth.userId').length - 1).toBe(1);
  });
});

describe('R2 merge — one fixed-roster predicate', () => {
  it('isFixedRosterQuickTable (S2 bot step) delegates to isFixedRosterTable (S1)', () => {
    expect(fnSrc('function isFixedRosterQuickTable(')).toContain('return isFixedRosterTable(tableId);');
    const code = [fnSrc('function isFixedRosterTable('), fnSrc('function isFixedRosterQuickTable(')].join('\n');
    const quickTables = new Set(['q']);
    const challengeTables = new Map([['c', {}]]);
    const m = load(code, { quickTables, challengeTables }, '{ isFixedRosterQuickTable }').exports;
    expect(m.isFixedRosterQuickTable('q')).toBe(true);
    expect(m.isFixedRosterQuickTable('c')).toBe(true);
    expect(m.isFixedRosterQuickTable('cash')).toBe(false);
  });
});
