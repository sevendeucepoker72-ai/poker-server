/**
 * 2026-10-11 — regression guards for the two P1s the independent R1 review
 * found (scratchpad r1review/driver_steal.cjs + driver_wl.cjs reproduced both
 * against the compiled server).
 *
 * R1REV-1: oauthLogin's "orphan-seat recovery (name)" bound a signing-in account
 * to ANOTHER account's live extra-table seat whose seat name equalled the
 * caller's display name (and leaveTable then paid that stack out). Seats are
 * restored only by account now; the name scan must never come back.
 *
 * R1REV-2 / GAME-13: the waitlist deep link filtered tables on the live
 * instance's variantId ('' | 'texas-holdem'), but every base PokerTable is
 * 'holdem', so the list was always empty. It must key on the table LIST's
 * `variant`, which the real TableManager reports as 'texas-holdem'.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TableManager } from '../src/game/TableManager';

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');

function handlerBody(event: string): string {
  const start = INDEX.indexOf(`socket.on('${event}'`);
  if (start < 0) throw new Error(`no ${event} handler`);
  const next = INDEX.indexOf("\n  socket.on('", start + 10);
  return INDEX.slice(start, next > 0 ? next : undefined);
}

describe('R1 review fixes', () => {
  test('R1REV-1: oauthLogin never matches a seat by player name', () => {
    const body = handlerBody('oauthLogin');
    expect(body).not.toMatch(/\[OAuth Reconnect\] orphan-seat recovery \(name\)/);
    expect(body).not.toMatch(/const recoverName\s*=/);
    expect(body).not.toMatch(/seat\.playerName\s*!==\s*recoverName/);
    // the only recovery left is BY ACCOUNT, with the same guards as tokenLogin's scan
    // R3 (live P1): by account — its user_<id> stamp OR a seat this account bought into (server-recorded alias)
    expect(body).toMatch(/if \(seat\.playerId !== expectedPlayerId && !seatBoughtInBy\(seat, userId\)\) continue;/);
    expect(body).toMatch(/if \(otherSessionHoldsSeat\(socket\.id, t\.tableId, i\)\) continue;/);
    expect(body).toMatch(/if \(seatReservedByOtherAccount\(userId, t\.tableId, i\)\) continue;/);
    expect(body).not.toMatch(/seat\.playerName\s*(!==|===)/);
    // nothing in the whole server synthesizes a reservation from a name match any more
    expect(INDEX).not.toMatch(/orphan-seat recovery \(name\): user/);
  });

  test('R1REV-2: the waitlist Hold\'em filter keys on the table list variant', () => {
    expect(INDEX).toMatch(/const isHoldem = \(t: any\) => t\?\.variant === 'texas-holdem';\n\s+const holdem = tables\.filter\(isHoldem\);/);
    expect(INDEX).not.toMatch(/return !id \|\| id === 'texas-holdem';/);
  });

  test('R1REV-2b: the waitlist link AND quickPlay only ever consider PUBLIC CASH tables (never a stranger\'s Spin & Go / heads-up / AoF / career / private / club table)', () => {
    // The re-verification (r1review/driver_wl2.cjs) seated a waitlist player into
    // another player's running Spin & Go (10/20 beats Beginner's 25/50 on "lowest
    // small blind") and into a private 5/10 home game. Both candidate lists must
    // keep only tableKindOf(...) === 'cash'.
    const filter = "const tables = tableManager.getTableList().filter((t) => !isTournamentTable(t.tableId) && tableKindOf(t.tableId) === 'cash');";
    expect(INDEX.split(filter).length - 1).toBe(2);
    expect(INDEX).not.toMatch(/const tables = tableManager\.getTableList\(\)\.filter\(\(t\) => !isTournamentTable\(t\.tableId\)\);/);
    // tableKindOf maps every non-public kind away from 'cash'
    const kindFn = INDEX.slice(INDEX.indexOf('function tableKindOf('), INDEX.indexOf("return 'cash';", INDEX.indexOf('function tableKindOf(')));
    for (const set of ['spinGoMultipliers', 'careerTables', 'allInOrFoldTables', 'quickTables', 'challengeTables', 'clubTableIds', 'privateTableIds']) {
      expect(kindFn).toContain(`${set}.has(tableId)`);
    }
  });

  test('R1REV-2: the real TableManager lists Hold\'em cash tables under that predicate', () => {
    const tm = new TableManager();
    const list = tm.getTableList();
    const holdem = list.filter((t: any) => t?.variant === 'texas-holdem');
    expect(holdem.length).toBeGreaterThan(0);
    // and the old instance-variantId predicate is what failed: base tables say 'holdem'
    const oldPredicate = (t: any) => {
      const id = (tm.getTable(t.tableId) as any)?.variantId || '';
      return !id || id === 'texas-holdem';
    };
    expect(list.filter(oldPredicate).length).toBe(0);
  });
});
