/**
 * Bots review fix round 3 (2026-11-05, SR2-5) — AGENT.md rule 35 says EVERY timer that reaches
 * the engine catches its throw. This walks src/index.ts with the TypeScript compiler API and
 * pins it, so the rule and the code cannot drift apart again (round 2's rule overclaimed while
 * the 500 ms auto-act, the absent stand-pat, the runout-hold releases, the Spin & Go deal, a
 * reservation's expiry and the rebalance cascade / sweep still escaped to processGuards).
 *
 * For every setTimeout / setInterval / setImmediate callback: the calls it makes SYNCHRONOUSLY
 * (through index.ts's own functions; never into a closure handed to another timer, a promise or
 * a listener, never into an async function — a throw there is a rejection, logged, not an exit)
 * that reach a hand-progress engine method. Such a call is GUARDED when some enclosing try on
 * the path has a catch that neither throws nor hands the error to a rethrowing helper
 * (settleDealThrow). Engine timers live only in index.ts (the walk of every other src file finds
 * none; TournamentManager's own timers reach no hand-progress call).
 *
 * Fails on 2b5ac52: 8 engine timers there are unguarded (0dc1b96: 17).
 */
import { SRC } from './helpers/indexSource';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ts = require('typescript');

const ENGINE = new Set([
  'startNewHand', 'playerFold', 'forceFoldSeat', 'awardIfUncontested', 'playerCheck', 'playerCall', 'playerRaise',
  'playerAllIn', 'playerDraw', 'completeDrawRoundIfDone', 'releaseDiscardHold', 'selectPineappleDiscard',
  'releaseRunoutHold', 'advanceTurn', 'determineWinners', 'completeHandAfterFault',
]);
const TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate']);
const ASYNC_SINKS = new Set(['onEvent', 'then', 'catch', 'finally', 'on', 'once', 'addListener', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'nextTick']);
const RETHROWERS = new Set(['settleDealThrow']);

type Row = { line: number; ctx: string; reaches: number; unguarded: number; sample: string };

function inventory(src: string): Row[] {
  const sf = ts.createSourceFile('index.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOf = (n: any) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const fns = new Map<string, any>();
  const collect = (node: any) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) fns.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && !fns.has(node.name.text)) fns.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const isAsync = (f: any) => !!(f.modifiers && f.modifiers.some((m: any) => m.kind === ts.SyntaxKind.AsyncKeyword));
  const calleeName = (call: any): { name: string; prop: boolean } | null => {
    const e = call.expression;
    if (ts.isIdentifier(e)) return { name: e.text, prop: false };
    if (ts.isPropertyAccessExpression(e)) return { name: e.name.text, prop: true };
    if (ts.isParenthesizedExpression(e) && ts.isPropertyAccessExpression(e.expression)) return { name: e.expression.name.text, prop: true };
    return null;
  };
  const rethrows = (block: any): boolean => {
    let found = false;
    const v = (n: any) => {
      if (found) return;
      if (ts.isThrowStatement(n)) { found = true; return; }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && RETHROWERS.has(n.expression.text)) { found = true; return; }
      if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) && n !== block) return;
      ts.forEachChild(n, v);
    };
    v(block);
    return found;
  };
  const memo = new Map<any, Array<{ guarded: boolean; path: string }>>();
  const scan = (fnNode: any, stack: Set<any>): Array<{ guarded: boolean; path: string }> => {
    if (memo.has(fnNode)) return memo.get(fnNode)!;
    if (stack.has(fnNode)) return [];
    stack.add(fnNode);
    const out: Array<{ guarded: boolean; path: string }> = [];
    const walk = (node: any, inTry: boolean) => {
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node !== fnNode) {
        const p = node.parent;
        if (p && ts.isCallExpression(p)) { const cn = calleeName(p); if ((cn && ASYNC_SINKS.has(cn.name)) || isAsync(node)) return; }
        else if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isReturnStatement(p))) return;
        else if (p && (ts.isArrowFunction(p) || ts.isFunctionExpression(p))) return;
        else if (p && ts.isParenthesizedExpression(p) && isAsync(node)) return;
      }
      if (ts.isFunctionDeclaration(node) && node !== fnNode) return;
      if (ts.isTryStatement(node)) {
        walk(node.tryBlock, inTry || (!!node.catchClause && !rethrows(node.catchClause.block)));
        if (node.catchClause) walk(node.catchClause.block, inTry);
        if (node.finallyBlock) walk(node.finallyBlock, inTry);
        return;
      }
      if (ts.isCallExpression(node)) {
        const cn = calleeName(node);
        if (cn && ENGINE.has(cn.name) && cn.prop) out.push({ guarded: inTry, path: `${cn.name}@${lineOf(node)}` });
        if (cn && !cn.prop && fns.has(cn.name) && !isAsync(fns.get(cn.name))) {
          for (const r of scan(fns.get(cn.name), stack)) out.push({ guarded: inTry || r.guarded, path: `${cn.name}>${r.path}` });
        }
      }
      ts.forEachChild(node, (c: any) => walk(c, inTry));
    };
    walk(fnNode.body || fnNode, false);
    stack.delete(fnNode);
    memo.set(fnNode, out);
    return out;
  };
  const ctxOf = (node: any): string => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) && p.name) return `fn ${p.name.text}`;
      if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parent && ts.isCallExpression(p.parent)) {
        const cn = calleeName(p.parent); const a0 = p.parent.arguments[0];
        if (cn && (cn.name === 'on' || cn.name === 'once') && a0 && ts.isStringLiteral(a0)) return `on('${a0.text}')`;
      }
    }
    return '(top level)';
  };
  const rows: Row[] = [];
  const find = (node: any) => {
    if (ts.isCallExpression(node)) {
      const cn = calleeName(node);
      if (cn && !cn.prop && TIMERS.has(cn.name)) {
        const cb = node.arguments[0];
        let target: any = null;
        if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) target = cb;
        else if (cb && ts.isIdentifier(cb) && fns.has(cb.text)) target = fns.get(cb.text);
        else if (cb && ts.isCallExpression(cb)) {
          const c = calleeName(cb);
          if (c && fns.has(c.name)) { target = fns.get(c.name); if (target.body && (ts.isArrowFunction(target.body) || ts.isFunctionExpression(target.body))) target = target.body; }
        }
        const reach = target && !isAsync(target) ? scan(target, new Set()) : [];
        const bad = reach.filter((r) => !r.guarded);
        rows.push({ line: lineOf(node), ctx: ctxOf(node), reaches: reach.length, unguarded: bad.length, sample: (bad[0] || reach[0])?.path ?? '' });
      }
    }
    ts.forEachChild(node, find);
  };
  find(sf);
  return rows;
}

