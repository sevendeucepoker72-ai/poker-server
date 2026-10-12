/**
 * 2026-10-12 — owner decision "loosen for pubs": since R2 the per-network
 * rules key on the REAL client address, so a pub's Wi-Fi (or a carrier's
 * shared IP) puts many real players behind one address.
 *   - connections per address: 25 (a flood guard), not 5;
 *   - two accounts from one network at one table: an ADMIN ALERT, never a refusal;
 *   - qualifier registrations: no per-network cap (an entry already needs a
 *     phone-verified account holding a credit).
 */
import { SRC, slice, handlerSrc, load } from './helpers/indexSource';

describe('per-network rules (owner: loosen for pubs)', () => {
  it('the connection cap is a flood guard of 25 per address', () => {
    expect(SRC).toContain('const MAX_CONNECTIONS_PER_IP = 25;');
  });

  it('joinTable never refuses a second player from the same network; it records an alert once he is seated', () => {
    const join = handlerSrc('joinTable', '\n    })(); }\n  );');
    expect(join).not.toContain('Another connection from your network is already seated at this table');
    const add = join.indexOf('mySlots.add(`${socket.id}:${tableSlotKey}`);');
    const note = join.indexOf('if (sameNetworkSockets.length > 0) noteSameNetworkSeat(');
    expect(add).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(add);
  });

  it('qualifier registration has no per-network cap', () => {
    expect(SRC).not.toContain("refuseQualifier('too_many_from_device'");
  });

  function noteWorld() {
    const warns: string[] = [];
    const audits: Array<[string, string, any]> = [];
    const playerSessions = new Map<string, any>([['S1', { playerName: 'Alice A.' }], ['S2', { playerName: 'Bob B.' }]]);
    const authSessions = new Map<string, any>([['S1', { userId: 11 }], ['S2', { userId: 12 }]]);
    const code = slice('const SAME_NETWORK_LOG_MAX = 25;', '\n}\n');
    const { exports: m } = load(code, {
      playerSessions, authSessions,
      auditLog: (a: string, action: string, d: any) => audits.push([a, action, d]),
      console: { warn: (l: string) => warns.push(l) },
    }, '{ noteSameNetworkSeat, sameNetworkSeats, networkStats, SAME_NETWORK_LOG_MAX }');
    return { m, warns, audits };
  }

  it('noteSameNetworkSeat: public seat names for the admin list, account ids only in the audit, no address anywhere', () => {
    const w = noteWorld();
    w.m.noteSameNetworkSeat('T1', { config: { tableName: 'Beginner\'s Table' } }, 'Carl C.', ['S1', 'S2'], 13);
    expect(w.m.networkStats.sameNetworkSameTable).toBe(1);
    expect(w.m.sameNetworkSeats).toEqual([expect.objectContaining({
      tableId: 'T1', tableName: 'Beginner\'s Table', seatedFromNetwork: 3, names: ['Alice A.', 'Bob B.', 'Carl C.'],
    })]);
    expect(w.audits).toEqual([['SYSTEM', 'SAME_NETWORK_SAME_TABLE', { tableId: 'T1', userIds: [11, 12, 13] }]]);
    expect(w.warns.join('\n')).toContain('"event":"same_network_same_table"');
    expect(w.warns.join('\n')).not.toMatch(/Alice|Bob|Carl|\d+\.\d+\.\d+\.\d+/);
  });

  it('the admin list keeps the newest 25', () => {
    const w = noteWorld();
    for (let i = 0; i < 30; i++) w.m.noteSameNetworkSeat(`T${i}`, undefined, 'X', ['S1']);
    expect(w.m.sameNetworkSeats).toHaveLength(w.m.SAME_NETWORK_LOG_MAX);
    expect(w.m.sameNetworkSeats[0].tableId).toBe('T5');
    expect(w.m.sameNetworkSeats[24].tableId).toBe('T29');
  });
});
