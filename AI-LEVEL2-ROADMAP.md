# .online AI — Level-2 blueprint roadmap (postflop CFR)

_Last updated 2026-07-07._

This doc scopes the **next** step beyond the current bots. It is a plan, not
shipped code. Read it before starting any "make the bots GTO" work.

## Where we are now (shipped)

| Level | Description | Status |
|---|---|---|
| 0 | Hand-tuned heuristic + Monte-Carlo equity | superseded |
| 1 | **Solver-INFORMED heuristic** — equity-ranked 169-hand percentiles, range-aware equity, adaptive/exploitative reads, archetype personalities | ✅ shipped `ce90655` |
| 1.5 | **Offline preflop Nash push/fold** — fictitious-play solve baked to a runtime lookup (`src/ai/pushFoldSolver.ts`) | ✅ shipped (this change) |
| 2 | **Offline postflop CFR blueprint** — abstracted equilibrium, cheap online lookup | ⬜ this roadmap |
| 3 | Neural self-play (ReBeL / Deep-CFR, ONNX sidecar) | ⬜ not planned |

Level 1.5 is the proof-of-concept for the Level-2 pattern: **solve offline, bake
a lookup, zero online compute.** `pushfold-solve.ts` (fictitious play over a
169×169 all-in equity matrix) → `pushFoldSolver.ts` (a baked table + lerp). It's
validated against published HU Nash charts. Level 2 is the same pattern applied
to the full pre+postflop game tree — which is orders of magnitude bigger and is
why it's a separate project, not a same-session change.

## Why Level 2 is a real project (honest scope)

No-Limit Hold'em has ~10^160 decision points. You cannot solve it directly; you
solve an **abstraction** and map real situations onto it. That's three hard
sub-problems, each a meaningful chunk of work:

1. **Card abstraction** — bucket ~2.4M canonical (hole, board) combos into a few
   thousand strategically-similar buckets (potential-aware / EMD clustering on
   equity distributions). Get this wrong and the blueprint plays the wrong hand
   class.
2. **Bet abstraction** — restrict the continuous bet space to a discrete menu
   (e.g. {33%, 66%, 100%, 150%, all-in}) per node. Wider menu = better play,
   exponentially more compute.
3. **Equilibrium compute** — run MCCFR / CFR+ for billions of iterations over
   the abstracted tree until exploitability is low. This is the compute-heavy
   part (hours-to-days on a many-core box, or a GPU implementation).

Then at runtime you need **action translation**: map the live pot/stack/board to
the nearest abstracted node and sample the blueprint's mixed strategy. Optionally
**subgame re-solving** (resolve the current subgame at higher resolution online)
— that reintroduces online compute and is what pushes toward Level 3.

## Recommended path: DON'T write a CFR solver from scratch

Re-implementing MCCFR + card abstraction correctly is a research effort with a
long tail of subtle bugs (we already saw fictitious-play oscillation on the tiny
preflop game — the full game is far less forgiving). Use a mature engine to
**generate** the blueprint offline, then bake it. Options, cheapest first:

- **TexasSolver** (open source, C++/GUI + CLI) — postflop solver. Script it over
  a grid of (preflop range pair × board bucket × stack depth × pot type) →
  export strategies → compress into a lookup. Best effort-to-quality ratio for
  Hold'em specifically. Flop-heavy; turn/river resolved per-node.
- **OpenSpiel** (DeepMind) — has CFR/MCCFR + Leduc/HU-Limit built in; good for a
  *limit* or simplified blueprint and for learning, weaker for full NLHE at
  scale without custom abstraction.
- **GTO+ / PioSOLVER CLI** — commercial, scriptable, highest quality; licensing
  cost, and check the license permits shipping derived strategy data in a
  product.
- **RLCard** — RL toolkit; more Level-3 (neural) than blueprint.

Recommendation: **TexasSolver CLI**, Hold'em only (the flagship game — Omaha /
short-deck / draw stay on the Level-1 heuristic). Scope the first cut to
single-raised and 3-bet pots, 100bb and 40bb, ~6 flop buckets × turn/river
resolve.

## Integration into this codebase (the part that touches our code)

The runtime shape mirrors `pushFoldSolver.ts` exactly:

1. Offline job produces a compact artifact — `src/ai/blueprints/holdem-100bb.bin`
   (or sharded JSON). Keyed by `(cardBucket, betHistoryNode)` → action
   frequencies. Target a few hundred MB max; memory-map or lazy-load shards.
2. New `src/ai/blueprintLookup.ts`: `blueprintAction(table, seat) ->
   {action, sizePctile} | null`. Returns null off-tree (deep/unusual spots) so
   the caller falls back to the Level-1 `postFlopStrategy`.
3. In `AIPlayer.decideAction`: **Hold'em + hard/expert only**, try the blueprint
   first; on null, fall back to the current heuristic. Keep easy/medium on the
   heuristic (they should be beatable and human — a blueprint bot is LESS fun for
   new players, and this is a **play-money social** site).
4. Preserve the human layer: keep the personality timing, the occasional
   deliberate imperfection, and chat — the blueprint decides *what*, the existing
   code still decides *when* and *how it feels*. A perfectly-GTO instant robot is
   a worse product here even though it's "stronger."
5. Storage/build: the artifact is generated, not hand-written — do NOT commit a
   multi-hundred-MB binary to git; fetch it at deploy from object storage, or
   ship a downsized bucket set. Add a canonical-features token if it becomes a
   feature we must not regress.

## Guardrails (unchanged platform rules)

- Chips are **play-money, no cash-out** — a stronger AI changes difficulty only,
  never the legal/economic model. Don't let a Level-2 effort drift into anything
  that looks like real-money gambling.
- AI decisions still flow through the SAME validated engine methods humans use
  (`scheduleAIAction → executeAIAction → decideAction`). The blueprint is a new
  *brain*, not a new action path — no engine bypass.
- Bot chip flows remain server-authoritative and audited.

## Effort estimate (rough)

- TexasSolver scripting + abstraction design + a first blueprint: ~1–2 weeks
  eng + meaningful offline compute.
- Runtime lookup + integration + A/B vs Level-1 (needs ~100k-hand eval to
  measure the edge — the quick sim can't): ~3–4 days.
- Verdict: worthwhile ONLY if "near-GTO hard bots" becomes a product priority.
  For today, **Level 1 + 1.5 is the right place to be** for a fun, tough,
  cheap, legal social game.