describe('rule 35 — every timer in src/index.ts that reaches a hand-progress engine call catches its throw', () => {
  const rows = inventory(SRC);
  const engineTimers = rows.filter((r) => r.reaches > 0);

  it('none is unguarded (2b5ac52: 8; 0dc1b96: 17)', () => {
    expect(engineTimers.filter((r) => r.unguarded > 0).map((r) => `${r.line} ${r.ctx}: ${r.sample}`)).toEqual([]);
  });

  it('the walk sees the engine timers (sanity: the bot / deal / clock timers and every one round 3 guarded)', () => {
    expect(engineTimers.length).toBeGreaterThanOrEqual(25);
    const ctxs = engineTimers.map((r) => r.ctx);
    for (const c of ['fn scheduleAutoStart', 'fn scheduleAIAction', 'fn executeAIAction', 'fn armTurnTimer', 'fn broadcastGameState',
      'fn armAbsentDrawerStandPat', 'fn decideInsuranceHold', 'fn decidePineappleDiscardHold', "on('quickSpinGo')",
      'fn reserveSeatForDeparture', 'fn handleTableRebalance', 'fn tickQualifierAutoStart', 'fn standPatDrawRoundAfterFault']) {
      expect([c, ctxs.includes(c)]).toEqual([c, true]);
    }
  });

  it('POSITIVE CONTROL — the same walk flags a bare timer, a rethrowing catch and a settleDealThrow-only catch', () => {
    const src = [
      'function deal(t) { t.startNewHand(); }',
      'function a() { setTimeout(() => deal(table), 10); }',
      'function b() { setTimeout(() => { try { table.playerFold(0); } catch (err) { log(err); throw err; } }, 10); }',
      "function c() { setTimeout(() => { try { table.startNewHand(); } catch (err) { settleDealThrow('T', table, 'x', err); } }, 10); }",
      'function d() { setTimeout(() => { try { deal(table); } catch (err) { log(err); } }, 10); }',
      'function e() { setTimeout(async () => { table.playerFold(0); }, 10); }',
    ].join('\n');
    const r = inventory(src).map((x) => [x.ctx, x.reaches > 0 ? (x.unguarded > 0 ? 'UNGUARDED' : 'guarded') : 'no-engine']);
    expect(r).toEqual([['fn a', 'UNGUARDED'], ['fn b', 'UNGUARDED'], ['fn c', 'UNGUARDED'], ['fn d', 'guarded'], ['fn e', 'no-engine']]);
  });
});
