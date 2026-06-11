# Poker-server (Railway) — AGENT.md

> Per-app rules for the Socket.io game server backing americanpubpoker.online.
>
> Standalone GitHub repo: `sevendeucepoker72-ai/poker-server`. Not part of
> the mono-repo.

## Identity

- **Purpose:** Real-time game server — socket.io for poker tables, REST for fairness verification, hand-state persistence
- **Live URL:** https://poker-server-production-60c0.up.railway.app
- **Source:** `C:/Users/josh2/Downloads/developer setup/poker-server/`
- **Stack:** Node.js + TypeScript + Socket.io + Express (for REST)
- **Hosting:** Railway service `poker-server` (project ID `64b09936-5cd3-4bc8-834c-b77acb5d7605`)
- **Region:** **US East (Virginia)** since 2026-05-20. Was EU West (Amsterdam) before. Volume-attached services (`Postgres-dCcH`, `Redis-8Erh`) live in the same region. See SITES.md §2 for the deprecated EU services kept for 24h rollback.
- **Plan:** Railway **Pro** since 2026-05-20 (was Hobby; Hobby plan was the first to be paused during platform incidents and Hobby's deploy queue blocked our same-day hotfix path).
- **Database:** Postgres 18 SSL via `DATABASE_URL` env var. Currently references `${{Postgres-dCcH.DATABASE_URL}}`. (The poker-server in-memory state IS still ephemeral; "Database" here refers to the master-API-shared `users` table + per-user progression in Postgres, NOT a per-process SQLite.)
- **Cache:** Redis via `REDIS_URL` env var (hand-state snapshots). Currently references `${{Redis-8Erh.REDIS_URL}}`.

## Files an agent must read before editing

1. This file
2. `CLAUDE.md` (workspace root) — Pattern hard rules + chip-mutation rules
3. `SITES.md` §2 (Backend subsection)
4. `CONTRACTS.md` for fairness REST + socket contracts
5. `poker-server/.github/workflows/ci.yml` — what CI runs

## Build + deploy

```
railway up --service poker-server
```

CI on push/PR runs `npm run lint` (tsc --noEmit) + `npm test` (Jest) +
`npm run build`. `ship.sh poker-server` adds the cross-service contract
check on top.

## Hard rules (earned)

| # | Rule | Earned |
|---|---|---|
| 1 | **Set `REDIS_URL` on Railway.** Without it, hand-state rehydration is a no-op and in-progress hands are LOST on every redeploy. | Convention |
| 2 | **Graceful shutdown (`SIGTERM`/`SIGINT`) MUST flush state to DB.** Cash out seated chip stacks, flush in-memory XP/level/achievements. Don't hope hand-complete handlers have fired recently. | 2026-04-22 |
| 3 | **Chip mutations server-authoritative.** Only paths: `addChipsToUser` (additive SQL `chips = chips + $1`), `deductChips` (atomic), pot distribution at hand-complete, admin grants (audited). NEVER accept `chips` from a client socket payload. | 2026-04-22 (saveProgress mint vector) |
| 4 | **Player action nonces are deduped** (`actionNonces` Map, keyed `tableId:seat`) at `src/index.ts:~5700-5708`. Replay of same nonce returns "Duplicate action" error — clients treat as success (idempotent retry). | Convention |
| 5 | **Pino logger via `LOG_LEVEL` env** (default `info` in prod, `debug` in dev). | Convention |
| 6 | **Provably-fair deck commitments emit BEFORE hand starts**, seed reveal emits AFTER hand ends. Buffer 50 commitments per table in `ensureTableProgressListener`. REST `/api/fairness/*` reads from buffer + computes verification. | 2026-04-22 |
| 7 | **Admin socket handlers MUST `await isUserAdmin(auth.userId)`** before mutating state. Client-side route hiding is UX, not security. | 2026-04-22 |
| 8 | **`package.json` + `package-lock.json` commit together.** Mismatched lockfile breaks Railway's `npm ci`. Pre-push: `npm ci --dry-run`. | 2026-04-22 |
| 9 | **Regression-guard tests in `tests/PokerTable.test.ts`** — every state-machine fix gets a test that reproduces the bad state and asserts the fix. Wired into CI. | Convention |

## Surface area

### REST routes (see CONTRACTS.md)

- `GET /api/fairness/:tableId` — last 50 deck commitments
- `GET /api/fairness/:tableId/:handNumber` — verification record

### Socket.io events

See `src/index.ts`. Key events:
- Player: `action` (fold/check/call/raise/allIn, with nonce)
- Admin: `adminGrantChips`, `adminRestoreBalance`, `banUser` — all gated by `isUserAdmin`
- Server emits: `deckCommitment`, `deckSeedRevealed`, `tableState`, etc.

### Env vars

| Name | Required? | Purpose |
|---|---|---|
| `REDIS_URL` | **Required** | Hand-state snapshot persistence (rehydrate across redeploys) |
| `LOG_LEVEL` | Optional (default `info` prod) | Pino level |
| `ADMIN_PASSWORD` | Required | per SITES.md Railway env |
| `ADMIN_PHONE` | Required | per SITES.md Railway env |

## Deploy pre-flight

CI runs on every push/PR:
1. `npm run lint` — tsc --noEmit (typecheck)
2. `npm test` — Jest tests (including regression guards)
3. `npm run build` — tsc compile

If CI is red, do NOT `railway up`. Fix the typecheck/test failure first.

## Rollback

```
railway rollback
# OR redeploy a prior commit:
git checkout <prior-sha> && railway up --service poker-server
```

## Common workflows

### Fixing a state-machine wedge

1. Reproduce the bad state in `tests/PokerTable.test.ts` — start with the
   minimal scenario (heads-up, mid-bet, etc.)
2. Confirm the test FAILS with current code
3. Fix in `src/PokerTable.ts`
4. Confirm test PASSES
5. Commit both files together
6. `railway up` (or push and let CI verify first)

### Adding a new socket event

1. Handler in `src/index.ts` — gate by `isUserAdmin` if admin-only
2. Add to client emit path (poker-3d `tableStore.js` / `socketService.js`)
3. If new REST or unauth contract, update CONTRACTS.md

## Gotchas

- **SQLite is at `/data/poker.db` with NO persistent volume on Railway.**
  Database is ephemeral. Don't store anything you can't reconstruct from
  poker-prod-api on next boot.
- **Authenticates against poker-prod-api** then caches locally. If
  poker-prod-api `/users/login` shape changes (Pattern A risk), this
  service breaks for new logins.
- **`base: '/'`** is poker-3d frontend config, not this server. This
  server has no Vite.
- **Tournament rebalance does NOT re-check socket liveness post-disconnect.**
  Known issue, unfixed (low priority). (2026-06-10 audit note: the
  rebalance path at index.ts:~8411 DOES now check
  `io.sockets.sockets.get(tp.socketId)` before mutating; the residual
  race is a socket dropping between the check and the mutation, which
  reconnect recovery resolves. Effectively low-severity.)
- **`chipVelocityAlerts` count decay — FIXED (2026-06-10 audit
  verified).** `incrementChipVelocityAlert` (index.ts:419) applies
  retroactive decay (`count - floor(idle / 24h)`) on every alert, and
  that function is the ONLY consumer of the count (the auto-ban at
  index.ts:~1552 reads `incrementChipVelocityAlert()`'s return). A user
  with 2 stale alerts + 48h idle gets recomputed to 1 on their next
  alert, NOT banned. No stale-read path exists. The previous "never
  decays" note was stale.
