/**
 * 2026-10-24 (owner 2026-10-23: "5-minute levels"; Sit & Go fix-all F21) — the
 * two Sit & Go templates get their OWN level arrays:
 *  - 'Sit & Go' (9 max): 1,500 starting chips, every level 5 minutes;
 *  - 'Sit & Go Turbo' (6 max): 1,500 starting chips, every level 3 minutes.
 * The blind / ante amounts of every existing level are kept, and the schedule
 * is extended past 500/1000 so a long game never sits on the last level (the
 * forced bets of the last level exceed every chip in play).
 * Every other template (Bounty Turbo reused the Sit & Go array) is unchanged,
 * and the lobby item shows the structure (startingChips, levelSeconds,
 * blindStructure) — additive.
 */
import { TournamentManager } from '../src/game/TournamentManager';

function byName(tm: TournamentManager, name: string): any {
  for (const [, t] of (tm as any).tournaments as Map<string, any>) if (t.config.name === name && t.status === 'registering') return t;
  throw new Error(`no registering ${name}`);
}

// The amounts each Sit & Go level had before (sb, bb, ante) — kept.
const OLD_AMOUNTS = [
  [10, 20, 0], [20, 40, 0], [30, 60, 5], [50, 100, 10], [75, 150, 15],
  [100, 200, 25], [150, 300, 25], [200, 400, 50], [300, 600, 50], [500, 1000, 100],
];
// The pre-change Sit & Go durations (seconds) — Bounty Turbo is derived from them.
const OLD_SNG_DURATIONS = [180, 180, 150, 150, 120, 120, 90, 90, 60, 60];
const EXTENSION = [[750, 1500, 150], [1000, 2000, 200], [1500, 3000, 300], [2000, 4000, 400], [3000, 6000, 600], [5000, 10000, 1000]];
const DEFAULT_LEVELS = [
  [10, 20, 0, 300], [15, 30, 0, 300], [25, 50, 5, 300], [50, 100, 10, 240], [75, 150, 15, 240],
  [100, 200, 25, 180], [150, 300, 25, 180], [200, 400, 50, 120], [300, 600, 50, 120], [500, 1000, 100, 120],
];
const lv = (rows: number[][], duration?: number) => rows.map(([sb, bb, ante, d]) => ({ sb, bb, ante, duration: duration ?? d }));

describe('F21 — Sit & Go structures (owner: "5-minute levels")', () => {
  test("'Sit & Go': 1,500 chips, every level 300 s, the old amounts kept, extended", () => {
    const t = byName(new TournamentManager(), 'Sit & Go');
    expect(t.config.startingChips).toBe(1500);
    expect(t.config.maxPlayers).toBe(9);
    expect(t.config.blindLevels).toEqual(lv([...OLD_AMOUNTS, ...EXTENSION], 300));
  });

  test("'Sit & Go Turbo': 1,500 chips, every level 180 s, the old amounts kept, extended", () => {
    const t = byName(new TournamentManager(), 'Sit & Go Turbo');
    expect(t.config.startingChips).toBe(1500);
    expect(t.config.maxPlayers).toBe(6);
    expect(t.config.blindLevels).toEqual(lv([...OLD_AMOUNTS, ...EXTENSION], 180));
  });

  test('the last level forces more than every chip in play (a game cannot outlast the schedule)', () => {
    const tm = new TournamentManager();
    for (const name of ['Sit & Go', 'Sit & Go Turbo']) {
      const t = byName(tm, name);
      const last = t.config.blindLevels[t.config.blindLevels.length - 1];
      // One hand's forced bets at a full table cover every chip in play.
      expect(last.sb + last.bb + last.ante * t.config.maxPlayers).toBeGreaterThanOrEqual(t.config.maxPlayers * t.config.startingChips);
      // Every level at least as big as the one before.
      for (let i = 1; i < t.config.blindLevels.length; i++) expect(t.config.blindLevels[i].bb).toBeGreaterThan(t.config.blindLevels[i - 1].bb);
    }
  });

  test('a started Sit & Go deals 1,500 to every seat at level 1 (10/20)', () => {
    const tm = new TournamentManager();
    const t = byName(tm, 'Sit & Go');
    const tid = t.config.tournamentId;
    for (let i = 0; i < 9; i++) expect(tm.registerPlayer(tid, `p${i}`, `P${i}`, `s${i}`, 100 + i).success).toBe(true);
    const r = tm.startTournament(tid)!;
    expect(r.startingChips).toBe(1500);
    expect(r.blinds).toEqual({ sb: 10, bb: 20, ante: 0, duration: 300 });
    expect(t.players.every((p: any) => p.chips === 1500)).toBe(true);
    expect(t.levelEndsAt! - Date.now()).toBeGreaterThan(299_000);
    if (t.blindTimer) clearTimeout(t.blindTimer);
  });

  test('every OTHER template is exactly as before (Bounty Turbo keeps the old Sit & Go-derived levels)', () => {
    const tm = new TournamentManager();
    const bt = byName(tm, 'Bounty Turbo');
    expect(bt.config.blindLevels).toEqual(OLD_AMOUNTS.map(([sb, bb, ante], i) => ({ sb: sb * 2, bb: bb * 2, ante: ante * 2, duration: Math.floor(OLD_SNG_DURATIONS[i] * 0.5) })));
    expect(bt.config.startingChips).toBe(1000);
    for (const name of ['Freeroll', 'Daily 5K', 'Bounty Hunter']) {
      const t = byName(tm, name);
      expect(t.config.blindLevels).toEqual(lv(DEFAULT_LEVELS));
      expect(t.config.startingChips).toBe(1000);
    }
    const hs = byName(tm, 'High Stakes');
    expect(hs.config.blindLevels).toEqual(DEFAULT_LEVELS.map(([sb, bb, ante, duration]) => ({ sb: sb * 5, bb: bb * 5, ante: ante * 5, duration })));
    expect(hs.config.startingChips).toBe(1000);
  });

  test('the lobby item shows the structure: startingChips, levelSeconds (one length, else null), blindStructure', () => {
    const tm = new TournamentManager();
    const list = tm.getTournamentList() as any[];
    const sng = list.find((x) => x.name === 'Sit & Go');
    expect(sng.startingChips).toBe(1500);
    expect(sng.levelSeconds).toBe(300);
    expect(sng.blindStructure).toHaveLength(16);
    expect(sng.blindStructure[0]).toEqual({ level: 1, sb: 10, bb: 20, ante: 0, durationSec: 300 });
    expect(sng.blindStructure[15]).toEqual({ level: 16, sb: 5000, bb: 10000, ante: 1000, durationSec: 300 });
    const turbo = list.find((x) => x.name === 'Sit & Go Turbo');
    expect(turbo.startingChips).toBe(1500);
    expect(turbo.levelSeconds).toBe(180);
    const daily = list.find((x) => x.name === 'Daily 5K');
    expect(daily.startingChips).toBe(1000);
    expect(daily.levelSeconds).toBeNull();   // its levels have different lengths
    expect(daily.blindStructure[3]).toEqual({ level: 4, sb: 50, bb: 100, ante: 10, durationSec: 240 });
    // The existing keys are unchanged.
    expect(sng.blindLevelCount).toBe(16);
    expect(sng.blindLevel).toBe(1);
    expect(sng.minPlayers).toBe(9);
  });
});
