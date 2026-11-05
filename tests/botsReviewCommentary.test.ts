/**
 * Bots review 2026-11-04 (A-commentary) — the LLM table commentary goes only to
 * a table room somebody is in, and is counted on /api/health.
 *
 * Before: no check for a human or spectator, so a bot-only table made Haiku
 * calls whenever ANTHROPIC_API_KEY was set (modelled 1,150-1,600 calls/h,
 * $6-12/day), and whether the key was set at all was invisible.
 * Now: a notable hand at a table whose room (`table:<id>`: seated players and
 * spectators) is empty is skipped (skippedNoAudience) and does not consume the
 * 25 s throttle; tableCommentaryStats counts calls / delivered / emptyReplies /
 * failed; GET /api/health engine.commentary shows them with keyConfigured (a
 * boolean, never the key). The qualifier rule (commentarySkipped) runs first,
 * unchanged.
 *
 * REAL src/index.ts text: the handResult listener's commentary block (the slice
 * qualifierHelpToolsOff HT5 uses) + tableCommentaryStats.
 */
import { SRC, slice, load, flush } from './helpers/indexSource';

const BLOCK = slice('    // 2026-07-07 gap-fill [7] — LLM table commentary.', '    } catch { /* commentary is best-effort — never let it disrupt the hand */ }\n');
const NOTABLE = { results: [{ playerName: 'Ann', chipsWon: 5000, handName: 'Flush' }] };

function world(o: { key?: string; room?: string[]; reply?: 'text' | 'empty' | 'reject' } = {}) {
  const created: string[] = [];
  const reply = o.reply ?? 'text';
  class Anthropic {
    messages = {
      create: async () => {
        created.push('create');
        if (reply === 'reject') throw new Error('model down');
        return { content: [{ type: 'text', text: reply === 'empty' ? '   ' : 'What a pot!' }] };
      },
    };
  }
  const roomEmits: Array<[string, string, any]> = [];
  const rooms = new Map<string, Set<string>>();
  if (o.room) rooms.set('table:C1', new Set(o.room));
  const lastEmit = new Map<string, number>();
  // At 0dc1b96 there is no counter object: an inert one is supplied, so there the AUDIENCE rule is what fails, not a missing name.
  const stats = SRC.includes('const tableCommentaryStats = ')
    ? slice('const tableCommentaryStats = ', ';\n')
    : 'const tableCommentaryStats = { calls: 0, delivered: 0, emptyReplies: 0, failed: 0, skippedNoAudience: 0 };\n';
  const { exports: m, stubbed } = load(`${stats}\nfunction commentary(table, tableId, data) {\n${BLOCK}\n}`, {
    process: { env: o.key === undefined ? {} : { ANTHROPIC_API_KEY: o.key } }, Anthropic,
    tableCommentaryLastEmit: lastEmit, TABLE_COMMENTARY_MIN_INTERVAL_MS: 25_000,
    qualifierIdOfTable: (id: string) => (id === 'Q1' ? 'weekly-qualifier' : null),
    qualifierHelpToolsOff: { commentarySkipped: 0 },
    io: { to: (r: string) => ({ emit: (ev: string, d: any) => roomEmits.push([r, ev, d]) }), sockets: { adapter: { rooms } } },
  }, '{ commentary, tableCommentaryStats, qualifierHelpToolsOff }');
  const table = { wentToShowdown: true };
  return { m, stubbed, created, roomEmits, rooms, lastEmit, table };
}

