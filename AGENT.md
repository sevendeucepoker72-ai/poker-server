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
| 10 | **Every play-entry handler calls `assertPlayable(socket, '<event>')` FIRST** — before leaving a table, standing up an AI, a buy-in, a seat or a credit consume. No master id → `login_required`; suspended master id (master `GET /users/:id/play-status/internal`, cached 60s, FAIL-OPEN) → `player_suspended` with the owner's exact sentence. Guest `register` is refused (`guest_disabled`). Spectating is never gated; nothing is pushed to a suspended player unprompted. A NEW seat/registration handler must be gated and added to the `GATED` list in `tests/playGate.test.ts`, which scans `src/index.ts` for the ordering. Logic: `src/auth/playGate.ts`. | 2026-10-07 (owner: 86'd player + guest play off) |
| 11 | **Every login handler registers with `loginTracker`; the seat restore is gated.** `login` / `oauthLogin` / `tokenLogin` / `authWithTicket` are registered via `trackLogin(socket, '<event>', async …)` and the waitlist auth bootstrap via `loginTracker.begin/release`, so a play tap racing a reconnect's login WAITS for it (bounded 6s, under poker-3d's 8s join watchdog) instead of getting `login_required`; disconnect calls `loginTracker.forget`. A NEW login path must do the same. Every reserved/orphan seat restore runs `refuseSeatRestoreIfBarred(...)` first (with `waitForLogin:false` — it runs inside the login), SKIPS its `playerSessions.set` on a non-null refusal, and sends the refusal AFTER `loginResult`. Suspended → seat stood up (`seat_restore_refused`); no account behind the session → seat HELD on its reservation, never destroyed (`seat_restore_held` — a retried oauthLogin can still claim it). Pinned by `tests/playGate.test.ts`. | 2026-10-07 (review: reconnect race + seat restore) |
| 12 | **Side features, tournament starts and live seats are gated too (2026-10-09).** `createStake` / `buyStake` / `placePredictionBet` / `placeSocialSideBet` / `redeemEntryCode` / `createPrivateTable` call `assertPlayable` first (listed in `GATED`); `buyStake` also refuses to pay a SUSPENDED seller ("Offer unavailable"), and EVERY `buyStakeResult` frame echoes the request's `offerId` (D3 — StakingMarketplace drops frames without one). Every free-chip tournament start goes through `screenAndStartTournament` (re-checks registrants, refunds + silently removes the suspended via `removeSuspendedRegistrants`, which re-reads each one from the LIVE field and refunds only on a real removal — `TournamentManager.unregisterPlayer` returns true ONLY when it removed a row, so a registrant who left during the screen's await is never refunded twice, D5); when those removals leave FEWER THAN 2 registrants the tournament is CANCELLED and the rest refunded through the one cancel-refund path (`cancelIfTooFewEligibleAfterScreen` + `refundCancelledTournamentEntrants`, shared with the stall sweep — S4) — never call `startTournamentGame` directly. A seated player found suspended is stood up at PokerTable `beforeHandStart` (before blinds: whole stack credited) from the CACHED play status only (`playStatusClient.peek` — the hand loop must never `await` the master); tournament seats are DISQUALIFIED first, ALL of a boundary's suspended entrants in ONE batch (`TournamentManager.disqualifyPlayers` flags every one before eliminating any — one at a time, the first elimination could finish the tournament and pay the next suspended player 1st place; S4) or the tournament can never finish; `payTournamentPrizes` gives a `disqualified` result no prize, no progression credit and no winner ticker. A main-seat stand-up then re-adds the socket as a SPECTATOR of that table (same steps as the `spectate` handler) so the client does not freeze on a seated view. | 2026-10-09 (owner: "Fix all of it") |
| 13 | **Resume tokens + guest carry-over (2026-10-09, decisions D1/D2).** ONLY `authWithTicket` and the waitlist bootstrap (a session the bootstrap itself created) put a 12h `resumeToken` on their success `loginResult` (key DERIVED from JWT_SECRET, `src/auth/resumeToken.ts`) — NEVER `oauthLogin` / `tokenLogin` (OIDC has its own refresh flow), the password `login`, or an `is_admin` row (`resumeFieldsFor` takes `isAdmin`; `checkResumeRow` refuses `admin_row`). Claims carry `orig_iat` (the ORIGINAL ticket login, passed through every resume unchanged) and the session `phone`; exp slides 12h per resume but is clamped to orig_iat + 24h (S4 — `resumeExpiresAt` never promises more) and a resume is refused `resume_invalid` once now - orig_iat > 24h (`session_too_old`). The explicit Sign Out is the socket `revokeSignInTokens` (T2 — a DEDICATED event: the live HEAD 5ea0f80 deletes the session on `logout`, so a client must never emit `logout`; a server that lacks `revokeSignInTokens` ignores it, so no deploy/rollback order can lose chips); the old `logout` is kept, same body, for COMPATIBILITY ONLY — no poker-3d bundle has ever emitted it, and poker-3d locks that (`blocked a socket logout emit`, U7); `resumeSessions.signOut.legacyLogoutEvents` should stay 0. Both ONLY bump `users.token_version` (revokes resume + legacy tokens everywhere) EXCEPT for a claimable guest row (its legacy token is the carry-over proof), AWAITED, then ack `{success, revoked}` | `{success:false, code: not_signed_in|revoke_failed|rate_limited}` (`revokeSignInTokensForSocket`): ONE per socket per 5s across both events; a sign-in in flight on the socket is waited for (`loginTracker.waitFor`, `DEFAULT_LOGIN_WAIT_MS`) before `not_signed_in` (T3). They must NEVER delete `authSessions` or stand anyone up (S1: that made the following disconnect stand a seated player up without crediting his stack; the disconnect handler owns the teardown, pinned by `tests/logoutSeatTeardown.test.ts`). `adminKickPlayer` bumps the kicked row the same way BEFORE dropping sockets (S4). `resumeSession` sets the session exactly like the original (incl. `masterUserId`, `phone` from the token), is a `trackLogin` login, gates its seat restore like `oauthLogin`, and restores ONLY the reservation keyed by the LOCAL userId — never a display-name scan (names collide). `resume_invalid` = definitive; DB/maintenance/rate-limit failures keep their own codes so the client never drops a good token. `claimGuestProgress` (`src/auth/guestClaim.ts`) needs an ATTESTED master id; a guest row is a `GuestNNNN` username with NO master stamp AND `created_at` < `2026-10-09T16:00:00Z` (rows made later — e.g. `register` under the guest-play rollback flag, 50k starting chips — are never claimable); the guest token may be EXPIRED but must be correctly signed, carry the row's exact `token_version` AND a `username` claim equal to the row's; locks the guest row `FOR UPDATE` first; ONE carry-over per caller ACCOUNT (local id or master id, checked at peek and again with the caller row locked → `already_claimed_by_account`, S4); chips move ONLY through `authManager.deductChips` / `addChipsToUser` on the transaction client (never a client value), stars additively, level/xp by ratchet (xp clamped to its level), achievements unioned PLUS every level achievement the raise newly unlocks written as already earned (never re-paid: `lifetimeAchievementsUnlockedByLevel`); retires (never deletes) the guest row; afterwards the GUEST's in-memory entry re-hydrates (persistStars is a GREATEST write) but the CALLER's is MERGED (`applyCarriedProgress`) — never reloaded, which would drop progress ahead of the row and skip rewards while un-hydrated. `users.stats`/`achievements` are TEXT on prod — no jsonb operators in that SQL. | 2026-10-09 (owner: "Fix all of it"; decisions D1/D2) |
| 14 | **The client never writes anything that pays out (D4).** The socket `saveProgress` handler passes ONLY `stats.clientData` to `authManager.saveProgress` (`src/progression/clientProgressSave.ts` `sanitizeClientProgressSave`). A client `level` / `xp` / `achievements` / `chips` or any other `stats` key is dropped (first occurrence per socket logged `client_payout_fields_dropped`): a client level ratcheted `users.level` and the next hand paid every level achievement (~14M chips); a client xp walked the paying level-up loop; client stats keys are read back by `hydrateFromDB` as server counters, `activeBoosters`, `vipExpiresAt` and the identity stamp. Server paths (hand-complete, `commitLevelUpReward`, disconnect, shutdown) persist real progression. Pinned by `tests/clientProgressSave.test.ts`. | 2026-10-09 (pre-existing hole since b5476ea6, closed per decision D4) |
| 15 | **A reserved TOURNAMENT seat is never cashed out and never bare-stood-up (T1).** When a disconnected player's reservation ends — `tickReservedSeatHands` at `DISCONNECT_HANDS_LIMIT`, or the `SEAT_RESERVE_MS` timer in the disconnect handler — a CASH seat is credited to the wallet and stood up; a TOURNAMENT seat (`isTournamentReservation`: the reservation's `tournament` snapshot OR `tournamentTables`) is only audited `TOURNAMENT_STACK_NOT_CASHED` (`reserve_hand_limit` / `reserve_expiry`, `seatKept:true`) and stays in play, blinded out by the turn timer until the hand-complete bust check eliminates it through TournamentManager. Crediting it minted tournament chips (never deducted from the wallet); a bare `standUp` left TournamentManager counting him alive, so the tournament could never finish. The snapshot exists because a table break deletes the id from `tournamentTables` (and the table 5s later) — the SIGTERM reserved-seat flush uses the same guard. Any NEW path that ends a reservation must do the same: decide "tournament?" by `isTournamentReservation(reserved)`, never by `tournamentTables.has(tableId)` alone (U3 — the tick, the expiry, the SIGTERM flush, the guest carry-over pre-step, the seat-restore gate and `clearGhostSeatsForUser` step 2 all do; the seat-restore gate never stands a tournament reservation up at all, it leaves it to the hand-start gate). After the hand limit the absent seat's turns use `ABSENT_TOURNAMENT_SEAT_TURN_MS` (3s) instead of the 30s clock (U4, `isAbsentTournamentSeatPastHandLimit` in `armTurnTimer`; a reconnect during it gets the rest of the 30s). Pinned by `tests/logoutSeatTeardown.test.ts` (real disconnect handler + tick + bust check + TournamentManager; control shows the HEAD mint) and `tests/absentSeat.test.ts` (U2-U4). | 2026-10-09 (pre-existing since the reserve cash-outs were added) |
| 16 | **`createStake` failure frames carry STABLE codes (T4)** — `error {message, code}` with `stake_sign_in_required` / `stake_invalid_offer` / `stake_invalid_price` / `stake_create_failed` (CONTRACTS.md C5, locked in canonical-features.txt). poker-3d StakingMarketplace settles a pending sell on the code, never the text — change a code only together with the client. | 2026-10-09 |
| 17 | **A login never finishes on a dead socket (U1).** A login handler awaits (token check, DB, the master, the seat-restore gate); if its socket drops meanwhile, the `disconnect` handler has ALREADY run (finding nothing to reserve) and never runs again, so anything the login then does on that socket is never cleaned up — a restored seat was bound to the dead socket, its reservation AND cash-out timer consumed, the stack never cashed out. Every login (`resumeSession`, `oauthLogin`, `tokenLogin` both branches, `authWithTicket`) calls `loginSocketGone(socket, via, stage, …)` after EACH await, before `authSessions.set` and before consuming a reservation, and returns on true; `refuseSeatRestoreIfBarred` returns right after its own await (`if (!socket.connected) return refusal;`) without touching any seat or reservation. A REAL reservation (timer + hand count) is never touched by the bail-out; only a SYNTHETIC one the login's own orphan scan built (`dropSyntheticReservationOf`). socket.io sets `connected=false` before emitting `disconnect`. A NEW login path, or a new await in one, must do the same — `tests/absentSeat.test.ts` scans every login handler: no session set / seat bound after an await without a check in between. `/api/health` `playGate.loginsAbandonedSocketGone`. | 2026-10-09 (review: resume finishing after disconnect; same pattern pre-existing in oauthLogin/tokenLogin) |
| 18 | **A suspended player's ABSENT tournament seat is disqualified at the hand-start gate (U2).** `standUpSuspendedSeatsBeforeDeal` screens, on a TOURNAMENT table, every occupied seat with no live socket behind it (reserved, past its reservation, post-restart orphan, stale session): identity from the TournamentManager entrant (`userId`), master id from the reservation's `masterUserId` snapshot, else `absentSeatMasterId` (row stats stamp, resolved in the BACKGROUND — the gate never awaits — and acted on at a later boundary). It joins the same `disqualifyPlayers` batch as the live seats; `standUpAbsentTournamentSeat` stands it up ONLY if that disqualification succeeded, ends its reservation + timer, credits nothing (`suspended_absent_disqualified`), pushes nothing. Cash-table absent seats are still left to their reservation. | 2026-10-09 (T1 corollary: kept in play to the end, a player suspended while away could be paid) |

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
| `OAUTH_CLIENT_SECRET` | **Required in prod** (boot-throws if missing) | Basic-auth secret for auth-server `/token/introspection` — validates EVERY .online OAuth login (`src/auth/oauthValidator.ts`). MUST equal GCP SM `poker-prod-poker-server-client-secret`; rotate ONLY via `rotate-poker-server-secret.sh` at workspace root. Wrong-but-present value = green deploy, all logins 401 — caught by the boot/30-min preflight (`/api/health` → `authClient`) since 2026-07-06 |
| `OAUTH_CLIENT_ID` | Optional (default `poker-server`) | Introspection client id |
| `AUTH_SERVER_URL` | Optional (default `https://auth.americanpubpoker.online`) | Introspection base URL |
| `AUTH_SERVER_BYPASS_KEY` | **Required in prod** (silent degradation if missing) | Sent as `X-Auth-Server-Key` on unauth master-API `/users/:id/me` fetches (ticket login, waitlist) AND gates `reportAuthEvent` auth-health telemetry — unset means telemetry is a silent no-op and those fetches break under `REQUIRE_AUTH_ENFORCE=1`. = master API's value |
| `MASTER_API_URL` | Optional (default prod Cloud Run URL) | Master API base for user fetches + auth-event reporting |
| `JWT_SECRET` | Required for legacy HS256 login **and resume tokens** | If unset in prod, legacy HS256 token auth is DISABLED (forgery guard, `src/auth/authManager.ts:19-28`) — OAuth login unaffected. Since 2026-10-09 it also derives the resume-token key (`getScopedSigningKey`); unset in prod = resume tokens OFF (`/api/health` `resumeSessions.enabled:false`) and the guest carry-over cannot verify guest tokens. Rotating it revokes every resume token and makes old guest tokens unclaimable. |
| `SENTRY_DSN` | Optional | Exception capture |
| `INTERNAL_NOTIFY_TOKEN` | **Required in prod** | `X-Internal-Token` for the master's internalAuth routes: qualifier-credit consume/refund/issue, qualifier schedule/register/results, and (2026-10-07) the play gate's `/users/:id/play-status/internal`. Unset = suspension checks FAIL OPEN (visible as `playGate.internalTokenConfigured:false` on `/api/health`) |
| `ONLINE_GUEST_PLAY_ENABLED` | **Leave unset** | EMERGENCY ROLLBACK ONLY. `1` re-allows guest `register` and no-account play, against the 2026-10-07 owner rule "nobody plays .online without an American Pub Poker account". Suspended players stay blocked either way. Shown as `playGate.guestPlayEnabled` on `/api/health` |

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