describe('table commentary: only to a room somebody is in; counted', () => {
  it('(1) key set, a notable hand, NOBODY in the table room: 0 model calls, skippedNoAudience=1, the throttle not consumed (0dc1b96: a call was made)', async () => {
    const w = world({ key: 'k' });
    w.m.commentary(w.table, 'C1', NOTABLE);
    await flush();
    expect(w.created).toEqual([]);
    expect(w.roomEmits).toEqual([]);
    expect(w.m.tableCommentaryStats).toEqual({ calls: 0, delivered: 0, emptyReplies: 0, failed: 0, skippedNoAudience: 1 });
    expect(w.lastEmit.has('C1')).toBe(false);
    // Somebody sits down: the very next notable hand is commented at once.
    w.rooms.set('table:C1', new Set(['S1']));
    w.m.commentary(w.table, 'C1', NOTABLE);
    await flush();
    expect(w.created).toEqual(['create']);
    expect([...w.stubbed]).toEqual([]);
  });

  it('(2) one socket in the room: 1 call, delivered=1, the line emitted to the room', async () => {
    const w = world({ key: 'k', room: ['S1'] });
    w.m.commentary(w.table, 'C1', NOTABLE);
    await flush();
    expect(w.created).toEqual(['create']);
    expect(w.roomEmits).toEqual([['table:C1', 'tableCommentary', { text: 'What a pot!', type: 'llm' }]]);
    expect(w.m.tableCommentaryStats).toEqual({ calls: 1, delivered: 1, emptyReplies: 0, failed: 0, skippedNoAudience: 0 });
  });

  it('(3) the model rejects: failed=1, nothing emitted, nothing thrown', async () => {
    const w = world({ key: 'k', room: ['S1'], reply: 'reject' });
    expect(() => w.m.commentary(w.table, 'C1', NOTABLE)).not.toThrow();
    await flush();
    expect(w.roomEmits).toEqual([]);
    expect(w.m.tableCommentaryStats).toMatchObject({ calls: 1, delivered: 0, failed: 1 });
  });

  it('(4) an empty reply: emptyReplies=1, nothing emitted', async () => {
    const w = world({ key: 'k', room: ['S1'], reply: 'empty' });
    w.m.commentary(w.table, 'C1', NOTABLE);
    await flush();
    expect(w.roomEmits).toEqual([]);
    expect(w.m.tableCommentaryStats).toMatchObject({ calls: 1, delivered: 0, emptyReplies: 1 });
  });

  it('GUARD (passes at 0dc1b96 too) — (5) a qualifier table (watched or not): commentarySkipped++, no call, the audience rule never reached', async () => {
    const w = world({ key: 'k', room: ['S1'] });
    w.rooms.set('table:Q1', new Set(['S9']));
    w.m.commentary(w.table, 'Q1', NOTABLE);
    await flush();
    expect(w.created).toEqual([]);
    expect(w.m.qualifierHelpToolsOff.commentarySkipped).toBe(1);
    expect(w.m.tableCommentaryStats).toEqual({ calls: 0, delivered: 0, emptyReplies: 0, failed: 0, skippedNoAudience: 0 });
  });

  it('GUARD (passes at 0dc1b96 too) — (6) no key: nothing called, nothing counted', async () => {
    const w = world({ room: ['S1'] });
    w.m.commentary(w.table, 'C1', NOTABLE);
    await flush();
    expect(w.created).toEqual([]);
    expect(w.m.tableCommentaryStats).toEqual({ calls: 0, delivered: 0, emptyReplies: 0, failed: 0, skippedNoAudience: 0 });
  });

  it('GUARD (passes at 0dc1b96 too) — a hand that is not notable: not counted as skipped', async () => {
    const w = world({ key: 'k' });
    w.m.commentary({ wentToShowdown: false }, 'C1', { results: [{ playerName: 'Ann', chipsWon: 100 }] });
    await flush();
    expect(w.m.tableCommentaryStats.skippedNoAudience).toBe(0);
  });

  it('(7) /api/health engine.commentary: the key as a boolean only, the interval and the counts', () => {
    // Fix round 2 — built fail-safe (healthSection: a throw answers { error } for this section only).
    expect(SRC).toContain("commentary: healthSection('engine.commentary', () => ({ keyConfigured: !!process.env.ANTHROPIC_API_KEY, minIntervalMs: TABLE_COMMENTARY_MIN_INTERVAL_MS, ...tableCommentaryStats }))");
  });
});
