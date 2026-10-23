# Poker-server (Railway) — AGENT.md

> Per-app rules for the Socket.io game server backing americanpubpoker.online.
>
> Standalone GitHub repo: `sevendeucepoker72-ai/poker-server`. Not part of
> the mono-repo.

## Identity

- **Purpose:** Real-time game server — socket.io for poker tables, REST for fairness verification (in-progress hands do NOT survive a restart — hard rule 1)
- **Live URL:** https://poker-server-production-60c0.up.railway.app
- **Source:** `C:/Users/josh2/Downloads/developer setup/poker-server/`
- **Stack:** Node.js + TypeScript + Socket.io + Express (for REST)
- **Hosting:** Railway service `poker-server` (project ID `64b09936-5cd3-4bc8-834c-b77acb5d7605`)
- **Region:** **US East (Virginia)** since 2026-05-20. Was EU West (Amsterdam) before. Volume-attached services (`Postgres-dCcH`, `Redis-8Erh`) live in the same region. See SITES.md §2 for the deprecated EU services kept for 24h rollback.
- **Plan:** Railway **Pro** since 2026-05-20 (was Hobby; Hobby plan was the first to be paused during platform incidents and Hobby's deploy queue blocked our same-day hotfix path).
- **Database:** Postgres 18 SSL via `DATABASE_URL` env var. Currently references `${{Postgres-dCcH.DATABASE_URL}}`. (The poker-server in-memory state IS still ephemeral; "Database" here refers to the master-API-shared `users` table + per-user progression in Postgres, NOT a per-process SQLite.)
- **Cache:** Redis via `REDIS_URL` env var. Currently references `${{Redis-8Erh.REDIS_URL}}`. What it really keeps across a restart: the provably-fair revealed-commitment buffers (`/api/fairness/<old tableId>` still answers for the previous process's hands). Hand-state snapshots are WRITTEN on every broadcast but can never be restored — see hard rule 1 (2026-10-11, GAME-P3-9 / OPS-P3-8).

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
`npm run build` + the canonical-features.txt grep of `dist/`. There is NO
`poker-server` target in the workspace `ship.sh` (2026-10-11, OPS-3: this file
used to claim one) and Railway builds the pushed commit without waiting for CI,
so a red CI run does not block a deploy — check CI before `railway up`.
Run `npm ci` before testing locally: CI uses the LOCKFILE's TypeScript (6.x,
strict "use strict" emit); a stale local node_modules (TS 5.x) hid a red suite
for four deploys (tests that slice index.ts must declare every module-level
binding the slice assigns).

**Node 22 LTS everywhere (2026-10-11, OPS-4):** `nixpacks.toml` (`nodejs_22`,
the Railway build), `Dockerfile` (`node:22-alpine`), CI (`22.x`) and
`package.json` `engines` (`^22.12.0`) move together — change all four or none.
The floor is real: `jose` 6 is ESM-only and is loaded through `require(esm)`,
which Node 22 has unflagged only from 22.12 (Node 20 from 20.19). After a
deploy, the boot line `Poker server running on port … (Node v22.x.y)` names
the runtime (a nixpkgs `nodejs_22` older than 22.12 would crash at boot on the
jose import — the deploy healthcheck below then keeps the old deployment live).

**Railway deploy health (2026-10-11, OPS-5, `railway.json`):** a deployment
goes live only after `GET /api/health` answers 200 (`healthcheckPath`, within
`healthcheckTimeout` 120 s — the route answers as soon as the HTTP server
listens and a `SELECT 1` (+ a Redis PING once connected) returns under 1.5 s;
it answers 503 while the DB cannot, so a deploy whose DB is unreachable never
replaces the running one). Railway only uses it at deploy time — it is not a
liveness monitor. `restartPolicyType: ALWAYS`: a crash (the processGuards
flush exits 1) is restarted every time — `ON_FAILURE` with 3 retries left the
room down after a third crash. Crash notifications are an owner setting in
Railway (not in this repo).

## Hard rules (earned)

| # | Rule | Earned |
|---|---|---|
| 1 | **A redeploy / restart ENDS every hand in progress — nothing is rehydrated.** Table ids are new `uuidv4()`s on every boot (`TableManager` creates the default tables in its constructor; quick / private / club / tournament tables are created at runtime), so a Redis hand snapshot (`snapshotHand`, written every broadcast, flushed at shutdown) never matches a table of the new process, and the boot rehydrate (`scanHands` → `rehydrateFromSnapshot`) restores nothing. What protects players is the shutdown / crash flush (row 2, row 28 d): every seat's stack is credited once, what dies with the process is refunded. Do NOT "fix" rehydration by giving tables stable ids without first removing that flush's credit — a seat both credited at shutdown AND restored would be paid twice. **Set `REDIS_URL` anyway:** it keeps the provably-fair commitment buffers (`/api/fairness/*` for the previous process's hands). (Corrected 2026-10-11, GAME-P3-9 / OPS-P3-8 — this row used to promise that in-progress hands survive a redeploy; the snapshot writes are kept, unused.) | Convention; corrected .online R3 2026-10-11 |
| 2 | **Graceful shutdown (`SIGTERM`/`SIGINT`) MUST flush state to DB.** Cash out seated chip stacks, flush in-memory XP/level/achievements. Don't hope hand-complete handlers have fired recently. | 2026-04-22 |
| 3 | **Chip mutations server-authoritative.** Only paths: `addChipsToUser` (additive SQL `chips = chips + $1`), `deductChips` (atomic), pot distribution at hand-complete, admin grants (audited). NEVER accept `chips` from a client socket payload. | 2026-04-22 (saveProgress mint vector) |
| 4 | **Player action nonces are deduped** (`actionNonces` Map, keyed `tableId:seat`) at `src/index.ts:~5700-5708`. Replay of same nonce returns "Duplicate action" error — clients treat as success (idempotent retry). | Convention |
| 5 | **Pino logger via `LOG_LEVEL` env** (default `info` in prod, `debug` in dev). | Convention |
| 6 | **Provably-fair deck commitments emit BEFORE hand starts**, seed reveal emits AFTER hand ends. Buffer 50 commitments per table in `ensureTableProgressListener`. REST `/api/fairness/*` reads from buffer + computes verification. | 2026-04-22 |
| 7 | **Admin socket handlers MUST `await isUserAdmin(auth.userId)`** before mutating state. Client-side route hiding is UX, not security. | 2026-04-22 |
| 8 | **`package.json` + `package-lock.json` commit together.** Mismatched lockfile breaks Railway's `npm ci`. Pre-push: `npm ci --dry-run`. | 2026-04-22 |
| 9 | **Regression-guard tests in `tests/PokerTable.test.ts`** — every state-machine fix gets a test that reproduces the bad state and asserts the fix. Wired into CI. | Convention |
| 10 | **Every play-entry handler calls `assertPlayable(socket, '<event>')` FIRST** — before leaving a table, standing up an AI, a buy-in, a seat or a credit consume. No master id → `login_required`; suspended master id (master `GET /users/:id/play-status/internal`, cached 60s, FAIL-OPEN) → `player_suspended` with the owner's exact sentence. Guest `register` is refused (`guest_disabled`). Spectating is never gated; nothing is pushed to a suspended player unprompted. A NEW seat/registration handler must be gated and added to the `GATED` list in `tests/playGate.test.ts`, which scans `src/index.ts` for the ordering (2026-10-10: `returnToTournamentSeat`, S2, is on it). Logic: `src/auth/playGate.ts`. | 2026-10-07 (owner: 86'd player + guest play off) |
| 11 | **Every login handler registers with `loginTracker`; the seat restore is gated.** `oauthLogin` / `tokenLogin` / `authWithTicket` (the password `login` was removed 2026-10-11, AUTH-8) are registered via `trackLogin(socket, '<event>', async …)` and the waitlist auth bootstrap via `loginTracker.begin/release`, so a play tap racing a reconnect's login WAITS for it (bounded 6s, under poker-3d's 8s join watchdog) instead of getting `login_required`; disconnect calls `loginTracker.forget`. A NEW login path must do the same. Every reserved/orphan seat restore runs `refuseSeatRestoreIfBarred(...)` first (with `waitForLogin:false` — it runs inside the login), SKIPS its `playerSessions.set` on a non-null refusal, and sends the refusal AFTER `loginResult`. Suspended → seat stood up (`seat_restore_refused`); no account behind the session → seat HELD on its reservation, never destroyed (`seat_restore_held` — a retried oauthLogin can still claim it). Pinned by `tests/playGate.test.ts`. | 2026-10-07 (review: reconnect race + seat restore) |
| 12 | **Side features, tournament starts and live seats are gated too (2026-10-09).** `createStake` / `buyStake` / `placePredictionBet` / `placeSocialSideBet` / `redeemEntryCode` / `createPrivateTable` call `assertPlayable` first (listed in `GATED`); `buyStake` also refuses to pay a SUSPENDED seller ("Offer unavailable"), and EVERY `buyStakeResult` frame echoes the request's `offerId` (D3 — StakingMarketplace drops frames without one). Every free-chip tournament start goes through `screenAndStartTournament` (re-checks registrants, refunds + silently removes the suspended via `removeSuspendedRegistrants`, which re-reads each one from the LIVE field and refunds only on a real removal — `TournamentManager.unregisterPlayer` returns true ONLY when it removed a row, so a registrant who left during the screen's await is never refunded twice, D5); when those removals leave FEWER THAN 2 registrants the tournament is CANCELLED and the rest refunded through the one cancel-refund path (`cancelIfTooFewEligibleAfterScreen` + `refundCancelledTournamentEntrants`, shared with the stall sweep — S4) — never call `startTournamentGame` directly. A seated player found suspended is stood up at PokerTable `beforeHandStart` (before blinds: whole stack credited) from the CACHED play status only (`playStatusClient.peek` — the hand loop must never `await` the master); tournament seats are DISQUALIFIED first, ALL of a boundary's suspended entrants in ONE batch (`TournamentManager.disqualifyPlayers` flags every one before eliminating any — one at a time, the first elimination could finish the tournament and pay the next suspended player 1st place; S4) or the tournament can never finish; `payTournamentPrizes` gives a `disqualified` result no prize, no progression credit and no winner ticker. A main-seat stand-up then re-adds the socket as a SPECTATOR of that table (same steps as the `spectate` handler, including the P-g `detachSocketFromOtherTables` first — row 23) so the client does not freeze on a seated view. | 2026-10-09 (owner: "Fix all of it") |
| 13 | **Resume tokens + guest carry-over (2026-10-09, decisions D1/D2).** ONLY `authWithTicket` and the waitlist bootstrap (a session the bootstrap itself created) put a 12h `resumeToken` on their success `loginResult` (key DERIVED from JWT_SECRET, `src/auth/resumeToken.ts`) — NEVER `oauthLogin` / `tokenLogin` (OIDC has its own refresh flow), the password `login`, or an `is_admin` row (`resumeFieldsFor` takes `isAdmin`; `checkResumeRow` refuses `admin_row`). Claims carry `orig_iat` (the ORIGINAL ticket login, passed through every resume unchanged) and the session `phone`; exp slides 12h per resume but is clamped to orig_iat + 24h (S4 — `resumeExpiresAt` never promises more) and a resume is refused `resume_invalid` once now - orig_iat > 24h (`session_too_old`). The explicit Sign Out is the socket `revokeSignInTokens` (T2 — a DEDICATED event: the live HEAD 5ea0f80 deletes the session on `logout`, so a client must never emit `logout`; a server that lacks `revokeSignInTokens` ignores it, so no deploy/rollback order can lose chips); the old `logout` is kept, same body, for COMPATIBILITY ONLY — no poker-3d bundle has ever emitted it, and poker-3d locks that (`blocked a socket logout emit`, U7); `resumeSessions.signOut.legacyLogoutEvents` should stay 0. Both ONLY bump `users.token_version` (revokes resume + legacy tokens everywhere) EXCEPT for a claimable guest row (its legacy token is the carry-over proof), AWAITED, then ack `{success, revoked}` | `{success:false, code: not_signed_in|revoke_failed|rate_limited}` (`revokeSignInTokensForSocket`): ONE per socket per 5s across both events; a sign-in in flight on the socket is waited for (`loginTracker.waitFor`, `DEFAULT_LOGIN_WAIT_MS`) before `not_signed_in` (T3). They must NEVER delete `authSessions` or stand anyone up (S1: that made the following disconnect stand a seated player up without crediting his stack; the disconnect handler owns the teardown, pinned by `tests/logoutSeatTeardown.test.ts`). `adminKickPlayer` bumps the kicked row the same way BEFORE dropping sockets (S4). `resumeSession` sets the session exactly like the original (incl. `masterUserId`, `phone` from the token), is a `trackLogin` login, gates its seat restore like `oauthLogin`, and restores ONLY the reservation keyed by the LOCAL userId — never a display-name scan (names collide), never a VOLUNTARY tournament reservation (S2 P-b, row 23). `resume_invalid` = definitive; DB/maintenance/rate-limit failures keep their own codes so the client never drops a good token. `claimGuestProgress` (`src/auth/guestClaim.ts`) needs an ATTESTED master id; a guest row is a `GuestNNNN` username with NO master stamp AND `created_at` < `2026-10-09T16:00:00Z` (rows made later — e.g. `register` under the guest-play rollback flag, 50k starting chips — are never claimable); the guest token may be EXPIRED but must be correctly signed, carry the row's exact `token_version` AND a `username` claim equal to the row's; locks the guest row `FOR UPDATE` first; ONE carry-over per caller ACCOUNT (local id or master id, checked at peek and again with the caller row locked → `already_claimed_by_account`, S4); chips move ONLY through `authManager.deductChips` / `addChipsToUser` on the transaction client (never a client value), stars additively, level/xp by ratchet (xp clamped to its level), achievements unioned PLUS every level achievement the raise newly unlocks written as already earned (never re-paid: `lifetimeAchievementsUnlockedByLevel`); retires (never deletes) the guest row; afterwards the GUEST's in-memory entry re-hydrates (persistStars is a GREATEST write) but the CALLER's is MERGED (`applyCarriedProgress`) — never reloaded, which would drop progress ahead of the row and skip rewards while un-hydrated. `users.stats`/`achievements` are TEXT on prod — no jsonb operators in that SQL. | 2026-10-09 (owner: "Fix all of it"; decisions D1/D2) |
| 14 | **The client never writes anything that pays out (D4).** The socket `saveProgress` handler passes ONLY `stats.clientData` to `authManager.saveProgress` (`src/progression/clientProgressSave.ts` `sanitizeClientProgressSave`). A client `level` / `xp` / `achievements` / `chips` or any other `stats` key is dropped (first occurrence per socket logged `client_payout_fields_dropped`): a client level ratcheted `users.level` and the next hand paid every level achievement (~14M chips); a client xp walked the paying level-up loop; client stats keys are read back by `hydrateFromDB` as server counters, `activeBoosters`, `vipExpiresAt` and the identity stamp. Server paths (hand-complete, `commitLevelUpReward`, disconnect, shutdown) persist real progression. Pinned by `tests/clientProgressSave.test.ts`. | 2026-10-09 (pre-existing hole since b5476ea6, closed per decision D4) |
| 15 | **A reserved TOURNAMENT seat is never cashed out and never bare-stood-up (T1).** When a disconnected player's reservation ends — `tickReservedSeatHands` at `DISCONNECT_HANDS_LIMIT`, or the `SEAT_RESERVE_MS` timer in the disconnect handler — a CASH seat is credited to the wallet and stood up; a TOURNAMENT seat (`isTournamentReservation`: the reservation's `tournament` snapshot OR `tournamentTables`) is only audited `TOURNAMENT_STACK_NOT_CASHED` (`reserve_hand_limit` / `reserve_expiry`, `seatKept:true`) and stays in play, blinded out by the turn timer (row 23 P-i: check, a ≤ 1 BB pre-flop limp only when every seat in the hand is absent, else fold) until the hand-complete bust check eliminates it through TournamentManager. Crediting it minted tournament chips (never deducted from the wallet); a bare `standUp` left TournamentManager counting him alive, so the tournament could never finish. The snapshot exists because a table break deletes the id from `tournamentTables` (and the table 5s later) — the SIGTERM reserved-seat flush uses the same guard. Any NEW path that ends a reservation must do the same: decide "tournament?" by `isTournamentReservation(reserved)`, never by `tournamentTables.has(tableId)` alone; and ANY other "is this a tournament seat?" chip decision by `isTournamentTable(tableId)` (F2, 2026-10-10: a live tournament table OR one a rebalance broke — `brokenTournamentTables`, kept SEAT_RESERVE_MS + 1h; the disconnect snapshot itself, `handlePlayerLeave`, `creditSeatStackToWallet`, the guest pre-step, the SIGTERM flush, admin force-close, rebuy/moveSeat gates, the cash heartbeat; a broken table never deals again — `autoStartNextHand` returns, the socket `startHand` refuses it (`table_closed`, P5) and no cash buy-in can seat anyone on it (P5). Before F2 a player the rebalance did not move — it moved a session only via the REGISTRATION socket (P6 now moves every live session at the seat + the reservation; a session on a dying socket can still be left there) — who disconnected in the ≤5s window was reserved as CASH and the 6h expiry minted his stack; pinned by `tests/brokenTableWindow.test.ts`, whose wiring test fails on any new `tournamentTables.has(` chip decision) (U3 — the tick, the expiry, the SIGTERM flush, the guest carry-over pre-step, the seat-restore gate and `clearGhostSeatsForUser` step 2 all do; the seat-restore gate never stands a tournament reservation up at all, it leaves it to the hand-start gate). S2 (row 23): a voluntary leave's reservation is this same reservation, started past its hand limit and flagged `voluntary` (no sign-in restores it). After the hand limit the absent seat's turns use `ABSENT_TOURNAMENT_SEAT_TURN_MS` (3s) instead of the 30s clock (U4, `isAbsentTournamentSeatPastHandLimit` in `armTurnTimer`; a reconnect during it gets the rest of the 30s). Round 6 (row 23 P-j): so does a tournament seat whose session sits out (`tournamentSeatSitsOut` — dealt in, blinds posted live); sitting back in during it gets the rest of the 30s too. Pinned by `tests/logoutSeatTeardown.test.ts` (real disconnect handler + tick + bust check + TournamentManager; control shows the HEAD mint) and `tests/absentSeat.test.ts` (U2-U4). | 2026-10-09 (pre-existing since the reserve cash-outs were added) |
| 16 | **`createStake` failure frames carry STABLE codes (T4)** — `error {message, code}` with `stake_sign_in_required` / `stake_invalid_offer` / `stake_invalid_price` / `stake_create_failed` (CONTRACTS.md C5, locked in canonical-features.txt). poker-3d StakingMarketplace settles a pending sell on the code, never the text — change a code only together with the client. | 2026-10-09 |
| 17 | **A login never finishes on a dead socket (U1).** A login handler awaits (token check, DB, the master, the seat-restore gate); if its socket drops meanwhile, the `disconnect` handler has ALREADY run (finding nothing to reserve) and never runs again, so anything the login then does on that socket is never cleaned up — a restored seat was bound to the dead socket, its reservation AND cash-out timer consumed, the stack never cashed out. Every login (`resumeSession`, `oauthLogin`, `tokenLogin` both branches, `authWithTicket`; since F3 also the `joinWithWaitlistContext` auth bootstrap) calls `loginSocketGone(socket, via, stage, …)` after EACH await, before `authSessions.set` and before consuming a reservation, and returns on true; `refuseSeatRestoreIfBarred` returns right after its own await (`if (!socket.connected) return refusal;`) without touching any seat or reservation. A REAL reservation (timer + hand count) is never touched by the bail-out; only a SYNTHETIC one the login's own orphan scan built (`dropSyntheticReservationOf`). socket.io sets `connected=false` before emitting `disconnect`. A NEW login path, or a new await in one, must do the same — `tests/absentSeat.test.ts` scans every login handler: no session set / seat bound after an await without a check in between. (A LIVE socket another account's login took during those awaits is row 21's Q3 check, `loginSessionReplaced`.) `/api/health` `playGate.loginsAbandonedSocketGone`. | 2026-10-09 (review: resume finishing after disconnect; same pattern pre-existing in oauthLogin/tokenLogin) |
| 18 | **A suspended player's ABSENT tournament seat is disqualified at the hand-start gate (U2).** `standUpSuspendedSeatsBeforeDeal` screens, on a TOURNAMENT table, every occupied seat with no live socket behind it (reserved, past its reservation, post-restart orphan, stale session): identity from the TournamentManager entrant (`userId`), master id from the reservation's `masterUserId` snapshot, else `absentSeatMasterId` (row stats stamp, resolved in the BACKGROUND — the gate never awaits — and acted on at a later boundary). F4 (2026-10-10): a QUALIFIER entrant has NO local userId — he is identified by the master id his qualifier registration holds (`TournamentPlayer.masterUserId`, set by `startQualifierTournament` from `masterPlayerId`; else looked up in `qualifierTournaments`) via `absentEntrantIdentity`; his local id is the reservation holder at that seat or null. Before F4 he was skipped and a suspended qualifier entrant who was away got a qualifier result (`tests/handStartRebalance.test.ts`). It joins the same `disqualifyPlayers` batch as the live seats; `standUpAbsentTournamentSeat` stands it up ONLY if that disqualification succeeded, ends its reservation + timer, credits nothing (`suspended_absent_disqualified`), pushes nothing. Cash-table absent seats are still left to their reservation. | 2026-10-09 (T1 corollary: kept in play to the end, a player suspended while away could be paid) |
| 19 | **A hand is never started twice; a hand-start disqualification never leaves anyone seatless (F1).** The hand-start gate runs INSIDE `PokerTable.startNewHand`; its disqualifications eliminate entrants and (multi-table) trigger `handleTableRebalance`. That rebalance is HELD (`holdTournamentRebalance` / `tournamentRebalanceIsHeld` at the top of `handleTableRebalance`) until the boundary's suspended seats are stood up, then run by `releaseTournamentRebalance` before the deal; if it broke the starting table, `table.vetoHandStart('tournament_table_broken')` makes `startNewHand` return false before anything is reset or posted. `PokerTable.startNewHand` refuses a NESTED call on the same table (`start_new_hand_reentrant_refused`; FiveCardDraw/SevenStud overrides defer to it before resetting variant state); the rebalance restart loop skips `isStartingHand()` tables; the rebalance relocates stacks with `sitDown(…, allowBelowMin=true)` (tournament `minBuyIn` = the STARTING stack — short stacks were refused by every seat and left seatless). A NEW `beforeHandStart` listener must never start a hand itself. `/api/health` `tournamentSafety` (`reentrantStartsRefused` should stay 0). Pinned by `tests/handStartRebalance.test.ts` (real PokerTable + TournamentManager + gate + rebalance + event wiring; controls show the seatless player and the nested start). **P1 (2026-10-10):** `TournamentManager.checkRebalance(tid, freeSeatsOf)` breaks a table only when the other tables' free seats (index.ts `tournamentFreeSeats`: empty + BUSTED seats — eliminated, 0 chips, entrant out) hold every player it moves; ALWAYS call it through `planTournamentRebalance` (never bare). Busted seats are stood up just before reuse (`vacateBustedTournamentSeat` — the busted entrant's session/reservation/pending-removal pointers are dropped, he spectates); the placement is planned first and the break aborted if seats are missing (`breaksAbortedNoSeats`, should stay 0); a table is never broken MID-HAND (`tournamentBreaksAwaitingHandEnd`, run at its `autoStartNextHand`); a 0-chip pending bust is never moved (it was resurrected with its starting stack) — **Q1 (2026-10-10): the break WAITS for that table's bust check instead of skipping him.** The P1 skip assumed the rebalance runs from inside the broken table's OWN bust loop; ANOTHER table's bust (or the 5s sweep) could break a table while its `handleHandComplete` was still in its per-player DB awaits — the 0-chip entrant was not moved and, the table having left `tournamentTables`, never eliminated: the tournament could never finish. Now a break table holding an occupied, NOT eliminated, 0-chip seat of an entrant TournamentManager still counts alive (`pendingTournamentBustSeat`) is not at its hand boundary: the break is DEFERRED like a mid-hand one (`tournamentBreaksAwaitingHandEnd`, `tournamentSafety.breaksDeferredPendingBust`, log `rebalance_pending_bust_not_moved` with `outcome:'break_deferred'`), and re-run by that table's own bust check (`playerEliminated`), its `autoStartNextHand` and the 5s sweep (corrected by row 23 / S1: before S1 that `autoStartNextHand` still DEALT a break table with 5+ alive, and the socket `startHand` dealt regardless — S1 now holds every deal of a table whose bust check is pending) (`sweepTournamentRebalances` — now services EVERY tournament each tick, `continue` not `break`). Second lock: `handleHandComplete` resolves the tournament as `tournamentTables.get(tableId) ?? brokenTournamentTables.get(tableId)?.tournamentId` AFTER its awaits (a bust on a just-broken table is still eliminated, exactly once, with its eliminator; `bust_check_on_broken_table`), and each player's progress persistence there is isolated (try/catch) so the bust check always runs. **Q2:** every per-entrant seat lookup is his LIVE seat — `tournamentLiveSeatIndex` / `tournamentLiveSeatOf` (occupied, NOT eliminated, his playerId): the mover's `breakSeatIdx` (and so P6), the bounty credit (M2, 2026-10-10: read AFTER the elimination — a bust that breaks the eliminator's own table pays his NEW live seat), and placeability (a qualifier RE-ENTRY reuses the playerId and leaves the old busted seat occupied — a playerId-only lookup took the mover for a pending bust and stranded him; that dead seat now counts as free capacity). A qualifier re-entry whose socket has no session (its busted seat was vacated for a mover) gets one created (`reentrySessionsCreated`); a short table that cannot be broken DEALS (`autoStartNextHand` waits only when `planTournamentRebalance` returns a break). **P2:** the restart step (`restartWaitingTournamentTables`) never calls `startNewHand` on a HandComplete table — `scheduleAutoStart` instead (it runs inside a table's own `handResult` emit); `PokerTable` refuses `startNewHand` while a hand is completing (`_completingHand` around every `handResult`/`handHistory` emit — `start_new_hand_while_completing_refused`, `completingHandStartsRefused` should stay 0) and `determineWinners` reveals the commitment read BEFORE its listeners ran — the published seed is always the finished hand's. Every determineWinners — the base AND the Omaha / Stud HI-LO overrides — ends through `PokerTable.emitHandCompletion(results, handHistory|null)` (the hi-lo overrides emitted `handResult` themselves and never revealed their seed: no hi-lo hand could be verified on `/api/fairness`); a variant must never emit `handResult` itself. Pinned by `tests/rebalanceSafety.test.ts` (controls: seatless TA 6/TB 5, busted seats, stall, mid-hand pot loss, zombie stack, nested start, pre-P6 stuck session; Q1 e1 race with real awaits — pre-Q1 control strands b3 forever, (a) and (b) each fix it alone; Q2 e3 re-entry, dead-seat capacity, bounty to the live seat; hi-lo seed reveal; sweep starvation). | 2026-10-10 (review fin6: re-entrant start destroyed blinds, moved player seatless; fu review: capacity, busted seats, seed reveal; pe review: Q1/Q2) |
| 20 | **A buy-in never finishes on a dead socket (F3).** Every seat-buying handler calls `buyInSocketGone(socket, via, stage, refund?)` after EACH await and before it seats / registers / tops up; once the deduct has succeeded it passes `refund`, so a dropped socket gets the buy-in back EXACTLY ONCE through `addChipsToUser` (audited `socket_gone`) and nothing is seated (the `disconnect` already ran with no seat to reserve, and never runs again — before F3 the stack was seated on the dead socket and never cashed out). Covered: `joinTable` (+ `joinClubTable` / club challenges), `quickPlay`, `joinWithWaitlistContext`, `rebuy`, `quickHeadsUp`, `quickSpinGo`, `quickAllInOrFold`, `startCareerGame`, `joinAdditionalTable`, `joinByInviteCode`, `registerTournament`, the qualifier re-entry (chips + the credit refunded). A NEW buy-in path must do the same — `tests/buyInSocketGone.test.ts` drives every one of them on a dead socket (refunded once, not seated) and its wiring test fails on a deduct without a check before the next await. `/api/health` `playGate.buyInsAbandonedSocketGone`. **P3 (2026-10-10): a LIVE socket too** — each path passes the state it was priced against as `buyInSocketGone(…, refund?, expect)` (`userId`, `mainSession` — null for a join, the same object for a rebuy — `table`, and for a top-up the `seat` object); a change → refunded once (reason `user_changed` / `session_changed` / `table_gone` / `seat_gone`), nothing seated, the socket answered (`buy_in_cancelled`). A NEW buy-in path passes its expectation too (the wiring test checks every deduct). `playGate.buyInsAbandonedStateChanged`. | 2026-10-10 (review fin6, pre-existing since the buy-in deducts; fu review: rebuy lost the top-up on a live socket) |
| 21 | **A login never inherits another account's seat (P4).** Every handler that sets `authSessions` for a socket (`login`, `register`, `oauthLogin`, `tokenLogin` ×2, `authWithTicket`, `resumeSession`, the waitlist bootstrap) calls `releaseSocketForAccountSwitch(socket, nextUserId, via)` immediately before the set (nothing awaited between): a DIFFERENT previous account's main seat is reserved for it (`reserveSeatForDeparture` — the disconnect handler's own reservation code, extracted, so cash → credited to that account at expiry, tournament → T1), its extra-table seats cashed out to it (`cashOutAdditionalSeatsOnDeparture`), an unreservable session left normally, an account-less seat stood up with no credit (S2: an account-less LIVE TOURNAMENT seat is kept in play, absent, instead — never adopted either). `joinWithWaitlistContext` refuses `account_mismatch` when the socket's existing session is not provably the ticket's master account, and its bootstrap never overwrites a session that landed during its awaits. A NEW login path must call the release before its `authSessions.set` (absentSeat.test wiring counts them). `playGate.accountSwitches`, `playGate.waitlistAccountMismatches`. **Q3 (2026-10-10) — a login can be OVERTAKEN on a live socket.** Every login that restores a seat (`oauthLogin`, `tokenLogin` both branches, `resumeSession`) keeps the session object it set (`authSessions.get(socket.id)!` right after the set) and passes it to the seat-restore gate (`refuseSeatRestoreIfBarred(…, mine)` acts on nothing once overtaken); right after the gate (after its `loginSocketGone` check) it calls `loginSessionReplaced(socket, mine, …)`: if ANOTHER account's login took the socket meanwhile (`socketSessionOvertaken` — a newer session of the SAME local user is not an overtake), the login stops: no seat restored, no `reconnectedToTable`, no `loginResult`, a REAL reservation + its timer left intact (cash: credited to its owner once at expiry), a SYNTHETIC one dropped, the other account's session untouched (`playGate.loginsAbandonedSessionReplaced`). Before Q3 the overtaken login restored its seat under the other account and every later cash-out credited that account. A NEW await between a login's `authSessions.set` and its restore needs both checks. The post-restart orphan-seat scans (oauthLogin by display NAME, tokenLogin by playerId) skip a seat RESERVED for another account (`seatReservedByOtherAccount` — ticket names collide) and never scan a TOURNAMENT table at all (`isTournamentTable`, pe3 minor — a name is not an account; a tournament seat comes back only by its reservation or by account, row 23). Tournament starts (`startTournamentGame`, `startQualifierTournament`) bind a registrant's seat only to a socket still signed in as HIM (`bindRegistrantSocket`: local userId, or a qualifier entrant's master id; else his own other live seat-less socket; else none — the seat is dealt in absent; `TournamentPlayer.socketId` follows, `''` = none; `tournamentSafety.registrantSockets`; M5: such an absent seat is found by every seat-restoring sign-in BY ACCOUNT — never one he left voluntarily, P-b — row 23). **M3:** the release also moves the previous account's tournament records off the socket (`detachTournamentEntrantSockets` — his own other live socket, else `''`), and the bust check tells an elimination only to a socket signed in as that entrant (`tournamentEntrantSocket`; P-e': made a spectator only if that socket holds the player session AT that table — read before the elimination — and none at another table; an away entrant's socket only gets the plain `playerEliminated` notice — round 6: ONE notice, the room's copy skips it — row 23). | 2026-10-10 (fu review: shared-browser deep-link race credited A's stack to B / charged B for A's link; pe review: Q3 + minors) |
| 22 | **A cash buy-in never lands on a tournament table (P5).** `joinTable` (+ clubs), `joinAdditionalTable`, `joinByInviteCode` refuse `isTournamentTable(tableId)` before any side effect (`refuseCashJoinAtTournamentTable`, code `tournament_table`); `quickPlay` and the waitlist deep link filter tournament tables out of their candidates (`getTableList` still lists them — spectating). Every cash-out path treats such a seat as a tournament seat, so the buy-in was never returned. `playGate.cashJoinsRefusedAtTournamentTable`. | 2026-10-10 (fin7 open issue #1) |
| 23 | **A tournament table never deals before the LAST hand's bust check has run, and a bust check never takes a seat that is in a hand in progress; a leave never stands a live tournament seat up (S1/S2, 2026-10-10; V1 + the S2 protocol P-a..P-l, pe3, amended after pe4 — round 5: P-c', P-e', P-g, P-h, the P-f away gap — and SIMPLIFIED after pe5 — round 6: P-c'', P-h', P-i, P-j, P-k, P-l, the dead-seat detach, one elimination notice).** S1/V1: `handleHandComplete` CAPTURES its bust check synchronously (`captureTournamentBustCheck`, before its first await) and registers it as PENDING for EVERY completed tournament hand — a no-bust hand too (V1 a: before, only a hand that left a 0-chip seat was pending, so a no-bust hand's check ran during the NEXT, already dealt hand) — and runs it after its awaits (`runTournamentBustCheck`, then `rekickTournamentDealAfterBustCheck`); `autoStartNextHand` holds a tournament table's deal while ANY capture is pending or a 0-chip entrant still alive sits there (`tournamentDealWaitsForBustCheck` → `holdTournamentDealForBustCheck`; a capture older than `TOURNAMENT_BUST_CHECK_STALE_MS` (20s) is run by the guard, an uncovered bust is checked there, a THROWING handler's capture is run by the `handResult` listener's `.catch` — `runPendingTournamentBustChecks`); the socket `startHand` on a LIVE tournament table is `autoStartNextHand` at a hand end and otherwise deals only when `tournamentDealHoldReason` is null (`tournament_hand_held`). V1 b: a bust check (any capture, the stale / uncovered runs) settles its capture's `bustedThisHand` (credited to that hand's pot winners) plus leftovers, and NEVER a seat with chips invested in a hand IN PROGRESS (`inHandInProgress` — an all-in of the next hand; that hand's own capture settles him). Second lock: it also eliminates a 0-chip seat PokerTable already flagged while the entrant is alive with no other live seat (`bust_check_leftover_eliminated`). NEVER add a tournament deal path that skips these. **P-l** (round 6, pe5 nit): the per-player DB writes `handleHandComplete` awaits before the check (`mergeUserStats` → `saveProgress` → `tickScratchProgress`) run SERIALLY, one player at a time — the loop is the same as at HEAD 4666417 (round 5 fanned them out in parallel, which asked the 10-connection pool for one connection per human at once on every table, cash included; reverted — do not fan them out again); the check still runs only after ALL of them — never move it ahead of the writes (S1 / Q1 / V1 rely on that order). M1: a break mover with no LIVE seat is never seated (`settleTournamentEntrantWithoutLiveSeat`, `TOURNAMENT_ENTRANT_ELIMINATED_NO_LIVE_SEAT`). S2 — THE PROTOCOL (poker-3d implements the same names; CONTRACTS C5; the header comment above `tournamentSeatKeep` lists P-a..P-k): **P-a** `handlePlayerLeave(socket, kind)` asks `keepTournamentSeatOnLeave` FIRST; a live entrant's seat stays in play, absent (reserved like a disconnect's T1 reservation but past its hand limit → short clock; an existing reservation of ANOTHER seat is never overwritten). The socket's session ends FIRST — `socket.leave(room)`, session deleted, delta baseline dropped — BEFORE the keep's fold / broadcast, so the leaving socket gets NO further gameState for that table. kind `'voluntary'` (default: `leaveTable`, and joinTable / quickPlay / joinWithWaitlistContext / spectate / quickHeadsUp / quickSpinGo / quickAllInOrFold / startCareerGame leaving first; round 5: `joinByInviteCode` — it used to OVERWRITE the session, the seat left absent with no reservation / mark / notice — and `spectateTournament`, a LIVE seat only): reservation `voluntary: true` + `voluntarilyAbsentTournamentEntrants` (by entrant — survives a move and the reservation's end; ended by a return; pruned on read and by the 5s sweep once the entrant is out / the tournament over; MEMORY ONLY — after a restart every absent seat is non-voluntary again and is auto-restored by account), audit `TOURNAMENT_STACK_NOT_CASHED` reason `voluntary_leave_seat_kept`, `tournamentSeatKept {tournamentId, tableId, seatIndex, tournamentName, chips}` to the socket (signed-in sockets only) with the seat's position AFTER the keep (`tournamentSeatLocationNow`; round 5: the keep's fold can end the hand and its bust check break the table synchronously — V4 skips a socket inside its own keep (`keepingTournamentSeatOnLeave`) and the keep tells it the FINAL seat once; nothing if the seat is no longer in play). kind `'kept'` (a suspended — or, P-k, banned — own seat at a re-login, a hand-start stand-up whose DQ failed, an account switch, the disconnect fall-through, every admin kick / IP-ban leave — after its DQ, or a kick that does not target this seat's tournament): kept the same, unflagged, untold (`leave_seat_kept_absent`). **P-b** no sign-in (oauthLogin, tokenLogin ×2, resumeSession, authWithTicket, the waitlist bootstrap) ever restores a VOLUNTARY seat: the reservation paths skip `reserved.voluntary` (left intact), `refuseSeatRestoreIfBarred` does not count it, `restoreAbsentTournamentSeat` (by account) excludes it; after the normal answer (`loginResult`, then any C5 refusal frame; the waitlist bootstrap: after its successful seat) `tellKeptTournamentSeats` sends `tournamentSeatKept` per voluntary seat (current table/seat; only while the socket is still signed in as that account; try/catch — never breaks a login; authWithTicket: `'all'` — a disconnect's absent seat too; secondary `skipSeatRecovery` sockets: nothing). A DISCONNECT's reservation keeps its auto-restore and every reservation-path `reconnectedToTable` carries `tournamentId` (`reconnectTournamentFields`). The display-name orphan scan (oauthLogin) and the playerId scan (tokenLogin) skip tournament tables. A sign-in NEVER takes a seat another LIVE socket plays — not even one of the same account (only a Return does, P-c''); a locally banned account's restore is refused `player_suspended` (P-k). **P-c** `returnToTournamentSeat [{tournamentId?}] [ack]` (gated — `assertPlayable` first, then `bannedAccountRefusal` (P-k: a locally BANNED account → `player_suspended`, fails open on a DB error), GATED list) is the only way back to a voluntary seat: ack AND `returnToTournamentResult` (same object) — success `{success:true, tournamentId, tableId, seatIndex}`, emitted AFTER `reconnectedToTable {tableId, seatIndex, tournamentId}` + a full gameState (+ the table broadcast); failure `{success:false, code, error}`, code ∈ `player_suspended` / `login_required` / `not_signed_in` / `already_seated` (a live seat at ANOTHER table, main or extra — authoritative) / `session_changed` (another account signed in during the gate or the ban check) / `no_tournament_seat`; a tap for the seat the socket already holds is success again (`returnAlreadyThere`) — a repeated Return is idempotent; a session on a dead seat is cleared first (the restore's P-g detach ends any spectating); a socket that dropped during the gate is never answered and binds nothing (P-c' server half: the reconnect's sign-in re-announces the voluntary seat and poker-3d's one retry restores it). **P-c''** (round 6 — LATEST CONNECTION WINS; replaces round 5's `held_elsewhere` / `seatHeldElsewhere` refusal, pe5 X1: a Return processed on a connection that then died locked the new connection out and the client dropped the seat): `absentTournamentSeatsOf(…, {takeOver:true})` (the Return only) also finds a seat played by live sockets of the SAME account (`heldBy` — another tab or device, or his own stale connection the server still counts as connected, up to ~65s) and `restoreAbsentTournamentSeat(…, 'any', true)` moves it to the asking socket like a reconnect restore: each old socket's session ends (seated slot released, delta baseline dropped), it leaves the table room and gets `tournamentSeatTakenOver {tournamentId, tableId, seatIndex}` (`returnTakeOvers`, log `tournament_seat_taken_over`); a seat any OTHER account's live socket plays is never taken; never answer "held elsewhere" again. A `no_tournament_seat` for a NAMED tournament (`returnNoSeatAnswer` ← `tournamentEntryOutcomeOfAccount(auth, tournamentId)`) echoes `tournamentId` and adds ONE of `tournamentFinished:true` + `position` (the tournament ended — TournamentManager, else `finishedTournamentRecords`; `returnAfterFinish`) or `eliminated:true` + `position` (out of a running one) — additive, the code unchanged; a Return with no tournamentId never guesses. **P-d** every full gameState carries `isTournament` + `tournamentId` (`false` / `null` on a cash table — always present so a delta clears them; `tournamentIdOfTable`). **P-e / P-e'** the bust check reads, BEFORE the elimination (its rebalance may vacate the busted seat for a mover and drop that session), the entrant's socket (`tournamentEntrantSocket`) and whether its MAIN session is at THIS table (`bustSidPlaysHere`); only that socket, and only if it holds no player session (main or extra-table) at another table (`socketHoldsPlayerSessionElsewhere`), is made a spectator / told `eliminatedToSpectator` (after `detachSocketFromOtherTables`; a broken table → one of the tournament's live tables). An AWAY entrant's socket (no session at that table — the lobby, watching another table, about to start a quick game) is NEVER made a spectator and NEVER joined to that table's room (`eliminationsToAwaySocket`; seated elsewhere: `eliminationsToSocketSeatedElsewhere`) — pe4 W2: round 4 made a lobby socket a spectator and re-joined it to the room, and its next quick game / invite seat got that table's frames interleaved. Every live socket of his except the one switched to spectator — one in that table's room included (round 5: the room broadcast carries no tournamentId, so it could never end his away seat) — gets the plain notice `playerEliminated {tournamentId, playerId, playerName, position}` (`noticeTournamentEliminationToEntrant`). Round 6 (pe5 nit — ONE notice per socket): those sockets are decided BEFORE the elimination together with the switch (`tournamentEliminationNoticeSockets`) and held in `eliminationDirectNotice` while `eliminatePlayer` runs; the table-room `playerEliminated` broadcasts of that elimination (single-table and multi-table event handlers) skip them (`roomEliminationNoticeExcept` → `.except(…)`) — round 5 gave an away entrant watching his own table the room's generic copy too (two toasts); the switched socket still gets the room copy. **P-g** one socket, one table view (round 5): every path that seats a socket or makes it a spectator at X calls `detachSocketFromOtherTables(socket, X|null, 'seat'|'spectate', via)` BEFORE it binds the session / spectator view — it ends the socket's spectating of every other table (`'seat'`: X too), leaves every other `table:*` room except its main and extra-table seats' tables, drops the delta baseline when anything was detached (log `table_view_detached`, `tableViewDetaches {calls, spectatorViewsEnded, roomsLeft, deadSeatSessionsEnded}`). Round 6 (pe5 X5): a main session on a DEAD tournament seat (eliminated, stood up, or its table gone) at another table than X is ended there too (session, seated slot, room — `deadSeatSessionsEnded`, log field `deadSeatSessionEnded`; the seat itself untouched): `broadcastGameState` sends player-view frames to every session at a table whatever its rooms, so a busted player's `spectateNextTable` / spectate / Watch Live interleaved two tables' frames; a dead-seat session at the SAME table he then watches stays (open). Callers: joinTable / quickPlay / joinWithWaitlistContext / joinByInviteCode (before the buy-in and again at the commit), quickHeadsUp / quickSpinGo / quickAllInOrFold / startCareerGame, joinAdditionalTable, spectate / spectateTournament / spectateNextTable, returnToTournamentSeat (seat already held), restoreAbsentTournamentSeat (Return + every by-account restore), the four reservation restores (oauthLogin, tokenLogin ×2, resumeSession), startTournamentGame / startQualifierTournament / the multi-table start, the qualifier re-entry, the hand-start suspension stand-up, the bust switch, a vacated busted seat (a holder already watching ANOTHER table keeps it and only leaves this room). The old spectator-only scrubs (and the Return's own) are gone. NEVER add a seat / spectate path without it (rebalanceSafety wiring test). Not covered: voice rooms (`voice_<tableId>`). **P-h / P-h'** `tournamentFinished` goes to the table rooms UNCHANGED — except a QUALIFIER (R2 C3, 2026-10-11): one frame PER SOCKET in those rooms, the same `data` plus `isQualifier`, `qualifierId`, `seatsForTop` and that socket's own `myResult {place, wonSeat} | null` (a qualifier pays seats, not chips — never broadcast one shared frame for it); `emitTournamentFinishedToEntrants` then sends every live socket signed in as an entrant (local userId; a qualifier entrant by master id) that is in none of them its OWN event `tournamentFinishedForEntrant {tournamentId, position, prize?, tournamentName}` (P-h', round 6: `prize` = his payout, only when > 0; `tournamentName` = the tournament's name, else 'Tournament') — never a second `tournamentFinished` (round 5's copy made a client draw its full-screen result overlay over a cash table; older clients ignore the new name) (`tournamentFinishedNotices {roomBroadcasts, entrantSockets}`); the result is kept per entrant in memory for a late Return (`finishedTournamentRecords` — now with `prize` —, 6h, ≤500 tournaments, pruned by the 5s sweep — TournamentManager drops a template tournament 10s after it ends). **P-i** (round 6; replaces round 5's unbounded all-absent call, pe5 X2: a shove followed by Back to Lobby called the other absent stack all-in): `autoActForSeat` is the ONLY auto-action — the turn-timer timeout, the 500ms orphan auto-act and a `sitOut` / `playerAFK` on his own turn at a tournament table: CHECK when nothing is owed; CALL only when `absentTournamentSeatMayLimp` allows (tournament table, PRE-FLOP, `currentBetToMatch ≤ bigBlind` — never a raise, even the 1 BB a big blind owes facing a min-raise —, ≤ 1 BB to call, chips left behind — never all-in by a call —, and every seat still in the hand absent: no AI, no `seatHasPlayingSession`); else FOLD (a refused call folds). Cash tables: check-or-fold. An all-absent hand limps / checks down to showdown, so the blinds still bust someone. `allAbsentAutoCalls` counts the limps (log `all_absent_hand_auto_call`). Never add an auto-action that bypasses `autoActForSeat`. **P-j** (round 6; pe5 X3, pre-existing): on a TOURNAMENT table `syncSitOutToTable` gives the engine NO sitting-out seat (`setSittingOutSeats([])`) — a sitting-out or away seat is dealt in and posts its blinds / antes live (no dead-blind debt; `sitOutTracker` still records the player's Sit Out); a seat whose session sits out is ABSENT (`tournamentSeatSitsOut` → the 3s short clock, acted per P-i; sitting back in gets the rest of the normal clock); cash tables unchanged. Before, a sitting-out seat was never dealt or blinded: a heads-up with one never dealt again (Back to Lobby while sitting out made it permanent). Street re-arm (round 6, beyond the listed surface; also a HEAD gap): `armTurnTimer` re-arms on a new STREET too (`turnStartedPhaseMap`) — heads-up the big blind acts last pre-flop and first on the flop and was never re-armed (absent: the 20-35s wedge watchdog; present: the rest of his pre-flop clock); every table, cash too. **V4** a rebalance moving an ABSENT seat (`moveTournamentSeatPointers` — the reservation and its `voluntary` flag move with it) sends an updated `tournamentSeatKept` (new table/seat) to his live sockets that do not play it, except a socket inside its own keep (`noteAbsentTournamentSeatMoved`; never `playerMoved`, which still goes only to sessions at the old seat). **P-f / P-k** seated: `leaveTournamentSeatOnAdminRemoval(socket, via, actor, onlyTournamentId?)` disqualifies a LIVE tournament seat the removal TARGETS first (`disqualifyPlayer`, no eliminator / prize, audit `TOURNAMENT_ENTRANT_DISQUALIFIED_BY_ADMIN` `credited: 0`, rebalance held until the seat is gone), then the normal leave (`'kept'`) stands it up — at the hand's end if his chips are in a live pot — never cashed; a seat not disqualified (DQ failed, or not targeted — P-k) is kept absent, unflagged (never a live entrant stood up). Away (round 5, the P-f gap — an AWAY entrant was disqualified nowhere and could sign in and Return): `disqualifyAwayTournamentEntriesOnAdminRemoval` — the account (`adminRemovalTargetAccount` — local userId + master id from one of his live sockets' sessions, else his row's stats stamp) is read BEFORE his sockets are dropped and the pass runs AFTER the socket loop; each: rebalance held, `disqualifyPlayer` (no prize), audit `{away:true, credited:0}`, then `standUpAdminDisqualifiedAbsentSeat` (reservation + timer, gone sockets' sessions, sit-out, dead-blind debt, voluntary mark end; folded and left for the hand's end if his chips are in a live pot — `processPendingSeatRemovals` never credits a tournament table — else stood up now, `TOURNAMENT_STACK_NOT_CASHED` `<via>_away_disqualified`), never credited. Scope — **P-k** (round 6, pe5 X4: round 5's dashboard kick disqualified EVERY away entry, even for a kick from a cash table): KICK `target` = the request's `tournamentId`, else the tournament of its `tableId` (a cash table → none), else (the dashboard sends only `{userId}`) each kicked socket's MAIN seat's table — no target: that socket's own live tournament seat only, NO away pass (a kick while he is away disqualifies nothing); a named tournament: that tournament's seat + his away entry in it; a named cash table: nothing (a tournament seat on the socket is kept absent). IP-BAN: each of his sockets' live main tournament seat + EVERY away entry. `banUser`: reads the account first, disqualifies EVERY away entry (`via:'admin_ban'`), audits `BAN_USER {targetUserId, awayTournamentEntriesDisqualified}`, then AWAITS the ban write; `userBanned` unchanged; it still never kicks. `bannedAccountRefusal` (`isUserBanned`, logs `banned_account_refused` / `ban_check_failed_open`) refuses the Return and the seat-restore gate (`refuseSeatRestoreIfBarred`: oauthLogin, tokenLogin ×2, resumeSession) with `player_suspended` (cash stood up and credited, tournament kept absent, never credited; fails open). `awayTournamentEntriesDisqualified` on `adminKickResult` / `adminIPBanResult` (+ the `ADMIN_IP_BAN` and `BAN_USER` audit rows — not `ADMIN_KICK`, written before the passes), `adminRemovalsAwayDisqualified`. Waitlist buy-in cancellation: `cancelCode: 'buy_in_cancelled'` on `error` + `loginResult` (`WAITLIST_BUY_IN_CANCEL_CODE`; `failLogin` `extra`). `/api/health` `tournamentSafety` (`dealsHeldForBustCheck`, `bustChecksRunLate`, `bustLeftoversEliminated`, `clientHandStartsRouted`, `moversWithoutLiveSeat`, `entrantSocketsDetached`, `eliminationsToSocketSeatedElsewhere`, `eliminationsToAwaySocket`, `absentSeatsMovedNotified`, `adminRemovalsDisqualified`, `adminRemovalsAwayDisqualified`, `allAbsentAutoCalls` (P-i limps), `tableViewDetaches` {calls, spectatorViewsEnded, roomsLeft, deadSeatSessionsEnded}, `tournamentFinishedNotices` {roomBroadcasts, entrantSockets}, `seatsKeptOnLeave` {kept, keptVoluntary, keptUnreserved, returned, returnRefused, signInNotices, returnAlreadyThere, returnAfterFinish, returnTakeOvers}). Still open: a reservation-path restore sets the session playerId to `user_<id>` and overwrites a live seat the socket still holds elsewhere; `startTournamentGame` and the qualifier re-entry can overwrite an existing same-account session; `banUser` never kicks (a banned player seated live keeps playing; his kept seat is then refused at every restore but NOT disqualified — the hand-start gate screens only the master suspension); the local ban is checked only in joinTable, the Return and the sign-in seat restores (not quick games, the waitlist, registration); a busted player watching his OWN former table keeps that table's dead-seat session (one table's frames); voice rooms (`voice_<tableId>`) are outside P-g. Pinned by `tests/rebalanceSafety.test.ts` (S1, V1 E1/E1c + controls, P-l serial writes + a no-fan-out wiring check, S2, P-a ordering and the final-seat-only keep, P-e/V2 and P-e' (lobby, watching another table, watching his own table — one notice via `.except` —, the seat's player read before the elimination, W2 end to end with a real quickHeadsUp), P-g (detach rules, the X5 dead-seat detach via spectateNextTable, by-account restore, vacated seat, invite join, wiring), P-h / P-h', P-c'' (two-tab ping-pong, idempotent repeat, X1 stale connection, another account's seat never taken, sign-ins never take a played seat), V4, P-c, P-b tell, P-f + the away gap + P-k (dashboard kick while away, a kick naming a cash table, banUser's away pass + refused Return), P-d, M1-M4 — each with a control), `tests/absentSeat.test.ts` (P-b per sign-in, disconnect restore + tournamentId, orphan-scan skip, P-i (all-absent limps to showdown, X2 shove-then-leave folds, never all-in, never a raise, a present player → fold, auto-action wiring) + controls, the P-k ban refusal on Return and on sign-in restores (cash + tournament) + controls, P-c' server side: a Return lost with its transport, the re-announce and one re-sent Return), `tests/tournamentSitOut.test.ts` (P-j dealt in + live blinds with the X3 control, Back to Lobby while sitting out, cash unchanged, the short clock, sitting back in, the street re-arm with its HEAD control, Sit Out on his own turn) and `tests/buyInSocketGone.test.ts` (cancelCode). | 2026-10-10 (pe2 review: zombie entrant after an early deal; seat stood up on Back to Lobby. pe3 review: a no-bust hand's late check eliminated a next-hand all-in mid-hand; the two S2 halves spoke different protocols; owner "fix all". pe4 review: an away entrant busted in the lobby was made a spectator and his next quick game / invite seat got that table's frames; a Return whose ack was lost ended in "may have ended"; an away entrant was never told the tournament finished nor disqualified by a kick / IP-ban; all-absent hands never resolved; a leave that broke the table told the OLD seat last. pe5 review: a Return whose answer was lost ended in a false "taken back in another tab" and lost its button (X1); the all-absent call put an away player all-in against a shove (X2); a sitting-out finalist froze the tournament (X3); a dashboard kick disqualified unrelated away entries (X4); a busted spectator got two tables' frames (X5); two elimination toasts; banUser left away entries playable; owner "fix all — simplify") |
| 24 | **The wedge watchdog never acts on a turn whose own clock is live; a disconnect fold hands the turn on; `saveProgress` stays TEXT-safe (2026-10-10 hotfix).** The 15s watchdog identifies a TURN the way `armTurnTimer` records it (hand + street + seat + `turnStartedAt` = `turnKey`); `seatSince` resets on every new turn and the pot/phase fingerprint includes the hand number. While THIS turn's `turnTimers` entry is armed and younger than `TURN_TIMEOUT_MS + WEDGE_TURN_GRACE_MS` (45s), it acts only on a real oscillation: the SAME seat starting a second turn while no chips / street / hand moved (`sameSeatNewTurn`, which no legal betting round produces). A missing or dead clock is still recovered (30-60s into the turn). Before, it knew only the sampled seat INDEX: three samples landing on the lone human's turns across streets / hands read "stuck 30000ms" and folded or checked him 0.1-12s into a fresh turn (~9-11% of the turns of a player who acts in 3-12s; live hands 223 / 233 / 244 on 090a0e6e; ~235 fires/hour on 15 tables, all-bot tables included). Never act for a seat on a sampled seat index alone. `reserveSeatForDeparture` calls `scheduleAIAction` after its on-the-clock fold (the next bot sat ~30s). `users.stats` is TEXT on prod: `saveProgress` reads it as `COALESCE(NULLIF(stats::text, '')::jsonb, '{}'::jsonb)` before the jsonb merge (no trailing `::text`: the assignment cast covers a TEXT column, and it stays correct under jsonb); the old `COALESCE(stats, '{}'::jsonb)` failed the WHOLE UPDATE (42804, level / xp / achievements included) on every save since 89ac65e. Pinned by `tests/watchdogTurnAware.test.ts` (real `armTurnTimer` + watchdog source on the real PokerTable: A / A2 a present human is never acted for, B an AFK seat is acted for by the turn timer at exactly 30000ms only, C an all-bot table never fires, D a dead clock is still recovered, E an oscillation is still caught); both locked in canonical-features.txt. | 2026-10-10 (owner: "it is auto folding me without me hitting anything") |
| 25 | **One person, one local row.** A master account resolves to exactly ONE `users` row on EVERY sign-in path: `findLocalUserByMasterId` (src/auth/accountMerge.ts — TEXT-safe `pg_input_is_valid` read of `stats.masterUserId`, skips merged tombstones) runs FIRST in `upsertOidcLocalUser` (oauthLogin / tokenLogin), `authWithTicket` 3a and the waitlist bootstrap; a master with no row yet gets one from `createOrAdoptMasterRow` (src/auth/masterRow.ts, 2026-10-11 AUTH-1 — see row 27: a NEW `m:<master id>` row, or an unowned row only with a master-attested phone; the old key upsert, which adopted the admin seed by name, is gone). NEVER key a sign-in on the display name or slug again, and never read `stats->>...` directly (stats is TEXT in prod — it ERRORS). The one-time boot merge (`merge_split_master_accounts_2026_10_10`) folded 114 masters / 240 rows into one survivor each: balances SUMMED (group totals asserted), level max, achievements unioned, child rows re-pointed (collisions archived in `merged_rows_archive`), the rest became TOMBSTONES (banned, renamed `merged-<id>-<orig>`, `stats.mergedInto`, token_version+1, never deleted; record in `account_merges`). The `redirect_merged_account_credit` trigger moves any later chips / stars / scratch CREDIT on a tombstone to its survivor (`merged_account_redirects`). Sign-ins wait on the identity gate (trackLogin + waitlist) until the boot ops finish; the ops start 45s after boot + a pg_stat_activity wait because **Railway starts the new container ~7s BEFORE it SIGTERMs the old one** — a boot-time data op is NOT after the old instance's flush. Goodwill `goodwill_50k_progress_save_bug_2026_10_10`: 50,000 chips once per PERSON (= master account; unlinked/GuestNNNN rows excluded — the guest carry-over would double it) who played since 2026-06-19. **Review fixes (2026-10-10, both reviewers):** a master lookup that cannot be answered THROWS `MasterLookupError` (retried twice) and the sign-in is refused — it never falls through to the key INSERT (that recreated split rows); resolution of one master is serialized (`withMasterLock` — a Play Online tap sends oauthLogin + authWithTicket together); the ~90ms bcrypt runs only for a real INSERT; the gate releases with 0-3s jitter and skips sockets that dropped while waiting; identity stamps are atomic `mergeUserStats` patches; the merge pre-marks every achievement the merged state satisfies and the one-time `achievement_backfill_2026_10_10` does the same for every row (the 06-19..10-10 save bug paid rewards without storing the ids: without it ~1.06M chips + 8.6k stars are re-paid, with it 0 — measured with the real ProgressionManager), merged hand history beyond the newest 100 is archived, `partial`/`error` merges retry up to 3 boots, DB sessions carry `application_name` `poker-server:<deployment>` so the old container is detected. Pinned by tests/accountMerge.test.ts; rehearsed on a restored prod copy. `/api/health` `accountMerge`. | 2026-10-10 (owner: "Merge and yes" — Play Online vs normal sign-in landed on different rows) |
| 26 | **Tournament seat polish (round 7, Z1-Z7).** Z1: the `disconnect` handler re-checks `playerSessions.get(socket.id) === session` after its saveProgress await — a seat Returned / restored meanwhile is never reserved or acted for (`disconnect_session_replaced_during_save`). Z2: a bust notice carries the BUSTED entrant's own `finishPosition` (the final bust told the runner-up "1st"). Z3: the absent limp ceiling is `PokerTable.handBigBlind` (captured at hand start; a mid-hand level-up no longer widens it). Z4: Return takes over a seat another tab plays ONLY for a named tournamentId. Z5: `banUser` disqualifies a tournament seat his live socket plays too (as IP-ban). Z6: a leave / disconnect ON his turn CHECKS when a check is free, else folds (cash + tournament). Also (superseded 2026-10-11: the password `login` and `syncMasterUser` are removed, AUTH-8): every sign-in path is master-first now. **Review fixes:** the disconnect re-validates after its save await (session still its own, same live table not broken, seat still his, and NO other socket's session plays it — `otherSessionHoldsSeat`); tokenLogin's orphan-seat scan skips seats a live session plays (two sessions on one seat let the old socket's disconnect fold the new socket's live hand); departures never act in a draw phase; a tournament leave sets `handsRemaining:0` BEFORE acting (short absent clock on the very next turn); an empty Return `tournamentId` is none. | 2026-10-10 (pe6 review + merge review leftovers) |
| 27 | **Identity, crash safety and seat identity (.online R1, 2026-10-11).** (a) **AUTH-1:** a sign-in finds its local row by MASTER ID only (`findLocalUserByMasterId`, under `withMasterLock`); a master with no row gets one from `createOrAdoptMasterRow` (src/auth/masterRow.ts): an existing UNOWNED row only with real proof — a master-attested phone (a signed phone claim / the master's own /me record) equal to the row's phone-number username, never an is_admin, GuestNNNN or tombstone row, atomic (`FOR UPDATE`) — else a NEW row under `m:<master id>` (`ON CONFLICT DO NOTHING`, re-read by master id, suffix on a foreign key holder). NEVER upsert or look up a row by a display name, slug or unattested phone again (the old `ON CONFLICT (LOWER(username)) DO UPDATE` handed renamed attackers the is_admin admin seed). `users.username` is not a display value (phone / slug / `m:<id>`): show `display_name`. The warn/enforce guard and `ONLINE_IDENTITY_GUARD_ENFORCE` are retired. AUTH-11: the waitlist link creates the row too. (b) **Crash safety (contract #6):** `installSocketListenerGuard(socket)` (src/socketGuard.ts) runs FIRST in the connection handler — a listener that declares a payload parameter gets only a plain-object payload (`[socket-payload-rejected]`, ack `invalid_payload`); a sync throw / rejected returned promise → `[socket-handler-error] {event}` + ack `{success:false,error:'server_error'}`. A listener that starts async work must RETURN its promise (joinTable / quickPlay / rebuy return their IIFE). src/processGuards.ts: `unhandledRejection` → log, keep running; `uncaughtException` → log, `gracefulShutdown('uncaughtException', 1)` (shared in-flight promise, bounded 20s), exit 1. No @socket.io/redis-adapter (single replica). (c) **No password login, no admin seed (AUTH-8/15):** the socket `login` handler, `loginUserAsync` / `syncMasterUser` and the ADMIN_PASSWORD seed are gone; no hardcoded `ADMIN_PHONE`. (d) **AUTH-3:** `clearGhostSeatsForUser` identifies ghost seats by ACCOUNT only (its sessions; its own still-valid reservation; cash seats stamped `user_<id>` nobody plays) — never by a name. (e) **Names + avatars (contract #3):** every seat / quick game / tournament + qualifier registration / waitlist / chat path names the seat with `seatNameForSocket(socket, …)` — the session's `displayName` (set by every sign-in, kept current by setDisplayName) through `accountDisplayName` (setDisplayName whitelist, never phone-like, else 'Player'); a client name only for an account-less socket. Avatars only through `sanitizeSeatAvatar` (style ids, #hex colors, sliders; no photo). (f) **AUTH-12:** `assertPlayable` also refuses a locally banned account (`bannedAccountRefusal`), and oauthLogin / tokenLogin / authWithTicket / the waitlist link refuse a banned row at sign-in. Tests that slice index.ts with explicit globals must be handed new helpers (`seatNameForSocket`, `sanitizeSeatAvatar`, `seatPlayedByAnotherAccount`, …). Pinned by tests/masterRow, crashSafety, ghostSeats, seatNames, bans. | 2026-10-11 (.online full audit, owner: "fix it all") |
| 28 | **Table lifecycle, quick games, money settlement and progression (.online R2, 2026-10-11).** (a) **One seat teardown** (`teardownSeat`): every leave / departure / ghost cleanup / reservation end goes through it. A seat whose chips are in a live pot is stood up only at the hand's end (`pendingSeatRemovalAfterHand`); an ALL-IN leaver keeps his hand only at a ring table where the stack is his own wallet (`leaverKeepsAllInHand` — never a tournament or fixed-roster game); a bot seat is never taken for a joiner mid-hand (`aiSeatTakeableNow` / `takeAiSeatForJoin`); every fold or leave that moves the turn calls `scheduleAIAction(tableId)` so the next actor is always clocked. (b) **Fixed-roster tables** (`isFixedRosterTable`: every quick format — heads-up, Spin & Go, all-in-or-fold, career — plus a club challenge): no AI fill, a busted bot is never reloaded, and the game ENDS when decided (`quickGameEndCheck`). Ring-table bot stacks are reset to one buy-in above 3 buy-ins (`reloadAndCapBotStacks`, `BOT_STACK_CAP_BUYINS`). (c) **Only joinable PUBLIC cash tables** are listed, Quick-Played, waitlisted or joined by `joinTable` (`isPublicCashTable`; anything else answers `table_not_joinable` before any side effect); private / club tables have their own entry paths. (d) **Prize and refund settlements are durable** (`createPrizeLedger` → `prize_payouts`, retried on a DB blip); the shutdown flush (`claimSeatsForShutdown`, audited `SHUTDOWN_FLUSH`) cashes out each seat EXACTLY once. (e) **One progress record per account**, re-hydrated on login; the hand-end progress push is DB-fresh. `users.chips` is BIGINT — `src/economy/schema.ts` installs the int8 → number parser (`setTypeParser(20, …)`) at import; never read a BIGINT column without it. R3 (S3-3): the migration runs only after the previous container is gone (`scheduleChipsBigintMigration` — the boot account ops' wait); rolling back below R2 needs the column turned back first (Rollback). (f) **Season / leaderboard "chips won" counts PUBLIC cash tables only** (`tableCountsForChipsWon`: never private, club, quick or tournament hands — friends at a table of their choosing could feed one account a paid season place); a club table still feeds its own club stats (`tableFeedsClubStats`). R3 (S3-2): one entry per dealt-in human SEAT by ACCOUNT (`chipsWonSeatsOfHand` / `dealtInSeatAccount`: the live session, else the hand-end removal, else the reservation), captured before any seat is stood up — a player who leaves or drops mid-hand gets his loss; never by live session only. R3 (XL-2): a season before `FIRST_CHIPS_WON_SEASON` ('2026-10', the ledger's first month) is never awarded and never marked (`awardSeason` → `pre_ledger`; admin `pre_ledger_season`) — paying one is an owner decision. (g) R3: Battle Pass premium is the purchase row or the PARSED top-level `stats.battlePassPremium` — never a substring of the stats text (`stats.clientData` is client-written). Bundles, mystery boxes and the scratch pool hold only RENDERED types (`RENDERED_ITEM_TYPES`: theme / card_back / frame / title / emote) and the shop sells only those plus profile backgrounds (`SOLD_COSMETIC_TYPES` — drawn on the lobby banner / profile page). Each `handHistory` copy carries `tableId` + the recipient's own `viewerSeat` / `viewerHoleCards` (stored the same); `loadHandHistory` drops `handName` wherever `holeCards` are absent. A level-up whose settlement fails stays owed (re-sent; per-level ledger keys). | .online R2 audit 2026-10-11 (R3 fixes same day) |
| 29 | **Engine, relays, tickets, logs (.online R3 SF-C, 2026-10-11).** (a) **S2-1:** `teardownSeat` keeps a seat's hand at a ring table when it has NO decision left — all-in OR the runout is HELD for the insurance window (`table.isRunoutHeld()`: the covering caller too); its final stack is credited at the hand's end. (b) **K1-6:** a seat restore keeps the player's fast mode — `reserveSeatForDeparture` snapshots `fastMode` on the reservation, every restore path (oauthLogin, tokenLogin x2, resumeSession, `restoreAbsentTournamentSeat`) calls `restoreFastModeOnSeatRestore` right after its `reconnectedToTable` (session flag + `fastModeSet {enabled}` to that socket); `setFastMode` also sets the socket's extra-table sessions; per-player state carries `fastMode`. (c) **AUTH-P3-1:** a peer relay (`voiceOffer` / `voiceAnswer` / `voiceIce`, `coachWhisper`) reaches only a LIVE socket that shares a `voice_<tableId>` (voice) / `table:<tableId>` (coach) room with the sender (`relayPeerSharingRoom`) — never `io.to(<client string>)`, which reached any socket id or any room; a whisper is a string, max 500 chars. (d) **AUTH-P3-3:** a play ticket (`authWithTicket`, `joinWithWaitlistContext`) is burned DURABLY — `src/auth/ticketReplay.ts`, table `used_play_tickets` (SHA-256 of the ticket only), one `INSERT … ON CONFLICT (ticket_hash) DO NOTHING RETURNING 1` per claim, the in-memory map as the fast path, hourly TTL prune; a DB that cannot answer falls back to the in-memory guard (`/api/health` `ticketReplayGuard.durableErrors`). (e) **AUTH-P3-4:** `enableDealersChoice` only by a player SEATED at that table (`socketSeatedAt`) and only at a ring table (`dealersChoiceAllowedAt`), else `error {code:'dealers_choice_not_allowed'}`. (f) **AUTH-P3-2:** `/api/health identityGuard.stampDurable` is true on a jsonb AND a TEXT `users.stats` (`statsStampDurable`). (g) **GAME-P3-10:** the AI opponent model is keyed by the seat's player id (`opponentModelKey`), never the display name; bounded (`OPPONENT_PROFILES_CAP`, least recently observed out). (h) **OPS-P3-2:** no login handle (legacy handles are phone numbers) in logs — an `[AUDIT]` actor that is a phone-number handle prints as `user:<id>` / `phone-handle` (`auditActorLabel`; the durable `audit_log` row keeps the raw actor), admin / ticket-login lines print ids, a malformed `/me` logs its keys only. | .online R3 2026-10-11 |

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
| `REDIS_URL` | Recommended | Provably-fair commitment buffers across redeploys. Hand snapshots are written to it but never restorable (per-boot table ids — hard rule 1): unset, nothing about hands changes |
| `LOG_LEVEL` | Optional (default `info` prod) | Pino level |
| `ADMIN_PASSWORD` | **Unused** (2026-10-11) | The admin seed and the password `login` are gone (AUTH-8/15); a set value only logs a reminder to remove it |
| `ADMIN_PHONE` | Optional, no default | Only the one-time admin recovery grant at boot (already applied) looks a row up by it; unset = skipped. The hardcoded default (a real phone number in this public repo) is removed |
| `OAUTH_CLIENT_SECRET` | **Required in prod** (boot-throws if missing) | Basic-auth secret for auth-server `/token/introspection` — validates EVERY .online OAuth login (`src/auth/oauthValidator.ts`). MUST equal GCP SM `poker-prod-poker-server-client-secret`; rotate ONLY via `rotate-poker-server-secret.sh` at workspace root. Wrong-but-present value = green deploy, all logins 401 — caught by the boot/30-min preflight (`/api/health` → `authClient`) since 2026-07-06 |
| `OAUTH_CLIENT_ID` | Optional (default `poker-server`) | Introspection client id |
| `AUTH_SERVER_URL` | Optional (default `https://auth.americanpubpoker.online`) | Introspection base URL |
| `AUTH_SERVER_BYPASS_KEY` | **Required in prod** (silent degradation if missing) | Sent as `X-Auth-Server-Key` on unauth master-API `/users/:id/me` fetches (ticket login, waitlist) AND gates `reportAuthEvent` auth-health telemetry — unset means telemetry is a silent no-op and those fetches break under `REQUIRE_AUTH_ENFORCE=1`. = master API's value |
| `MASTER_API_URL` | Optional (default prod Cloud Run URL) | Master API base for user fetches + auth-event reporting |
| `JWT_SECRET` | Required for legacy HS256 login **and resume tokens** | If unset in prod, legacy HS256 token auth is DISABLED (forgery guard, `src/auth/authManager.ts:19-28`) — OAuth login unaffected. Since 2026-10-09 it also derives the resume-token key (`getScopedSigningKey`); unset in prod = resume tokens OFF (`/api/health` `resumeSessions.enabled:false`) and the guest carry-over cannot verify guest tokens. Rotating it revokes every resume token and makes old guest tokens unclaimable. |
| `SENTRY_DSN` | Optional | Exception capture |
| `INTERNAL_NOTIFY_TOKEN` | **Required in prod** | `X-Internal-Token` for the master's internalAuth routes: qualifier-credit consume/refund/issue, qualifier schedule/register/results, and (2026-10-07) the play gate's `/users/:id/play-status/internal`. Unset = suspension checks FAIL OPEN (visible as `playGate.internalTokenConfigured:false` on `/api/health`) |
| `QUALIFIER_OVERFLOW_TABLES_MAX` | Optional (default **unlimited**, owner 2026-10-22: "No cap on extra tables") | Online qualifier overflow tables in play per event (owner 2026-10-22). Unset / blank / `unlimited` / garbage → no cap; a number sets a cap (floored, no upper clamp); **0 = OFF** (every-seat-alive late entry / re-entry refused `no_seat`, credit refunded, as before). This is only the value AT BOOT (changing a Railway var restarts the process, and a restart cancels a running qualifier). While the server runs, change it with **`POST /api/qualifiers/overflow` `{"max": N}`** (or `{"max": "unlimited"}`) + header `X-Internal-Token` (= `INTERNAL_NOTIFY_TOKEN`; no token configured → always 403). No restart is needed, and the value lasts until the next boot. Shown as `r2Play.qualifiers.overflow.cap` on `/api/health` |
| `QUALIFIER_TABLE_BALANCE` | Optional (unset = ON) | Online qualifier TDA table balancing (2026-10-23, lifecycle S2; section "Online qualifier TABLE BALANCING"). **`0` = OFF** = no balance move at all, hand end or pre-deal (only the lone-overflow feed and the Rule 1 / Rule 2 breaks move anyone — and, S4 review fix-up, the early rooms' ONE leveling pass at the 11:00 deal, the start's seating; the tables-open lead at 0 stops that too); the fewest-alive placement of late entries / re-entries STAYS (it never reads the switch: an ordering only), so OFF is not a full revert of S2; anything else = on. Only the value AT BOOT (a restart cancels a running qualifier). While the server runs, switch it with **`POST /api/qualifiers/balance` `{"on": 0}`** (or 1 / true / false) + header `X-Internal-Token` (no token configured → always 403). Shown as `r2Play.qualifiers.balance.on` on `/api/health` |
| `QUALIFIER_BREAKS` | Optional (unset = ON) | Online qualifier scheduled breaks (2026-10-23, lifecycle S3; section "Online qualifier CLOCK, BREAKS, PAUSE"): a 5-minute break after every 5th level. **`0` = OFF** (levels run back to back, as before S3); anything else = on. Only the value AT BOOT (a restart cancels a running qualifier). While the server runs: **`POST /api/qualifiers/breaks` `{"on": 0}`** (or 1 / true / false) + header `X-Internal-Token` (no token configured → always 403). Read at each level boundary; turning it off never ends a break already running (`POST /api/qualifiers/pause {"paused":false}` does). Shown as `r2Play.qualifiers.breaks.on` on `/api/health` |
| `QUALIFIER_TEST_TIME_SCALE` | **Never set on Railway** (rig only) | Divides the qualifier ENGINE's level and break lengths (60 = a 12-minute level runs 12 s, the break 5 s) so the local rig can play a whole event in minutes. Inert by construction in production: `qualifierTestTimeScale` answers 1 whenever `NODE_ENV=production` or ANY Railway runtime variable is set (`RAILWAY_ENVIRONMENT`, `_NAME`, `_ID`, `RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE_ID`, `RAILWAY_DEPLOYMENT_ID` — nixpacks does not set NODE_ENV). Clamped 1..120; the lobby's advertised 12-minute levels never change. Shown as `r2Play.qualifiers.testTimeScale` on `/api/health` (must read 1 in prod) |
| `QUALIFIER_TABLES_OPEN_BEFORE_MIN` | Optional (default 10) | Online qualifier EARLY ROOMS (2026-10-23, lifecycle S4; section "Online qualifier EARLY ROOMS (T-10)"): this many minutes before the start the tables open, the online registrants sit down and the tournament is HELD (no card, no blind clock) until the start second, when the no-shows are released and refunded as before and every table is dealt. Clamped 0..30, garbage → 10; **`0` = OFF** = the 11:00 start of before (with S1's on-time timer). Only the value AT BOOT (a restart cancels a running qualifier). While the server runs: **`POST /api/qualifiers/tables-open` `{"minutes": 0}`** + header `X-Internal-Token` (no token configured → always 403); send it BEFORE 10:50 MT to stop the early open (a hold already open still deals at 11:00). AFTER the open, **`{"minutes": 0, "closeOpen": true}`** also undoes every open hold (its tables close, nothing was dealt, every registration and credit kept; the event starts at 11:00 the old way) — S4 review fix-up. Shown as `r2Play.qualifiers.preStart.leadMin` |
| `QUALIFIER_HAND_FOR_HAND` | Optional (unset = ON) | Online qualifier HAND-FOR-HAND at the seat bubble (2026-10-24, owner 2026-10-23; section "Online qualifier HAND-FOR-HAND at the seat bubble"): after the late close, with 2+ tables and alive = the seat package's last paid place + 1 (Sunday: 11), every table plays one hand per round and waits for the others; same-hand busts are placed by starting stack. **`0` = OFF** (every table deals on its own, busts placed by bust order, as before); anything else = on. Only the value AT BOOT (a restart cancels a running qualifier). While the server runs: **`POST /api/qualifiers/hand-for-hand` `{"on": 0}`** (or 1 / true / false) + header `X-Internal-Token` (no token configured → always 403); OFF releases an engaged event at once, ON also re-arms an event its 4-minute watchdog tripped. Shown as `r2Play.qualifiers.handForHand.on` on `/api/health` |
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

**Rolling back BELOW R2 needs `users.chips` turned back to INTEGER FIRST (R3, S3-3).** R2 migrates the column to BIGINT (`migrateUsersChipsToBigint`, run `MERGE_START_DELAY_MS` after boot once the previous container is gone — `scheduleChipsBigintMigration`). A pre-R2 build (e.g. ea9f108) has no int8 → number parser (`src/economy/schema.ts` `installInt8Parser`): pg hands it chips as a STRING, its hydrate drops a non-number and EVERY account it loads shows the fresh-init 10,000 wallet (refill / bracket replies carry string balances) until the column is INTEGER again. Server-side money paths stay correct (additive SQL), but do this before the old build serves:

1. `SELECT max(chips) FROM users;` must be < 2147483647 (INT4 max; prod max 1,999,755,231 on 2026-10-11). If not, do NOT roll back below R2.
2. While the R2 build is still serving (it reads INTEGER and BIGINT alike), in ONE transaction: every user trigger that names the column must be dropped and re-created around the ALTER, exactly as the migration does (Postgres refuses "cannot alter type of a column used in a trigger definition"). List them first — `SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'users'::regclass AND NOT tgisinternal;` — today that is only the account-merge credit redirect:
   ```sql
   BEGIN;
   SET LOCAL lock_timeout = '5s';
   LOCK TABLE users IN ACCESS EXCLUSIVE MODE;
   DROP TRIGGER trg_redirect_merged_account_credit ON users;
   ALTER TABLE users ALTER COLUMN chips TYPE INTEGER;
   CREATE TRIGGER trg_redirect_merged_account_credit
     BEFORE UPDATE OF chips, stars, scratch_cards_available ON users
     FOR EACH ROW WHEN (OLD.stats::text LIKE '%"mergedInto"%')
     EXECUTE FUNCTION redirect_merged_account_credit();
   COMMIT;
   ```
   (re-create any other listed trigger from its own `pg_get_triggerdef` text; a lock timeout changes nothing — retry.)
3. Then `railway rollback` / redeploy the older commit. Redeploying R2+ later migrates the column to BIGINT again by itself.

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
4. A handler that seats a socket or makes it a spectator: a seat the socket
   already holds is left through `handlePlayerLeave` first (P-a — a live
   tournament seat is kept, never overwritten), then
   `detachSocketFromOtherTables` runs BEFORE the session / spectator view is
   bound (P-g, row 23; `tests/rebalanceSafety.test.ts` wiring test)
5. A handler that acts for a seat on the player's behalf (a timeout, an
   orphan, a sit-out on his turn at a tournament table) goes through
   `autoActForSeat` (P-i, row 23 — never a bare `playerCall`); a new path
   that gives a tournament seat back runs `bannedAccountRefusal` after
   `assertPlayable` (P-k)

### Online qualifier late entry / re-entry rules (owner 2026-10-22)

Owner: "There should be late entries until 2pm, re entries if they have more
credits and each entry consume a credit". Each rule is ONE constant in
`src/game/qualifierSchedule.ts` — change it there, nowhere else:

- `QUALIFIER_LATE_REG_MS` (3 hours): late entry AND re-entry close this long
  after the start. Weekly (Sunday) and monthly (3rd Saturday) both start at
  11:00 AM Denver, so they close at 2:00 PM. It drives the register window,
  the late seat, the re-entry window, the too-few-players cancel, the no-show
  notice and the lobby's `lateRegUntil` / `signupClosesAt`. The master's
  `/qualifiers/schedule` must keep listing an open event for at least that
  long after its start, or an event still waiting for 2 players is cancelled
  `removed_from_schedule` early (a RUNNING event is never affected).
- `QUALIFIER_MAX_REENTRIES` (null = no cap): a busted entrant re-enters as
  often as he holds an unused credit of the tier. Every entry (the first and
  each re-entry) consumes exactly ONE credit through the master's atomic
  consume; a refused / failed entry refunds it. A per-event `qt.maxReEntries`
  still caps.
- The re-entry re-checks, after its LAST await, that he is still out and the
  window still open (a second tab's re-entry is refused `already_registered`
  and refunded — it used to seat him twice). With no never-used seat left it
  takes a BUSTED seat, his own first (`seatQualifierReentrantOnBustedSeat`,
  log `qualifier_reentry_busted_seat`). When every seat is alive a NEW table is
  opened (overflow tables, next section); only with those off or capped is a
  late entry / re-entry refused `no_seat` with the credit returned. Health:
  `r2Play.qualifiers.lateEntries`.
- Lobby item: `reEntriesLeft` = his unused credits of the tier from the CACHED
  credit list (never awaited by the 10 s lobby poll), plus `creditsHeld`,
  `maxReEntries`, `reEntries` (CONTRACTS.md). Rig: scratchpad
  `qrig/scenario-latere.js`. The cached list follows every consume / refund /
  issued credit this server makes at once (`noteQualifierCreditChange`, called
  from the three master-credit transport helpers — a new credit path must go
  through them), and a list read in flight across such a change is never
  cached as fresh (`qualifierCacheGen`).
- **Ships only with mono `d01522e6`** (the master's consume: `FOR UPDATE` +
  `redeemed_at IS NULL`). The older API answers two concurrent consumes for one
  player with the SAME credit id; `qualifierCreditHeldByConcurrentEntry` then
  keeps that credit (no refund, the second call refused) when the other call
  has already recorded it, but only the API fix closes every ordering.
- Known limit (pre-existing, owner to decide): a qualifier still ENDS the
  moment one entrant is left, even before 2 PM (`TournamentManager`
  `alivePlayers.length <= 1` → `finishTournament`); later late entries and
  re-entries are then refused `registration_closed`. And a consume the master
  commits after the 6 s abort is lost (`credit_error`, no id to refund) —
  needs a master idempotency key.

### Online qualifier OVERFLOW tables (owner 2026-10-22: "Build it for Sunday")

Before: when every seat of a running qualifier was alive, a late entrant or
re-entrant was refused `no_seat` (credit refunded) — nothing ever added a table
to a running tournament, and free capacity hovers at 0-8 seats (Rule 1 breaks a
table at 9 free), so a first-hour wave of late arrivals was turned away. Now:

- **Open.** After the existing seat searches fail (late entry:
  `seatQualifierLateEntrant` → `seatQualifierLateEntrantOnOverflowTable`;
  re-entry: empty seats → busted seats → `seatQualifierReentrantOnOverflowTable`),
  `openQualifierOverflowTable` creates ONE table — only when no table of the
  tournament has a placeable seat (empty or busted), so at most one table is
  ever under-filled. 9 seats, the CURRENT level's blinds / ante, minBuyIn = the
  starting stack; mapped in `tournamentTables`, appended to the live tableIds
  (`TournamentManager.addTable`), given its progress listener. **Never**
  `bootstrapTournamentTables` / a second `tournamentManager.onEvent`: listeners
  APPEND, and a second one posts the results twice. The one bootstrap listener
  already reads the live tableIds (blind-ups, eliminations, the finish, the
  retirement). Log `qualifier_overflow_table_opened`.
- **Cap + kill switch.** `QUALIFIER_OVERFLOW_TABLES_MAX` in
  `src/game/qualifierSchedule.ts` (6 = 54 extra seats) counts overflow tables of
  the event still in play; Railway env `QUALIFIER_OVERFLOW_TABLES_MAX` overrides
  it at boot (clamped 0..20, garbage → 6) and **0 = OFF** — exactly the old
  `no_seat` refund. Cap reached → `no_seat` refund, log
  `qualifier_overflow_cap_reached`.
- **Runtime kill switch (review fix-up — use THIS during the event).** Changing
  the Railway var restarts the process, and a restart CANCELS a running
  qualifier: the shutdown flush releases and refunds every entrant. So during
  the Sunday freeze the cap is changed live, with no restart:
  `curl -s -X POST https://poker-server-production-60c0.up.railway.app/api/qualifiers/overflow -H 'Content-Type: application/json' -H "X-Internal-Token: $INTERNAL_NOTIFY_TOKEN" -d '{"max":0}'`
  (`setQualifierOverflowTablesMax`). Use the token from the environment and
  never paste it into a chat or a web form. It is the same value poker-server's
  Railway env and the master share.
  - Answers `{success, previous, cap, live}`. A missing or wrong token gets 403,
    and so does every request when no token is configured (fails closed). A
    non-numeric `max` gets 400 and nothing changes.
  - **0 = OFF:** no new overflow table, and no feed into a lone one. Overflow
    tables already in play are NOT closed: they hold live stacks, so they play
    on and the rebalance breaks them as usual.
  - Raising the cap again re-opens the path at once. The value lasts until the
    next boot, which reads the env again.
  - Logged and audited as `qualifier_overflow_cap_set`. Health shows
    `overflow.cap` (the value in force) and `capChanges`.
- **Every refusal refunds exactly once.** Kill switch, cap, a create / addTable
  throw, a seat that cannot be taken, a refused reinstatement: the empty table
  is closed again (`closeUnusedQualifierOverflowTable`) and null goes back into
  the caller's EXISTING `no_seat` refund. An overflow seat keeps the one credit
  consumed; places stay 1..N (`addLateEntrant` / `reinstateForReentry`).
- **Alone.** A lone entrant is dealt nothing and pays no blinds (2 alive are
  needed). His frames say so: `qualifierRegistrationResult` /
  `qualifierTournamentStarted` gain `overflowTable: true` (+ `waitingForPlayers:
  true` while he sits there alone, `qualifierOverflowSeatFlags`); the
  QUALIFIER_LATE_ENTRY_SEATED audit carries them too.
- **First deal.** A fresh table sits in WaitingForPlayers and nothing else deals
  it: `startFreshTournamentTable` (overflow tables ONLY; >= 2 alive; through
  `tournamentDealHoldReason`) runs from `scheduleDealAfterTournamentSeat` (its
  new WaitingForPlayers branch — the second arrival), the feed, and the 5 s
  sweep (`serviceQualifierOverflowTables`, the backstop after a pause / a
  pending rebalance; it also forgets broken / retired overflow tables). Log
  `qualifier_overflow_first_deal`. Review fix-up: the seat hook's call is
  DEFERRED (`setImmediate`), never made inside the registration that seated him.
  The deal follows `qt.players.push` / the re-entry's `reentryCreditIds` (what
  the shutdown flush and the cancel refund from) and the result frames. And
  `startFreshTournamentTable` never throws: a throw is counted in
  `firstDealErrors` (log `qualifier_overflow_first_deal_failed`), and the sweep
  retries the deal while the table still waits.
- **Feed (TDA balancing).** At every tournament table's hand boundary
  (`autoStartNextHand`, after the under-5 wait, before the deal):
  `feedLoneQualifierTable` moves the player due that table's BIG BLIND to a
  lone overflow table — only if the lone entrant is PRESENT (a live, own,
  not-sitting-out session: an absent seat is dealt in on the clock, feeding him
  only gives chips away), no rebalance is possible (`planTournamentRebalance`
  null — one would seat him or fill his table), the source has >= 6 alive
  (`QUALIFIER_OVERFLOW_FEED_MIN_SOURCE`, never below 5) and is the fullest, and
  the mover is present too. The stack moves whole (`sitDown` allowBelowMin),
  every pointer follows (`moveTournamentSeatPointers`, 'playerMoved'), nothing is
  left pointing at the emptied seat; on the overflow table's first hand he posts
  the big blind. It never throws and never stops the source's deal. Each counter
  says what actually happened (review fix-up):
  - `feedErrors` (log `qualifier_overflow_feed_failed`, `moved:false`): NOTHING
    moved. Either a check threw, or the guarded move (sit-down → pointers →
    source seat stood up) failed and was rolled back, leaving the stack on its
    seat.
  - `feeds` (log `qualifier_overflow_fed`): the stack sits at the lone table and
    the source seat is empty. This counts whatever follows.
  - `feedFollowUpErrors` (log `qualifier_overflow_feed_followup_failed`,
    `moved:true`): the move STANDS but a follow-up threw (the stale-pointer
    clean-up, a broadcast, or the lone table's first deal). Chips are conserved,
    and the 5 s sweep deals the lone table.

  Off while the runtime cap is 0. Stable: after it the lone table has 2 and
  still no room elsewhere.
- **Heads-up — by design, an owner call (review).** The feed fills a LONE
  overflow table to exactly 2. Those two play heads-up while every other table
  is full, until the next bust anywhere or another late arrival. Busts are rare
  in the first hour. A bust lets Rule 1 / Rule 2 break the overflow table back
  (`rebalanceSafety` C3 / C12).
  - **2026-10-23 (lifecycle S2): the TABLE BALANCE now evens an overflow table
    past 2.** At each hand end of the fullest table (>= 6 alive), when the
    overflow table has at least two fewer, the player due that table's big
    blind moves there too, until every table is within one ([9,9,1] → feed →
    [8,9,2] → … → [7,6,6]). The heads-up stretch lasts about one hand per
    table. With the balance switch OFF (`QUALIFIER_TABLE_BALANCE=0` or
    `POST /api/qualifiers/balance {"on":0}`) this bullet's old behaviour is back.
    See "Online qualifier TABLE BALANCING".
  - Nothing checks how many tables the tournament has left. When the FINAL
    table is full (9 alive, nothing busted) at a late entry or re-entry, a
    second table opens again and the feed pulls a final-table player into
    heads-up against the fresh 50,000 stack, until the next bust merges them
    back. (Since S2, with the balance on, the two tables even out to 5 / 5 over
    the next few hands; the next bust still merges them — 9 alive fit one table.)
  - No chips or credits are at stake.
  - Full TDA balancing (keep feeding until tables are within one player): DONE
    2026-10-23 (lifecycle S2, next section but one). Refusing overflow at the
    final table is still a separate change.
- **Breaks.** Overflow tables are ordinary tables to the rebalance: the next bust
  anywhere lets Rule 1 break the (smallest) overflow table into the freed seats
  (deferred while it is mid-hand, as every break). Churn (open → break → open)
  is correct, just noisy.
  - **Since S2 each cycle relocates more (review, 2026-10-23; by design).** The
    balance spreads an overflow table out before the next bust breaks one:
    [9,9,9,1] → feed + 5 balance moves → [7,7,7,7] (28 alive, 4 tables), then
    the next bust (27 <= 3 x 9) lets Rule 1 break a 6-7 player table: about
    12-13 relocations per open → break cycle, against about 3 before S2 (the
    feed's 1, then the 2-player table broken). This is what a live room does
    during late registration (a new table is balanced, then broken when the
    field drops); no chips move, each moved player may sit out one hand
    (folded into a mid-hand target, or the F13 dead zone). If it proves too
    noisy on the day: `POST /api/qualifiers/balance {"on":0}` (section "Online
    qualifier TABLE BALANCING") — the overflow tables then play heads-up as
    before.
- **Health:** `r2Play.qualifiers.overflow` = { opened, closedUnused, refusedCap,
  openFailed, lateEntriesSeated, reentriesSeated, feeds, feedErrors,
  feedFollowUpErrors, firstDeals, firstDealErrors, capChanges, live, cap }
  (`feedErrors` / `feedFollowUpErrors` / `firstDealErrors` / `openFailed`
  should stay 0; `cap` is the value IN FORCE, runtime changes included).
- **Tests / rig:**
  - `tests/r2Qualifiers.test.ts`, B1-B13. Its world runs with the kill switch by
    default, so the older no_seat tests keep their meaning. Since the review
    fix-up, B3, B11 and B12 run a production-shaped world: a 9-seat table with
    every seat alive and the REAL `tournamentDealHoldReason` (it used to be a
    stub that always allowed the deal). The B3 CONTROL shows the old 2-seat toy
    world holds `rebalance_pending` under the real hold. B13 covers the runtime
    route.
  - `tests/rebalanceSafety.test.ts`, C1-C12.
  - `tests/qualifierPlaces.test.ts`, A1-A2.
  - Rig scenario: scratchpad `qrig/scenario-overflow.js` (+ `.report.json`).
    It runs the real dist with socket bots: the runtime kill switch and cap, a
    late entry opening a table, the feed, the first deal, late entries filling
    the tables, a re-entry opening a second table, the finish, one results
    POST, places 1..N, the credit ledger, and chip conservation (the winner ends
    with exactly 50,000 x entries).
  - Rig results on 2026-10-22, on the review fix-up's dist:
    - `scenario-overflow` passed 31/31 twice. The first run's single miss was
      the script reading `qualifierTournamentStarted` before it arrived; the
      script now waits for it.
    - On the same dist: `scenario-reentry` 32/32 and `scenario-full` 28/28
      (after a rig fix: its "seat kept" check used a bot that had already
      busted).
    - `scenario-edge` passed 14/14 with `QUALIFIER_OVERFLOW_TABLES_MAX=0`. With
      overflow ON it fails 3 checks, all by design: its "every table full →
      no_seat refund" late entrant is now seated on an overflow table.
  - To recreate the rig's Postgres:
    `docker run -d --name qtest-pg -p 55432:5432 -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=poker postgres:16-alpine`.
    Then run `node mock.js` and `bash restart-server.sh <tag>`.
- **Ships only after ca2035a** (late entry until 2 PM + re-entry per credit).
  ca2035a has been on origin/main since 2026-10-22 19:17 MDT (pushed by the
  `push-server-ca2035a.sh` watcher). CONTRACTS.md (workspace root, not in this
  repo) must be updated in the ship step:
  - its row "No new table is opened";
  - the additive `overflowTable` / `waitingForPlayers` frame fields;
  - the new internal route `POST /api/qualifiers/overflow`.

  Client: no change needed —
  .online 48e42a6 shows `QUALIFIER_WAITING_FOR_PLAYERS_TEXT`; the live 8bc056e
  ignores the flags (a bare "Waiting for Players" table).

### Online qualifier START: seat draw, on-time start, table guard, sync retry (2026-10-23, lifecycle S1)

Owner 2026-10-22: "So this tournament will fully run with no issues? ... start
the game on time ...". Four small changes to the start path, on top of the
overflow tables (3769903). No runtime switch: they are ordering, logging and
one-shot timers; no chip or credit path changed. Rollback = do not push this
SHA (or push the previous one) before the Sunday freeze.

- **Random seat draw** (`startQualifierTournament`). The registrants arrive in
  registration order, so the earliest registrants always shared Table 1, and
  seat 0 there is also the hand-1 button (PokerTable takes the first occupied
  seat). The seating order is now a Fisher-Yates shuffle with crypto
  `randomInt` (`drawOrder`). The k-th drawn player still sits round-robin:
  table `k % tableCount`, seat `floor(k / tableCount)`. So the tables stay
  within one player of each other and every seat index is below 9.
  `tournament.players` (the `registerPlayer` loop) keeps INPUT order
  (`handStartRebalance.test.ts` asserts it).
  - A harness that slices `startQualifierTournament` must put `randomInt` in
    its scope (the slicer stubs unknown names).
- **On the scheduled second** (`tickQualifierAutoStart`). The 30 s interval is
  phased from the process boot, so the start landed anywhere up to 30 s after
  11:00:00.
  - A tick inside the last `QUALIFIER_START_TIMER_LEAD_MS` (30 s) arms ONE
    unref'd timer per event + start time (`qualifierStartTimers`, key
    `<qualifierId>|<scheduledAt>`). It re-runs the tick 250 ms after the start
    second and drops its key when it fires.
  - A double run is harmless: the status leaves 'registering' synchronously.
  - A moved start gets a new key; the old timer just runs a tick that finds
    nothing due.
  - Everything else at the start is unchanged: the no-show release, fewer than
    2 present = wait, the cancel at the late close. The 30 s tick still runs
    as before and still starts the event if the timer never fires.
- **Per-table bootstrap guard** (`bootstrapTournamentTables`).
  - Each table's listener / first deal / broadcast / AI kick is in its OWN
    try/catch. A throw is logged `tournament_table_bootstrap_failed`
    {tournamentId, tableId, error}, counted in health
    `r2Play.tournamentBootstrap.tableFailures` (should stay 0) and sent to
    Sentry; the other tables still deal.
  - Before, one table's throw at 11:00 escaped the tick as an
    uncaughtException, and the crash flush voided the WHOLE event and refunded
    every entrant.
  - The tournament's ONE `onEvent` listener stays outside the loop, registered
    exactly once.
  - A table that failed keeps its seated stacks and waits un-dealt while the
    OTHER tables play. No automatic path re-deals a WaitingForPlayers
    tournament table except a rebalance break
    (`restartWaitingTournamentTables` with `startWaiting`), and a break needs
    eliminations on the tables that did deal. The log line is the signal to
    look at that table.
  - **Review fix-up: a throw with NO table dealt is re-thrown.** When the only
    table (a field of 9 or fewer) or every table throws, and no table's
    `startNewHand()` began a hand, the first error is re-thrown after the loop
    and BEFORE the `onEvent` listener. One more line,
    `tournament_bootstrap_no_table_dealt` {tournamentId, tables, failedTables,
    outcome:'rethrown'}, says why. That is the pre-S1 crash-and-refund: the
    start tick does not catch it, so it is an uncaughtException and the crash
    flush voids the event (`qt` still 'starting') and releases every
    registration, refunding each consumed credit on the master. Swallowed (as
    first shipped in 2d4924f) it left a 'running' event that nothing deals: no
    elimination ever asks for a rebalance, late entries kept consuming credits
    into those tables until 2 PM, no results were posted, and every credit was
    held until someone restarted Railway.
  - A table that DEALT and then threw (its broadcast or AI kick) counts as
    dealt. A start with no throw that dealt nothing is unchanged (no throw).
- **Schedule-sync retry** (`syncQualifierSchedule`).
  - The `/qualifiers/schedule` fetch is bounded at 10 s (AbortController; it had
    no timeout).
  - On either failure branch (transport error / timeout, or a non-2xx), with an
    EMPTY registry, ONE retry is armed in 30 s (`armQualifierSyncRetry`, unref'd;
    the `qualifierSyncRetryArmed` flag prevents stacking). A retry that fails
    again arms the next one while the registry is still empty.
  - A non-empty registry arms nothing (the 10-minute interval keeps it fresh).
    Health: `r2Play.qualifiers.sync.retries`.
  - Before, a boot sync that failed left the lobby card empty and every
    Register answered `qualifier_not_found` for 10 minutes.
- **Credit-failure audit trail.** The refund FAILURE / anomaly rows are now
  DURABLE (`DURABLE_AUDIT_ACTIONS`): `QUALIFIER_CREDIT_REFUND_FAILED`,
  `QUALIFIER_ENTRY_CREDIT_REFUND_FAILED`, `QUALIFIER_REENTRY_CREDIT_REFUND_FAILED`,
  `QUALIFIER_REENTRY_BUYIN_REFUND_FAILED`, `QUALIFIER_SUSPENDED_CREDIT_REFUND_FAILED`,
  `QUALIFIER_ENTRY_CREDIT_SHARED_KEPT`, `QUALIFIER_REENTRY_CREDIT_SHARED_KEPT`,
  plus the operator switches `QUALIFIER_OVERFLOW_CAP_SET` and `TOURNAMENT_PAUSE`.
  - The successful consume / refund rows stay stdout only (volume).
  - No retry was added: a failed refund is reconciled by hand, see step 4 of
    the next section.
- **Tests:** `tests/qualifierLifecycleS1.test.ts` covers (a) the draw, (c) the
  durable names, (d) the guard and (e) the retry. `tests/r2Qualifiers.test.ts`
  "S1 (2026-10-23)" covers (b) the start timer. Full jest 2134 passed
  (baseline 2116 at 3769903, +18). Review fix-up: the same file's "(d) review
  fix-up" block covers the re-throw (the only table / every table / a throw
  plus a no-deal re-thrown; partial, dealt-then-threw and no-throw not; the
  REAL `startQualifierTournament` with 9 and 18 entrants; the wiring). Manifest
  token `tournament_bootstrap_no_table_dealt`.
- **Rig (2026-10-23, scratchpad `qrig/s1-rig.sh`, on this dist):**
  - `scenario-full` passed 28/28; the event started 281 ms after its scheduled
    second (the check allows 31 s).
  - `scenario-edge` passed 14/14 with `QUALIFIER_OVERFLOW_TABLES_MAX=0`.
  - `s1-syncretry.js`: a boot with the master down showed `sync.failures` 1 and
    `retries` 1 with an empty registry. With the master back, the retry listed
    the event 30 s later (it used to take 10 minutes).
  - `tournamentBootstrap.tableFailures` stayed 0.

### Online qualifier TABLE BALANCING (2026-10-23, lifecycle S2)

Owner 2026-10-22: "... auto combine tables when we lost people, only have 9
players per table, auto balance tables ...". Before: the rebalance only BROKE
tables (`TournamentManager.checkRebalance` Rule 1 / Rule 2) and the feed filled
a lone overflow table to 2. Nothing evened [9,2], [9,9,5] or [9,9,9,1]:
checkRebalance answers null for all three (no table fits into the others' free
seats), so they played on that uneven. Now (all in the rebalance helpers block
of `src/index.ts`, qualifiers only):

- **At a hand boundary** (`balanceQualifierTables`, called by
  `autoStartNextHand` after every hold — pause, bust check, deferred break, the
  under-5 wait — and ONLY when the lone-overflow feed moved nobody, before this
  table's own deal, which still happens). When ALL hold
  (`planQualifierBalanceMove`):
  - the switch is on; the tournament is running, not paused, has more than one
    table, and is a qualifier (`qualifierOfTournament`);
  - no break is possible (`planTournamentRebalance` null: a break always wins)
    and not everyone fits in one table fewer (alive > (tables-1) x 9, Rule 1's
    own test — that is the break's business);
  - THIS table is the fullest (a tie is fine) with >= 6 alive
    (`QUALIFIER_OVERFLOW_FEED_MIN_SOURCE`, so it keeps >= 5);
  - the target is the fewest-alive OTHER table with at least two fewer
    (targetAlive <= sourceAlive - 2, so every move strictly evens the tables and
    the balance never oscillates), >= 1 alive, a placeable seat (its FIRST one
    is taken — `tournamentSeatIsPlaceable`, a busted seat is vacated first), no
    break awaiting its hand end, no pending / unsettled bust, not inside
    startNewHand or a hand completion. MID-HAND is fine: the mover sits that
    live hand out (folded, no cards) and is dealt the next one, as a late
    entry is. A LONE target whose only player is ABSENT is skipped
    (`skippedAbsentTarget`: feeding an absent seat gives chips away); a skipped
    table lets the next fewest-alive one be the target.
  - The mover is the seat due THIS table's big blind next
    (`getNextOccupiedSeat(previousBigBlindSeat + 1)`, the first live alive human
    entrant from there). Presence is NOT required (TDA: whoever is due the big
    blind moves; an absent seat's reservation and V4 notice follow it) —
    EXCEPT into a SHORT target (<= 2 alive, `QUALIFIER_BALANCE_SHORT_TARGET_MAX`;
    review fix-up 2026-10-23, the mirror of the absent-target rule): there an
    absent stack would play heads-up or 3-handed, post a blind every hand or two
    and be checked / folded for — chips handed to the present player. So into
    a short target the first PRESENT entrant from the big-blind seat on moves
    (as the feed has always done); none present → that target is skipped
    (`skippedAbsentMover` counts each time an absent big-blind-due seat was
    passed over). The usual short target is an overflow table the feed has
    just made 2-handed; a LONE one is reached only when the feed moved nobody
    (the overflow cap at 0 with the balance on, a regular table down to 1
    alive, or no present entrant at the source).
  - One move per hand boundary. Repeated, the tables end within one player:
    [9,2] → [6,5] (3 moves), [9,9,5] → [8,8,7], [9,9,9,1] → [7,7,7,7].
  - Known limit (by the spec, not changed): he takes the target's FIRST
    placeable seat, not the seat that posts the next big blind. PokerTable's
    F13 dead zone deals him out for one hand only when that seat is on the
    button, in the small blind or between them; elsewhere he is dealt in at the
    next deal and posts only if his seat is that hand's big blind (otherwise he
    skipped the big blind he was due at the source). No chips are created or
    lost; it is a blind-position fairness gap.
- **The move** is the feed's own guarded move, now shared:
  `moveTournamentStack` (vacate a busted target, `sitDown` allowBelowMin,
  `setPlayerTable`, `moveTournamentSeatPointers` — sessions on any socket,
  extra-table sessions, the reservation, `'playerMoved'` —, rolled back and
  re-thrown on a throw, then the source seat stood up) and `forgetSeatPointers`
  (the emptied source seat's stale sessions / reservations / sit-out / AI
  profile). The feed's selection rules, return value and counters are
  unchanged. After a balance move: both tables broadcast, then
  `scheduleDealAfterTournamentSeat(target)` (F95 kicks an idle target).
- **Invariant (in the code comment at `balanceQualifierTables`).** A move takes
  one placeable seat at the target and frees one at the source: total free seats
  are CONSERVED; alive and table counts do not change; the source keeps >= 5.
  So Rule 1 (needs alive <= (tables-1) x 9 — false before, unchanged) and Rule 2
  ("F - f >= c" for the target is the same test before and after; nothing else
  changes; the source is >= 5) can never NEWLY fire because of a balance move.
- **Pre-deal pass** (`balanceQualifierTablesNow(tId): number`, for the break end
  (S3) and the 11:00 deal (S4)): the same rules, repeated, at most 60 moves
  (`QUALIFIER_BALANCE_PRE_DEAL_MAX_MOVES`); the source is the fullest table that
  may give; every table in a hand is skipped as a source and as a target; it
  does NOT require the tournament to be unpaused (its callers run it while their
  hold is set, then resume). [9,9,3] → [7,7,7]; the post-break residue
  [9,9,9,9,2] → within one. Counted in `preDealMoves`. Nothing calls it yet in
  this commit.
- **Placement of late entries and re-entries.** The re-entry empty-seat loop in
  the register handler now walks the tables FEWEST-ALIVE first (it used to walk
  `tableIds` order: every re-entry went to Table 1 first), like
  `seatQualifierLateEntrant` and `seatQualifierReentrantOnBustedSeat`. In all
  three, a table whose break is pending (`tournamentBreaksAwaitingHandEnd`)
  sorts LAST. No switch: it only reorders the candidate tables.
- **Never throws.** `errors` (log `qualifier_table_balance_failed`, moved:false)
  = nothing moved (a check threw, or the guarded move rolled back); `moves` /
  `preDealMoves` (log `qualifier_table_balanced` {tournamentId, fromTableId,
  toTableId, fromAlive, toAlive — the counts AFTER the move —, fromSeat, toSeat,
  via}) = the stack sits at the target; `followUpErrors` (log
  `qualifier_table_balance_followup_failed`, moved:true) = the move stands, a
  follow-up threw. A refused sit-down changes nothing (log
  `qualifier_table_balance_refused`). The pre-deal pass also logs
  `qualifier_tables_balanced_pre_deal` {moves}.
- **Kill switch — two controls.** OFF stops every balance MOVE, hand end and
  pre-deal (only the lone-overflow feed and the Rule 1 / 2 breaks move anyone —
  and the early rooms' one leveling pass at the 11:00 deal, S4 review fix-up:
  the start's seating; the tables-open lead at 0 stops that);
  players already moved stay where they are (their stacks moved whole). It is
  NOT a full revert of S2: the fewest-alive / break-pending-last placement of
  late entries and re-entries (previous bullet) never reads the switch and
  stays (review fix-up 2026-10-23; the docs used to say "exactly the old
  behaviour").
  - Railway env `QUALIFIER_TABLE_BALANCE=0` at boot (unset = on). Changing it
    restarts the process — never during an event.
  - During the event, NO restart:
    `curl -s -X POST https://poker-server-production-60c0.up.railway.app/api/qualifiers/balance -H 'Content-Type: application/json' -H "X-Internal-Token: $INTERNAL_NOTIFY_TOKEN" -d '{"on":0}'`
    (`{"on":1}` turns it back on). Accepts 0 / 1 / true / false; anything else
    → 400, nothing changes. Missing or wrong token → 403, and every request is
    403 when no token is configured (fails closed). Answers `{success, previous,
    on}`. Logged `qualifier_balance_set`, audited `QUALIFIER_BALANCE_SET`
    (durable). Use the token from the environment; never paste it into a chat.
  - Independent of the overflow switch: the overflow cap at 0 stops new
    overflow tables and the FEED, not the balance. To stop every move into a
    lone overflow table, turn both off.
- **Health:** `r2Play.qualifiers.balance` = { on, moves, preDealMoves,
  skippedAbsentTarget, skippedAbsentMover, errors, followUpErrors } (`errors` /
  `followUpErrors` should stay 0; `skippedAbsentMover` is additive, review
  fix-up 2026-10-23).
- **Contract:** no new frame; the moved player gets the same `'playerMoved'`
  {fromTable, toTable, toSeat, tableId} as a break or the feed sends
  (CONTRACTS.md). Manifest tokens `qualifier_table_balanced`,
  `balanceQualifierTables(tId, tableId, table);`, `/api/qualifiers/balance`.
- **Tests:** `tests/rebalanceSafety.test.ts` "2026-10-23 (qualifier lifecycle
  S2 …)", S2-1 … S2-14 (real `autoStartNextHand`, real
  `tournamentDealHoldReason`, 9-seat tables, the real route). The Q2 test "a
  re-entered player's OLD busted seat is free capacity" (and its CONTROL) now
  caps TB at its 3 seats: the fewest-alive re-entry would otherwise seat a5 at
  TB instead of the TA seat 6 the test is built on. Full jest 2156 passed
  (baseline 2142 at 272a23c, +14).
  - Review fix-up (2026-10-23): S2-15 (a short target takes only a present
    mover: the first present one after an absent big-blind-due seat; none
    present → no move, hand end and pre-deal; CONTROL a 3-alive target takes
    the absent seat — fails on e3df1cf) and S2-16 (the switch OFF stops every
    move but not the fewest-alive placement; no placement path reads the
    switch). S2-5 now uses a 3-alive target. Full jest 2158 passed (+2), 0
    failed; `npm run lint` and `npm run build` clean; manifest 768 tokens, 0
    missing from `dist/`.
- **Rig (2026-10-23, scratchpad `qrig/s2-rig.sh`, on this dist).**
  `restart-server.sh` passes `QUALIFIER_TABLE_BALANCE` through.
  - NEW `qrig/scenario-balance.js` passed 37/37 three times (and a smoke run).
    It covers: the route (403 / 400 / 200); with the switch OFF, 60 s with only
    the feed's move ([9,8,2]); switched ON, the 3 tables within one in 27-53 s
    (4 moves, each mover the big-blind-due seat, chips kept); a late fill where
    every entrant lands on a fewest-alive table; a 4th table evened to 7/7/7/7
    in 32-34 s (1 feed + 5 moves); a clean server log; then the play-out with
    one results POST, places 1..28, the winner at exactly 50,000 x 28, and an
    exact credit ledger.
  - `scenario-overflow` passed 51/51 three times with `QUALIFIER_TABLE_BALANCE=0`
    and the cap at 2: the feed path is unchanged, and no
    `qualifier_table_balanced` line was logged. With the balance ON, that
    scenario's "exactly ONE bot moved to the overflow table" checks would fail
    by design.
  - To recreate the rig Postgres, see the overflow section (`qtest-pg`).

### Online qualifier CLOCK, BREAKS, PAUSE (2026-10-23, lifecycle S3)

Owner 2026-10-22: "... run the blinds and raise them, take breaks, and anything
else a tournament would need". Before: a qualifier ran its 26 levels back to
back (NO break existed — the '+ Break' rows the .online Admin saves to
`qualifier_configs` were never read by the engine, and still are not: the
constants below rule), a director's Resume restarted the level at its FULL
length, and no state of a tournament table carried the level clock (poker-3d's
level widget, GameHUD, never showed). Now:

- **The clock** (`TournamentManager`): every armed blind timer sets
  `levelEndsAt`; `scheduleBlindUp(id, durationMs?)` can arm a partial level.
  `getLevelClock(id)` = {level, levels, durationSec, levelEndsAt, remainingMs
  (live; frozen while paused; null on a break), paused, pauseReason,
  breakUntil, sb, bb, ante, next | null, entries, alive}. `entries` = the field
  at the start, +1 per late entry (`addLateEntrant`) and re-entry
  (`reinstateForReentry`), -1 for an undone late entry (`removeLateEntrant`).
  `blindLevelUp` now carries `levelEndsAt` (additive; the new level's timer is
  armed BEFORE the event).
- **In every full state** (`getGameStateForPlayer`, next to `isTournament`),
  ALWAYS present so the per-socket delta clears them on a cash table:
  `blindLevel` (1-based | null), `nextBlindIn` (seconds; 0 while paused, at the
  last level, or on a cash table), `blindLevelDuration` (seconds | null) — the
  keys the live client's old level widget reads — and the additive
  `tournamentClock` {level, levels, sb, bb, ante, next, levelEndsAt, serverNow,
  paused, pauseReason, breakUntil, dealsAt (null — S4 fills it), playersLeft,
  entries, avgStack (= entries x starting stack / alive), paidPlaces
  (`seatsForTopWith` for a qualifier, else null), levelDurationMs,
  levelRemainingMs (frozen while paused), resumesAt (= breakUntil)} | null —
  the names poker-3d's `utils/tournamentClock.js` reads. Built once per
  tournament per 500 ms (`tournamentClockStateFor`; the builder runs per socket)
  and rebuilt at once when the clock's own fields change (a pause, a break, a
  level, an entry — the memo key includes them). Never throws into the state
  build (`tournament_clock_build_failed`). The bootstrap listener re-sends each
  table's state at a level-up (the clock follows mid-hand).
- **Breaks** (`QUALIFIER_BREAK_EVERY_LEVELS` = 5, `QUALIFIER_BREAK_MINUTES` = 5 in
  `src/game/qualifierSchedule.ts`; only `startQualifierTournament` sets
  `config.breaks`, so no other tournament changes). When the level timer fires
  at the end of level k and k % 5 === 0, k is not the last level, and
  `tournamentManager.breaksEnabled`: the tournament is PAUSED with reason
  'break' (`breakUntil`, `advanceOnResume`), the break's end timer is the
  tournament's `blindTimer` (so finish / void / a director pause clear it), and
  'tournamentBreak' {afterLevel, resumesAt} is emitted. Every table holds at its
  next hand boundary exactly as for a director pause (`autoStartNextHand`'s
  paused check, `tournamentDealHoldReason` 'paused' — overflow first deals, the
  startHand handler and the balance included); a hand in progress plays out.
  12-minute levels from 11:00 put the breaks at 12:00, 1:05, 2:10, 3:15 and 4:20
  MT; none after level 26. Late entries / re-entries during a break are seated
  and dealt in after it. The lobby's `structure` gains `breaks {everyLevels,
  minutes, on}` (additive; the levels and their 12-minute display are
  unchanged). `on` (review fix-up) = `tournamentManager.breaksEnabled` at the
  moment the item is built, so with the switch off the qualifier card stops
  promising breaks (poker-3d `qualifierBreaksText` reads `on: false` as none).
  - The bootstrap listener (the ONE `onEvent`): on 'tournamentBreak' every LIVE
    table room (overflow tables included) gets `tournamentPaused` {tournamentId,
    reason:'break', resumesAt (ISO), afterLevel} and its state; log
    `qualifier_break_started` {afterLevel, resumesAt, tables}. On
    'tournamentBreakEnded' (its own timer: the next level is already in force —
    blindLevelUp, full time): `balanceQualifierTablesNow` (S2's pre-deal pass; a
    no-op with its switch off), then every room `tournamentResumed`
    {tournamentId, reason:'break'} and `scheduleAutoStart` per table; log
    `qualifier_break_ended` {level, tables, balanceMoves}. Both handlers run
    inside the blind timer and NEVER throw (per-table try; a throw there would be
    an uncaughtException → the crash flush voids the event): failures log
    `qualifier_break_notice_failed` / `qualifier_break_resume_failed`.
- **Director pause** (`pauseTournament(id, paused, reason='director'|'prestart')`):
  Pause stores `levelRemainingMs` (>= 1 s) and stops the clock; Resume arms
  exactly that time (fixes "Resume restarts the level at full length"). A pause
  during a running BREAK replaces it (its timer stops; `breakUntil` null; the
  level stays over — Resume starts the NEXT level with its full time); a resume
  during a break ends it at once the same way. A 'prestart' hold (the 11:00
  deal, S4) is ended ONLY by a 'prestart' resume (which arms the full level 1);
  a director resume there returns false. The idempotence guard stays.
  **'prestart' is plumbing only as of S3:** nothing in the server pauses with
  reason 'prestart' yet and `tournamentClock.dealsAt` is always null. The
  owner's "open the rooms 10 minutes before game start" is NOT delivered by S3;
  it needs the S4 start-hold step (and poker-3d c80f157's tablesOpen / dealsAt
  card state gets no data until then). **Delivered by S4** (section "Online
  qualifier EARLY ROOMS (T-10)" below): the hold uses this 'prestart' reason and
  fills `tournamentClock.dealsAt`.
  - The polled tournament list (`getTournamentList`, the lobby's
    `tournamentList`) carries `pauseReason` next to `paused` (review fix-up;
    additive; null when not paused, 'director' when paused with no reason —
    the getLevelClock rule). poker-3d TournamentLobby's TD control
    (`marksDirectorPause`) offers '▶ Resume' only for a director pause; before
    the fix every scheduled break showed as director-paused there, and a TD's
    click ended the break at once.
  - The admin socket `pauseTournament` handler's body is `applyDirectorPause(tId,
    paused, actor)` (shared with the route): audits TOURNAMENT_PAUSE (durable),
    tells every table room `tournamentPaused` / `tournamentResumed`
    {tournamentId, reason:'director'} (reason additive), re-sends each table's
    state, re-kicks every table on Resume (F90 loop unchanged). During the
    'prestart' hold BOTH Pause and Resume are refused, nothing changes:
    'This tournament has not started yet.' (code `not_started`).
    Review fix-up: a Resume of a tournament that WAS paused (a director pause,
    a break, or a director pause that replaced a break) runs
    `balanceQualifierTablesNow` BEFORE the re-kick loop, as the break's own
    end does — busts in the hand that ran into the hold and late entries /
    re-entries seated during it are evened at once, not one move per hand
    boundary. Qualifiers only, a no-op with `QUALIFIER_TABLE_BALANCE` off,
    tables still in a hand skipped; wrapped in try (a throw never blocks the
    resume). An idempotent Resume (not paused) does not balance.
  - **`POST /api/qualifiers/pause`** `{"paused": 0|1|true|false, "qualifierId"?}`
    + `X-Internal-Token` — the director's backup when the owner's .online Admin
    link is not at hand. FAILS CLOSED (403; no token configured → always 403);
    a bad `paused` → 400; no `qualifierId` = the ONE running qualifier (none →
    404 `no_running_qualifier`, several → 409 `several_running` + their ids;
    unknown / not running id → 404 `qualifier_not_running`); prestart → 409
    `not_started`. Answers `{success, qualifierId, tournamentId, paused,
    pauseReason}`; actor `internal:pause`.
    `curl -s -X POST https://poker-server-production-60c0.up.railway.app/api/qualifiers/pause -H 'Content-Type: application/json' -H "X-Internal-Token: $INTERNAL_NOTIFY_TOKEN" -d '{"paused":1}'`
    (`{"paused":0}` resumes — and ends a running break early).
- **Kill switch (breaks).** Railway env `QUALIFIER_BREAKS=0` at boot (never
  change it during an event: a restart cancels it). During the event, NO
  restart: `POST /api/qualifiers/breaks {"on":0}` (+ token; 0 / 1 / true /
  false, anything else 400; answers `{success, previous, on}`; logged
  `qualifier_breaks_set`, audited `QUALIFIER_BREAKS_SET`, durable). Read at each
  level boundary; OFF never ends a break already running — `POST
  /api/qualifiers/pause {"paused":false}` ends it at once. The clock fields have
  no switch (additive; an old client ignores them).
- **Deploy order (review fix-up).** Ship poker-3d's HUD commits (f1198d2 +
  e7581ea, and the lobby card c2ce285 / c80f157) BEFORE this server, or
  together. The pushed client (origin/main 48e42a6) has an old level widget
  (GameHUD `blindLevel && nextBlindIn > 0`) that switches on as soon as these
  state keys arrive: it does not tick between frames and shows raw seconds
  ("Level 3 · Next in 718s"). Cosmetic only, but avoidable.
- **Rig knob.** `QUALIFIER_TEST_TIME_SCALE` (env table above) divides ONLY the
  engine's level and break lengths; inert on Railway / NODE_ENV=production by
  construction (`qualifierTestTimeScale`).
- **Health:** `r2Play.qualifiers.breaks` = {on, everyLevels, minutes, taken,
  endedEarly} (`endedEarly` = breaks a director pause / resume interrupted) and
  `r2Play.qualifiers.testTimeScale` (must read 1 in prod).
- **Contract:** CONTRACTS.md (the state fields, the paused / resumed payloads,
  the two routes). Manifest tokens `qualifier_break_started`, `tournamentClock`,
  `/api/qualifiers/breaks`, `/api/qualifiers/pause`.
- **Tests:** `tests/qualifierClockBreaks.test.ts` (real TournamentManager /
  PokerTable, the REAL bootstrap listener, `autoStartNextHand`, the routes,
  `getGameStateForPlayer` and `startQualifierTournament`, fake timers).
  `tests/gameplay_S8_tournaments.test.ts` F90 now slices `applyDirectorPause`
  with the handler (its loop moved there, two-space indent). Full jest 2193
  passed, 0 failed (baseline 2158 at 4b13ee8, +35); `npm run lint` and
  `npm run build` clean; manifest 772 tokens, 0 missing from `dist/`. Review
  fix-up: +8 in the same file (the list's pauseReason, the balance on Resume
  plus its CONTROL, structure.breaks.on); full jest 2201 passed, 0 failed.
- **Rig** (scratchpad `qrig/scenario-breaks.js`, `qrig/s3-rig.sh`;
  `restart-server.sh` passes `QUALIFIER_BREAKS` / `QUALIFIER_TEST_TIME_SCALE`
  through): at scale 60, the clock in every state, levels 12 s apart, break 1
  after L5 (held, a late entry during it, resumed at L6), a director pause in L7
  resuming the time left, break 2 replaced by a director pause, the switch OFF
  at L15 / ON at L20, the play-out with one results POST, places 1..N, chips
  and the credit ledger exact.
  - Results on 2026-10-23, on this dist: `scenario-breaks` with
    `QUALIFIER_TEST_TIME_SCALE=60` passed 47/47 twice (and a smoke run whose one
    miss was the script: the play-out reached L25's break, which is correct —
    the check now allows it). Break 1 started 12.0 s after L5 and lasted 5.0 s;
    both tables were seen held at the hand end with no new hand dealt; L8 came
    5.9 s after the director resume (the time that was left, not 12 s); the
    start landed 0.3 s after its scheduled second.
  - The legacy scenarios with `QUALIFIER_BREAKS=0`: `scenario-full` 28/28,
    `scenario-edge` 14/14 (overflow cap 0), `scenario-balance` 37/37,
    `scenario-overflow` 51/51 (balance 0, cap 2); no `qualifier_break_started`
    line in any of them; health showed `breaks.on:false`, `testTimeScale:1`.

### Online qualifier EARLY ROOMS (T-10) (2026-10-23, lifecycle S4)

Owner 2026-10-22: "open the rooms 10 minutes before game start so people can
join and then start the game on time". Before: the tables existed only from the
first 30 s tick at / after the start second, and hand 1 was dealt in that same
tick — nobody could sit down before 11:00. Now (the "Early rooms" block of
`src/index.ts`, after `tickQualifierAutoStart`):

- **The open** (`openQualifierTablesEarly`, from the tick of a 'registering'
  event when `scheduledAt - lead <= now < scheduledAt`). Only when ALL hold: at
  least 2 registrants are online NOW (`qualifierRegistrantOnline`); no
  suspension screen is in flight; a screen that began inside the screen window
  has completed (`qt.lastScreenAt >= scheduledAt - (lead + 5) min`). Otherwise
  nothing changes and the next tick retries. Then `startQualifierTournament(
  online registrants, stack, false, {tableCount: ceil(ALL registrants / 9),
  hold: true})`: the random draw seats the online ones, the tables are sized so
  every pending arrival finds a seat without an overflow table, the tournament
  is paused `'prestart'` right after its start (no blind clock: the level clock
  shows level 1 with its full 12 minutes, `levelEndsAt` null) and
  `bootstrapTournamentTables(…, {deal: false})` sets up the listeners, the
  states and the ONE `onEvent` but deals nothing. `qt.status = 'running'`
  (late registration seats a new registrant at once, as always), the hold is
  recorded (`qualifierPreStartHolds`: tournamentId → {qualId, dealsAt, timer})
  and its unref'd deal timer armed for the start second. The seated sockets get
  `qualifierTournamentStarted` {…, seated, seatIndex, dealsAt (ISO), preStart:
  true} (poker-3d takes a seated registrant to his table: "Cards are dealt at
  11:00 AM"); `qualifierTournamentUpdate` gains tablesOpen / dealsAt. Log
  `qualifier_tables_opened_early` {qualifierId, tournamentId, tables, seated,
  pending, dealsAt, leadMin}. `startQualifierTournament` answering null puts the
  event back to 'registering' (the old path runs at 11:00).
- **Pending registrants.** A registrant offline at the open stays in
  `qt.players` with his consumed credit and NO TournamentManager entrant.
  `seatPendingQualifierRegistrant` seats him — consuming NO credit — on a live
  socket that plays no seat elsewhere (TOURNEY-9; else he stays pending), on
  the fewest-alive table (`seatQualifierEntrantAt`, the late-entry placement
  with an optional socket; an overflow table if no seat is left), told
  `qualifierTournamentStarted {seated:true, tableId, seatIndex, dealsAt,
  preStart}`; log `qualifier_prestart_seated` {via}. Three triggers: the 5 s
  sweep (`serviceQualifierPreStartHolds`) and the 30 s tick, the lobby's
  "Take your seat" (`returnToTournamentSeat {tournamentId}` — answered exactly
  like a return: `reconnectedToTable` + a full state + `{success, tournamentId,
  tableId, seatIndex}`), and a Register tap (BEFORE `isPlayerQualified`: his one
  credit is already used, so the gate would refuse him `not_qualified`; answer
  `qualifierRegistrationResult {success, registered, preStart, tableId,
  seatIndex, tablesOpen, dealsAt}`). A NEW registrant during the hold is a
  normal late entry (one consume, seated at once), its frames and the
  QUALIFIER_LATE_ENTRY_SEATED audit carry `preStart: true` (+ dealsAt in the
  frames).
- **Nothing deals while held.** The 'prestart' pause holds the client
  `startHand` (`tournament_hand_held` 'paused'), the overflow first deal,
  `restartWaitingTournamentTables` and `autoStartNextHand`; the rebalance is
  skipped for a held tournament (`handleTableRebalance` returns at once, the
  5 s sweep `continue`s) — the tables are sized for every registrant, so Rule 1
  would otherwise break the half-empty ones at 10:50. A director Pause / Resume
  is refused `not_started` (S3).
- **The deal** (`runPreStartDeal`, its timer at the start second; the tick and
  the 5 s sweep as backstops). Idempotent — the hold marker is checked and
  deleted FIRST. (0) **Review fix-up:** fewer than 2 registrants PRESENT ->
  no deal, nobody released, the hold stays (`preStartDealMustWait`; see "Review
  fix-up" below); (1) presence sampled and split with the 2-minute grace; (2)
  with >= 2 present EVERY absent registrant is released through the UNCHANGED
  `releaseQualifierNoShows` (credit refunded, master row dropped, told at the
  next sign-in — the owner rule "no-shows removed + refunded at start" and the
  10:50 reminder stay true); a SEATED absent one is stood up first
  (`unseatPreStartEntrant`: standUp, `forgetSeatPointers`, his voluntary-absence
  mark, `removeLateEntrant` — places stay 1..N); (3) every present
  pending registrant is seated (on a free socket, else ABSENT and told
  `tournamentSeatKept {atStart:true}`; no seat at all → released + refunded,
  `qualifierCancelled {reason:'no_seat'}`, `seatFailures`); (4) **review
  fix-up:** every present SEATED entrant nobody plays is put back on his seat
  (`rebindPresentSeatedEntrantAtDeal`); (5) the breaks run
  now (Rule 1 / Rule 2, up to `QUALIFIER_PRESTART_MAX_BREAKS` = 60 synchronous
  breaks; the rebalance's own 500 ms cascade continues past it) and (6) S2's
  pre-deal balance (**review fix-up:** even with the balance switch off —
  `ignoreSwitch`); (7) the 'prestart' resume — the FULL level 1 starts now
  (`levelEndsAt` = start second + 12 min); (8) `restartWaitingTournamentTables
  {startWaiting:true}` deals every table with >= 2 alive (overflow tables
  included); (9) every table's state, `qualifierTournamentUpdate {tablesOpen:
  false, dealsAt: null}`, the tournament list. Steps 1-6 are in a try: a throw
  counts `holdErrors` and the tournament is STILL un-held and dealt. Log
  `qualifier_prestart_deal` {qualifierId, tournamentId, lateByMs, tables,
  dealtTables, seated, released, rebound, breaks, balanceMoves, alive, waitedMs
  (only after a wait)}. Backstop: for 10
  minutes after a deal the 5 s sweep (`servicePreStartDealBackstop`, from
  `serviceQualifierOverflowTables`) deals any of its tables still
  WaitingForPlayers with hand 0, >= 2 alive and no deal hold (log
  `qualifier_prestart_backstop_deal`).
- **Suspension screen.** Its window opens `lead + 5` minutes before the start
  (15 with the default; `qualifierScreenLeadMs`, 5 with the lead at 0); a
  completed screen stamps `qt.lastScreenAt` (the time it began). The 20 s loop
  (`tickQualifierScreens`) stays 'registering'-only: a suspension made after the
  open is caught by the hand-start play gate (rare, accepted).
- **A restart during the hold** (the shutdown flush): every registrant of a
  held event — and any registrant with no entrant — is told `qualifierCancelled
  {reason:'server_restart'}` like an upcoming event's; every credit (seated and
  pending) is refunded once by the release, as always; the hold goes.
- **Kill switch — two controls.** Railway env `QUALIFIER_TABLES_OPEN_BEFORE_MIN`
  at boot (default 10, clamp 0..30, garbage → 10; **0 = OFF** = the 11:00 start
  of before, with S1's on-time timer). While the server runs, NO restart:
  `curl -s -X POST https://poker-server-production-60c0.up.railway.app/api/qualifiers/tables-open -H 'Content-Type: application/json' -H "X-Internal-Token: $INTERNAL_NOTIFY_TOKEN" -d '{"minutes":0}'`
  — 0..30 (strict: a missing / non-numeric value → 400, nothing changes),
  403 without / with a wrong token and always 403 when no token is configured
  (fails closed); answers `{success, previous, minutes, held}`; logged
  `qualifier_tables_open_set`, audited `QUALIFIER_TABLES_OPEN_SET` (durable).
  A hold ALREADY open is not touched: it still deals at its start second (the
  hold marker drives the deal, never the lead). **The way back AFTER the open
  (review fix-up):** `-d '{"minutes":0,"closeOpen":true}'` also undoes every
  open hold (`revertQualifierPreStartHolds`; details below); `closeOpen` with
  minutes other than 0, or not 0 / 1 / true / false → 400, nothing changes.
- **Sunday ops:** to run Sunday WITHOUT early rooms, set the lead to 0 live
  (the curl above, `{"minutes":0}`) BEFORE 10:50 MT; check
  `/api/health` → `r2Play.qualifiers.preStart.leadMin` = 0. With it on, watch
  `preStart` from 10:50: `opened` 1, `held` lists the event until 11:00:00, then
  `dealt` 1 and `holdErrors` 0. A problem with the OPEN tables between 10:50 and
  11:00: `{"minutes":0,"closeOpen":true}` (answer `closed: 1`; never a restart —
  that cancels the event and refunds everyone); the event then starts at 11:00
  the old way. `held[].waitingSince` set = the start second found fewer than 2
  present (it deals once two are here; cancelled + refunded at 2 PM if never).
- **Health:** `r2Play.qualifiers.preStart` = {leadMin, opened, seatedAtOpen,
  seatedDuringHold, lateEntriesDuringHold, released, dealt, seatFailures,
  backstopDeals, holdErrors, leadChanges, dealsWaiting, cancelledTooFew,
  reboundAtDeal, withdrawnDuringHold, closedByOperator, held: [{qualifierId,
  tournamentId, dealsAt, waitingSince?}]} (`holdErrors` / `seatFailures` should
  stay 0).
- **Review fix-up (2026-10-23, five review findings on 177723c):**
  - *Fewer than 2 present at the start second* (`preStartDealMustWait`, the
    deal's step 0). It used to deal anyway with the seated ABSENT entrants: a
    no-show lost his credit and could finish in a seat-paying place. Now no
    card and nobody released: the hold stays (its timer gone), the 5 s sweep
    and the 30 s tick re-run the deal, which goes ahead the first time two
    are present (the no-shows released then; the FULL level 1 from that
    moment); an online pending registrant still sits down meanwhile. Still
    fewer than 2 after late registration ends → `cancelHeldQualifierEvent`:
    `closeHeldQualifierTables` (the tournament voided; every table retired at
    once — `retireFinishedTournamentTable` with reason `tournament_cancelled`:
    `tableClosed` to the room, sessions / reservations / timers ended, seats
    stood up with no credit) then the UNCHANGED `cancelQualifierEvent
    ('too_few_players')` — every credit refunded once, everyone told. This is
    the wait-then-cancel of the start of before. Logs
    `qualifier_prestart_deal_waiting` (once per hold), `qualifier_prestart_cancelled`.
  - *A way back after the open* (`revertQualifierPreStartHolds`, the route's
    `closeOpen`). Every open hold that has not dealt: `closeHeldQualifierTables`
    (reason `tables_reopen_at_start`), the event `'registering'` again with
    `tournamentId: null`, every registration and consumed credit KEPT (pending
    ones and the hold's late entries included), the lobbies told. The lead is
    0, so it never re-opens; the 30 s tick (and S1's timer) start it at the
    start second exactly as with the lead at 0. Log `qualifier_tables_open_closed`,
    audit `QUALIFIER_TABLES_OPEN_CLOSED` (durable).
  - *Back in the lobby during the hold* (`rebindPresentSeatedEntrantAtDeal`,
    the deal's step 4). Leaving the idle table marks a voluntary absence that
    no sign-in restores, so he was dealt in absent and auto-folded until he
    tapped "Go to my table". Now a PRESENT seated entrant whose seat no live
    socket plays is put back on a free live socket of his
    (`restoreAbsentTournamentSeat` voluntary 'any': `reconnectedToTable` + a
    full state, the client opens the table; the absence ends), as the start of
    before bound every online registrant at 11:00. Never a socket that holds a
    session or plays a live seat elsewhere (TOURNEY-9).
  - *Withdraw while held* (`withdrawPreStartRegistrant`, the unregister
    handler behind the 'prestart' check). From the open the event is
    'running', so a withdrawal was refused "already started" from 10:50. Now
    accepted until the deal: a seated one's live sockets get `seatVacated
    {reason:'withdrawn'}` and leave the room, his seat goes
    (`unseatPreStartEntrant`), the registration is dropped and the credit
    refunded exactly as before the open. After the deal: refused as before.
    poker-3d shows no Withdraw on a held card yet (client follow-up; a stale
    lobby can send it).
  - *Balance switch off* (`balanceQualifierTablesNow(…, {ignoreSwitch: true})`,
    the deal's step 6 ONLY). The tables are sized for every registrant and
    thinned unevenly by the releases ([9,9,1] / [9,8,2]: Rule 1 and Rule 2 do
    not fire, a lone base table waited undealt). The start of before seated
    the present players round-robin; the deal's leveling pass now runs even
    with `QUALIFIER_TABLE_BALANCE` off (the start's seating, before any card).
    The break end and a director's resume still read the switch. The lead at
    0 stops it.
- **Contract (additive, CONTRACTS.md):** lobby item `tablesOpen: true` +
  `dealsAt` (ISO) ONLY while held (absent otherwise); `qualifierTournamentUpdate`
  the same while held (`tablesOpen: false, dealsAt: null` at the deal);
  `qualifierTournamentStarted` + `seatIndex`, `dealsAt`, `preStart`;
  `qualifierRegistrationResult` + `preStart` (a pending registrant's tap or a
  late entry while held); `tournamentClock.dealsAt` (epoch ms while held); the
  route. Manifest tokens `qualifier_tables_opened_early`,
  `qualifier_prestart_deal`, `/api/qualifiers/tables-open`. Review fix-up:
  the route's `closeOpen` + `closed`; `tableClosed` reasons
  `tournament_cancelled` / `tables_reopen_at_start`; `seatVacated` reason
  `withdrawn`; unregister accepted while held; manifest tokens
  `qualifier_prestart_deal_waiting`, `qualifier_prestart_cancelled`,
  `qualifier_tables_open_closed`.
- **Old harnesses untouched.** Every new identifier an EXISTING handler or list
  path reads sits behind the 'prestart' pause (`tournamentManager.getTournament(
  id)?.pauseReason === 'prestart'` — only the early rooms set it): hand-listed
  harnesses (`absentSeat.test.ts`) throw on an unknown name, and
  `qualifierListItem` itself is unchanged (`qualifierList` and the REST item add
  the fields; `qualifierClockBreaks` asserts nothing it reads is stubbed).
- **Tests:** `tests/r2Qualifiers.test.ts` "2026-10-23 (qualifier lifecycle S4 …)
  — the EARLY ROOMS", E1-E16 + the pure parse + wiring (the REAL tick, early
  rooms block, screen, register / Return / startHand handlers,
  startQualifierTournament + bootstrap listener, rebalance helpers, S3 clock /
  pause and the shutdown claims, under fake timers). Full jest 2219 passed, 0
  failed (baseline 2201 at c57667e, +18); `npm run lint` and `npm run build`
  clean; manifest 775 tokens, 0 missing from `dist/`. Review fix-up: E7
  rewritten (it asserted the defect), + E7b (the late-close cancel), E17 (the
  way back), E18 (the rebind at the deal), E19 (withdraw while held), E20 (the
  balance switch off) + wiring; opt-in slices `S4_CLOSE_CODE` (the real table
  retirement) and `S4_SEATS_CODE` (the real seat restore + sessionHoldsSeat)
  so the other worlds are unchanged; each new test fails on 177723c's source.
  Full jest 2224 passed, 0 failed (+5); lint and build clean; manifest 778
  tokens, 0 missing from `dist/` (the `reason: 'tournament_finished'` literal
  kept in `retireFinishedTournamentTable`). The local rig was NOT re-run for
  the fix-up.
- **Rig (2026-10-23, scratchpad `qrig/s4-rig.sh`, on this dist;
  `restart-server.sh` passes `QUALIFIER_TABLES_OPEN_BEFORE_MIN` through):**
  - NEW `qrig/scenario-earlyopen.js` (lead 3 min so a run takes ~7 minutes,
    `QUALIFIER_TEST_TIME_SCALE=60`) passed 35/35 three times (+ a smoke run):
    the route 403 / 403 / 400; 24 register; the open ~176 s before the start
    with the 18 online seated on 3 tables (6 each), held (prestart, dealsAt, no
    card), a Deal refused 'paused'; pending bots seated by the sweep, Return
    and a Register tap with ZERO consumes; a new registrant one consume; nothing
    dealt before the start second; every table's first hand 27-82 ms after it
    (`lateByMs` 26-75); the full level 1 (`levelEndsAt` = start + 12 s at scale
    60); a seated and three pending no-shows released, each credit refunded
    once; 7/7/7; a returning no-show told and late-registered; the play-out
    with one results POST, places 1..22, the winner at exactly 50,000 x 22, an
    exact credit ledger, a clean server log.
  - `scenario-full` with N=99 and the default lead (10) passed 28/28: 97 seated
    at the open on 11 tables, 2 pending released, all 11 tables dealt 154 ms
    after the start second (the scenario now waits for the deal before its
    no-show checks when the frames say `preStart`, and counts a late entry
    during the hold as seated).
  - The legacy scenarios with `QUALIFIER_TABLES_OPEN_BEFORE_MIN=0`:
    `scenario-full` 28/28, `scenario-edge` 14/14 (overflow cap 0),
    `scenario-breaks` 47/47 (scale 60), `scenario-balance` 37/37,
    `scenario-overflow` 51/51 (balance 0, cap 2); no early-rooms log line in
    any of them.

### Online qualifier HAND-FOR-HAND at the seat bubble (2026-10-24)

Owner 2026-10-23: "Build it for Sunday" (it ships only if the local rig passes
by Saturday evening), plus the TDA companion: players eliminated in the SAME
hand-for-hand hand, at the same or different tables, are placed by their chip
count at the START of that hand. Sunday's package (15 seats to the top 10,
`seatsForTopWith` 10) puts the seat bubble at 11 alive. Before this, every table
dealt on its own, and busts at two tables in the same moment were placed by
whichever table's bust check ran first (`eliminatePlayer`: alive + 1 then).

All of it lives in the hand-for-hand block at the end of the rebalance helpers
(`// ===== Hand-for-hand at the qualifier seat bubble` … `// ===== end
hand-for-hand =====`) plus the pure `qualifierSchedule.ts` helpers and
`TournamentManager.placeSimultaneousBusts`. Qualifiers only.

- **When it engages** (`handForHandBubble` → `handForHandApplies`; ALL must hold):
  - the switch is on and the event has not tripped its watchdog;
  - the tournament is running and is a qualifier (`qualifierOfTournament`);
  - its late registration has CLOSED: `now > lateRegUntil` (strict; scheduledAt
    + 180 min — 2:00 PM Denver on Sunday). After the close no late entry or
    re-entry can shift a place, so re-placing a round's busts among their own
    numbers keeps places a permutation of 1..N. A registry row with no
    `scheduledAt` gives NaN: it never engages;
  - two or more tables are in play (live tournament tables with >= 1 alive);
  - `alive === seatsForTop + 1` AND `alive > 9` (a field that fits one table
    belongs to Rule 1). The weekly default (top 3) and the monthly (top 6) never
    engage.
  It is evaluated at a table's hand boundary, by the GATE. Hands already running
  then finish normally (their busts are ordinary). On engage: log
  `qualifier_hand_for_hand_engaged` {tournamentId, qualifierId, alive,
  seatsForTop, tables, lateRegUntil, watchdogMs}, and every table room gets the
  existing admin-broadcast toast `serverAnnouncement` {message, kind:
  'hand_for_hand', tournamentId, on:true, at} ("Hand-for-hand: 11 players left
  and the top 10 win seats. Every table now plays one hand at a time; your table
  waits for the others between hands.") plus its state.
- **The gate** (`handForHandHoldsDeal`, never throws — a throw is counted, trips
  the event, releases it and the table DEALS). Three one-line call sites:
  `autoStartNextHand` (after the paused / bust-check / deferred-break / under-5
  holds, BEFORE the overflow feed and the balance: a held table moves nobody),
  `tournamentDealHoldReason` (reason `'hand_for_hand'`: overflow first deals, the
  pre-start backstop, the client 'startHand' at WaitingForPlayers, which answers
  `tournament_hand_held` with that reason) and `restartWaitingTournamentTables`.
  A table due its round's ONE hand (`round.base` = its hand number, not yet
  `attempted`) is let through once; every other boundary holds. An idle held
  table arms the watchdog and queues the round service (`setImmediate`, never
  inside a deal path).
- **Rounds.** When every live table is idle (HandComplete / WaitingForPlayers),
  every bust check has run and no table is still due its round hand
  (`handForHandRoundSettled`), the service (the queued `setImmediate`, the 5 s
  sweep `serviceAllHandForHand()`, the watchdog): places and tells the round's
  busts; ends hand-for-hand if it no longer applies; while paused (a break or a
  director pause) goes back to GATHERING; else starts the next round
  (`startHandForHandRound`): a table break still pending runs first, then S2's
  pre-deal balance pass (all tables idle: they end within one player; a no-op with
  the balance switch off), a re-check (a break can leave one table), then every
  table's hand number becomes the round's base and every table is kicked in ONE
  pass (HandComplete: `scheduleAutoStart`, all armed together; WaitingForPlayers:
  `restartWaitingTournamentTables`). Log `qualifier_hand_for_hand_round` {round,
  alive, tables:[{tableId, hand, alive}]}. A table with fewer than 2 alive is
  skipped. A hand in progress always plays out; the level clock keeps running
  (owner call stated as the default: TDA says nothing; blinds can rise between
  rounds).
- **Same-hand busts.** `runTournamentBustCheck` finds the round of a check whose
  hand is that table's round hand (`handForHandRoundOf`: base + 1). Each human
  bust is eliminated AT ONCE as before (alive counts, the rebalance, Q1 / V1
  unchanged); only the TELLING waits: the bootstrap listener's room
  'playerEliminated' is held back (`handForHandNoticeDeferred`) and the bust is
  recorded {startStack, table order, seat, what the bust check decided about his
  sockets}. At the settle (and on EVERY exit path: release, watchdog, switch-off,
  error, tournament over) `placeAndTellHandForHandBusts`: two or more busts are
  re-placed by `TournamentManager.placeSimultaneousBusts` (bigger starting stack
  = better place, among their OWN place numbers; eliminationOrder slots refilled
  worst first; only while the tournament runs), logged
  `qualifier_hand_for_hand_busts_placed` {round, running, busts:[{playerId,
  tableId, seatIndex, startStack, from, to}]} and audited
  QUALIFIER_HAND_FOR_HAND_PLACES (durable — the finish order's trail); then each
  is told, worst place first, through `tellTournamentBustNow` (the old inline tell
  block, moved verbatim; his socket re-checked: still live, still his account,
  still at that table and not seated elsewhere) plus the room copy
  'playerEliminated' {…, handForHand:true} (additive). Nobody is ever told a
  provisional place. Counted `bustsPlaced` / `placesChanged`.
- **Exact ties (the stated default for the owner):** equal starting stacks share
  ONE tie group across tables (the existing tie rule: `finishTournament` splits
  their places' money and marks them `tied` — a qualifier's pool is 0, nothing
  moves). The distinct numbers the master needs follow the existing in-table
  rule: the LOWER-numbered seat takes the WORSE place; across tables the lower
  table in `tableIds` order (Qualifier Table 1 before 2) counts as lower. So at a
  10th / 11th tie the higher (table, seat) gets 10th.
- **Ends** (`qualifier_hand_for_hand_ended` {reason, rounds, alive}; the rooms get
  `serverAnnouncement` {kind:'hand_for_hand', on:false} "Hand-for-hand is over:
  normal play resumes." and every held table is kicked): `bubble_burst` (alive <=
  seatsForTop), `one_table`, `switch_off`, `tournament_over`, `watchdog`,
  `error`, `not_bubble` (alive went ABOVE the bubble — a late entry that committed
  just after the close; it re-engages at 11).
- **Watchdog — fail OPEN.** A round not settled `watchdogMs` (240 000 ms;
  `qualifierHandForHandWatchdogMs(qualifierTestTimeScale)` — the rig scale divides
  it, floor 5 s; always 4 min on Railway) after it STARTED (while gathering:
  after the first table held) releases every held table: log
  `qualifier_hand_for_hand_watchdog_released` {round, heldMs, held, waitingOn:
  [{tableId, phase, handNumber, base, bustCheckPending}]}, audit
  QUALIFIER_HAND_FOR_HAND_WATCHDOG (durable), `watchdogReleases`++, and the event
  is TRIPPED: it never re-engages until an operator sends `{"on":1}`. So the worst
  case is ONE 4-minute delay per event. The paused time never counts: while the
  tournament is paused (a break, a director pause) the watchdog polls every 5 s
  and moves its clock on (and the 5 s sweep does too). An all-absent table (30 s
  per decision) can need more than 4 minutes for one hand: that trips it (accepted
  risk).
- **Interplay.** Breaks / director pause: tables hold on the pause first (never
  the gate); the round's busts are placed and told during the pause; the resume /
  break end re-kicks every table into the gate → one new round. Balance: held
  tables make no moves; round start runs the pre-deal pass. Rebalance: a table
  broken mid-round leaves `tableIds` and is not waited for (its busts were
  recorded by its bust check). Overflow: no new tables after the close. Absent /
  disconnected players: their clock runs as before. Restarts: all state in memory
  (a restart already cancels a running qualifier).
- **Runtime switch (no restart).** Railway env `QUALIFIER_HAND_FOR_HAND=0` at boot
  (unset = ON). During the event:
  `curl -s -X POST https://poker-server-production-60c0.up.railway.app/api/qualifiers/hand-for-hand -H 'Content-Type: application/json' -H "X-Internal-Token: $INTERNAL_NOTIFY_TOKEN" -d '{"on":0}'`
  — OFF releases every engaged event AT ONCE (busts recorded so far are placed
  among themselves and told, held tables dealt). `{"on":1}` turns it back on and
  RE-ARMS a tripped event. 0 / 1 / true / false; anything else → 400, nothing
  changes; missing / wrong token → 403; no token configured → always 403 (fails
  closed). Answers `{success, previous, on, released, rearmed}`. Logged
  `qualifier_hand_for_hand_set`, audited QUALIFIER_HAND_FOR_HAND_SET (durable).
  **Sunday ops: never restart to change it** (a restart cancels the event); use the
  route. Use the token from the environment; never paste it into a chat.
- **Health:** `r2Play.qualifiers.handForHand` = {on, watchdogMs, engaged:
  [{tournamentId, qualifierId, round, gathering, held, heldSinceMs}],
  engagedTotal, rounds, bustsPlaced, placesChanged, watchdogReleases, released:
  {bubble_burst, one_table, switch_off, watchdog, tournament_over, error,
  not_bubble}, tripped: [tournamentId], errors, switchChanges}. `errors` and
  `watchdogReleases` should stay 0; `watchdogMs` must read 240000 in prod.
- **Contract (additive; CONTRACTS.md at the workspace root must be updated in the
  SHIP step):** the route; `tournamentClock.handForHand` / `handForHandRound`
  (null while gathering) / `handForHandText` (present ONLY while engaged — the S3
  exact baseline is unchanged otherwise; the memo key carries it, so the frame
  rebuilds at once); `playerEliminated.handForHand`; `serverAnnouncement.kind`
  `'hand_for_hand'` (+ `tournamentId`, `on`); the `tournament_hand_held` reason
  `'hand_for_hand'`. No client change is needed (poker-3d toasts
  `serverAnnouncement` and ignores the extra keys). Optional client polish (not
  shipped): poker-3d `utils/tournamentClock.js` could show `handForHandText` as the
  waiting banner.
- **Manifest tokens:** `qualifier_hand_for_hand_engaged`,
  `qualifier_hand_for_hand_busts_placed`, `/api/qualifiers/hand-for-hand`.
- **Tests:** `tests/qualifierHandForHand.test.ts` (HP1-HP6: the predicate, the
  watchdog length and boot switch, `placeSimultaneousBusts` incl. cross-table,
  disqualified / unknown / duplicate ids, exact ties, guards);
  `tests/rebalanceSafety.test.ts` "H" (H1-H13: the REAL autoStartNextHand,
  handleHandComplete, bust check, deal-hold reason, restart loop, listener,
  startHand and route — engage / hold / one hand per round; every engage
  condition; a pending bust check; cross-table placement + deferred notices;
  bubble burst; a table broken mid-round; the watchdog; pause / break (incl. a
  round still due across a pause); the switch; the client startHand; the sweep;
  a throwing registry read; wiring); `tests/qualifierClockBreaks.test.ts` C1 / C2.
  `tests/logoutSeatTeardown.test.ts` slices the new bust-check pieces; the
  round-5 CONTROL "plays here read AFTER the elimination" now mutates before
  `tellTournamentBustNow`. Full jest 2259 passed, 30 skipped, 0
  failed (baseline 2224 at 5b8ad77, +35); `npm run lint` and `npm run build` clean;
  manifest 781 tokens, 0 missing from `dist/`.
- **Rig (PENDING — the ship gate; not run in this commit):** scenario
  `qrig/scenario-handforhand.js` (the design's R0-R8 at
  `QUALIFIER_TEST_TIME_SCALE=12`: a 20 s watchdog; a schedule fixture whose late
  close is ~6 min after setup); `restart-server.sh` passes
  `QUALIFIER_HAND_FOR_HAND` through. Ship gate: 3 consecutive passes + a smoke run
  and every legacy scenario green with ZERO engaged lines (they end inside the
  real 3 h window).
- **Deviations from the design (written reasons):** (1) the watchdog also runs
  from each round's START (covers a round where no table ever reaches the gate),
  and polls every 5 s while paused instead of relying on the sweep alone (a
  round still due across a pause gets its full time after the resume); (2) a
  throw in the gate releases with its kicks DEFERRED (`setImmediate`) — releasing
  synchronously inside `restartWaitingTournamentTables` could deal a table twice;
  (3) the end reason is re-checked after the round-start break; (4) the extra
  release reason `not_bubble`; (5) the places log + durable audit are written for
  every non-empty batch (a single bust too), with `running`.

### Recovering a qualifier's finish order (the results POST never landed)

Since 2026-10-22 (owner: "Save finish order to DB") `postQualifierResults`
writes three DURABLE rows to poker-server's `audit_log` table (Postgres-dCcH,
`details` is JSONB): `QUALIFIER_RESULTS_RECORDED` (as the POST goes out, with
`finishOrder` = the exact `results` array it POSTs: master player id, place,
points), `QUALIFIER_RESULTS_POSTED` (the master answered 2xx) and
`QUALIFIER_RESULTS_POST_FAILED` (8 attempts over ~10 minutes all failed; with
`finishOrder` again). The write is fire-and-forget and never delays, stops or
re-sends the POST (`tests/qualifierResultsDurable.test.ts`).

1. Did the master get it? `GET <master>/qualifiers/<masterQualifierId>` (public)
   lists `data.results`. Railway dashboard → Postgres-dCcH → Database → Data →
   query box:
   ```sql
   SELECT ts, action, jsonb_array_length(details->'finishOrder') AS players_saved,
          details->>'attempts' AS attempts, details->>'error' AS error
     FROM audit_log
    WHERE action IN ('QUALIFIER_RESULTS_RECORDED', 'QUALIFIER_RESULTS_POSTED', 'QUALIFIER_RESULTS_POST_FAILED')
      AND details->>'masterQualifierId' = '<masterQualifierId>'
    ORDER BY ts;
   ```
   RECORDED followed by POSTED = landed, nothing to do. RECORDED with no
   POSTED (a POST_FAILED row, or a restart inside the retry window) = replay.
2. The replay body, ready to send:
   ```sql
   SELECT jsonb_array_length(details->'finishOrder') AS players,
          jsonb_build_object('results', details->'finishOrder')::text AS replay_body
     FROM audit_log
    WHERE action = 'QUALIFIER_RESULTS_RECORDED'
      AND details->>'masterQualifierId' = '<masterQualifierId>'
    ORDER BY ts DESC LIMIT 1;
   ```
3. Send it as `POST <master>/qualifiers/<masterQualifierId>/results`. A re-send
   is safe: results are upserted, a seat package re-post mints nothing, monthly
   entries / credits are insert-if-absent.

   **No admin page has a button for this** (poker-admin's
   `qualifiersApi.recordResults` is defined, but no page calls it). The route
   is `adminAuth`: `X-Admin-User-Id` plus a Bearer token of that same user (the
   API refuses a mismatch). The admin site already holds both, so send it from
   the browser Console of an admin tab:
   - Use a computer where YOU are signed in to https://admin.americanpub.poker
     (the normal sign-in, not a kiosk tablet's "Admin Login": that one has no
     token of yours). Open the admin site, press F12, open **Console**. The
     first time, Chrome asks you to type `allow pasting`.
   - Copy the snippet below into a text editor and fill in its three
     `PASTE_…` values: the qualifier id, step 2's `players`, and step 2's
     `replay_body` exactly as copied (no quotes around it). Then paste the
     whole snippet into the Console and press Enter.
   - It checks everything first and prints `NOT SENT: <why>` instead of
     sending: the id, the player count against step 2 (a `replay_body` that was
     cut off while copying fails here, or does not parse at all, so a partial
     order never goes out), that every row has a player and a place, and that
     the tab's token is yours and not about to expire.
   - After the POST it prints `SENT` with what the master recorded, then
     re-reads `GET /qualifiers/<id>`. The results count it prints must equal
     `players`. `REFUSED (HTTP 401)`: reload the tab, sign in again, paste
     again. `403`: that account is not an admin. Nothing is awarded on a
     refusal.
   - `/results/internal` (the route poker-server itself uses) takes the
     `INTERNAL_NOTIFY_TOKEN` secret instead. Do not copy that secret by hand
     for a replay; use the admin Console.
   - It awards seats, so an agent runs it in the owner's admin tab only with
     the owner's OK.

   `tests/qualifierResultsDurable.test.ts` runs this exact snippet, taken from
   this file, against the body that step 2 builds from a real
   `QUALIFIER_RESULTS_RECORDED` row.
   ```js
   // qualifier-results-replay (poker-server AGENT.md): paste into the Console of an admin.americanpub.poker tab.
   (async () => {
     const QID = 'PASTE_QUALIFIER_ID_HERE';   // e.g. 7a8dd4a8-cc63-4c91-8da6-dacc8a58da38 (Sun 2026-10-25)
     const PLAYERS = PASTE_PLAYERS_HERE;      // step 2's `players` (a number)
     let body = PASTE_REPLAY_BODY_HERE;       // step 2's `replay_body`, as copied (no quotes)
     const API = 'https://poker-prod-api-azeg4kcklq-uc.a.run.app/poker-api';
     const stop = (why) => { console.error('NOT SENT: ' + why); return 'not sent'; };
     if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(QID)) return stop('QID is not a qualifier id.');
     if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { return stop('replay_body is not complete JSON (copy it again, whole).'); } }
     const results = Array.isArray(body) ? body : body && body.results;
     if (!Array.isArray(results) || results.length === 0) return stop('replay_body has no results.');
     if (results.length !== PLAYERS) return stop('replay_body has ' + results.length + ' players, step 2 said ' + PLAYERS + ' (copy it again, whole).');
     if (!results.every((r) => r && typeof r.playerId === 'string' && r.playerId && Number.isInteger(r.finishPosition) && r.finishPosition > 0)) return stop('a row has no playerId or no place.');
     let me = null;
     try { const s = JSON.parse(localStorage.getItem('poker_admin_session') || 'null'); me = (s && ((s.user && s.user.id) || s.userId || s.id)) || null; } catch (_) { me = null; }
     if (!me) return stop('this tab is not signed in to admin. Sign in, then paste again.');
     const isJwt = (t) => typeof t === 'string' && t.split('.').length === 3;
     const at = localStorage.getItem('oauth_access_token');
     const idt = localStorage.getItem('oauth_id_token');
     const token = isJwt(at) ? at : isJwt(idt) ? idt : null;
     let claims = null;
     try { const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); claims = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))); } catch (_) { claims = null; }
     if (!claims || claims.sub == null || String(claims.sub).toLowerCase() !== String(me).toLowerCase()) return stop('this tab has no sign-in token of your own (a kiosk "Admin Login" has none). Sign in to admin as yourself, then paste again.');
     if (!(Number(claims.exp) * 1000 > Date.now() + 60000)) return stop('your sign-in token is about to expire. Reload this tab, wait 10 seconds, then paste again.');
     let res;
     try {
       res = await fetch(API + '/qualifiers/' + QID + '/results', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json', 'X-Admin-User-Id': String(me), Authorization: 'Bearer ' + token },
         body: JSON.stringify({ results }),
       });
     } catch (e) { console.error('NO ANSWER (' + (e && e.message) + '). It is safe to paste again.'); return 'no answer'; }
     const out = await res.json().catch(() => ({}));
     if (!res.ok) { console.error('REFUSED (HTTP ' + res.status + '): ' + (out.message || '') + '. Nothing was awarded. 401: reload this tab, sign in again, paste again. 403: this account is not an admin.'); return 'refused'; }
     console.log('SENT. The master recorded ' + (out.data && out.data.recorded) + ' results. Seats and monthly entries: ' + JSON.stringify(out.data && out.data.advanced));
     const check = await fetch(API + '/qualifiers/' + QID).then((r) => r.json()).catch(() => null);
     const saved = check && check.data && Array.isArray(check.data.results) ? check.data.results.length : null;
     console.log('Results now on the master: ' + (saved == null ? '(could not read; open GET /qualifiers/' + QID + ')' : saved) + ' (must be ' + PLAYERS + ').');
     return 'sent';
   })();
   ```
4. **Credits the master did not give back** (2026-10-23, lifecycle S1). Every
   refund of a qualifier credit (a no-show released at the start, a withdraw,
   a cancel, a `no_seat` / refused late entry or re-entry, a suspended
   registrant, the shutdown flush) that the master did not confirm leaves a
   DURABLE `audit_log` row: `QUALIFIER_*_REFUND_FAILED` with `qualifierId` (the
   master qualifier id) and `creditId`. There is no automatic retry; reconcile
   after the event:
   ```sql
   SELECT ts, action, actor, details->>'creditId' AS credit_id, details->>'reason' AS reason, details
     FROM audit_log
    WHERE (action LIKE 'QUALIFIER_%REFUND_FAILED' OR action LIKE 'QUALIFIER_%SHARED_KEPT')
      AND details->>'qualifierId' = '<masterQualifierId>'
    ORDER BY ts;
   ```
   - `*_SHARED_KEPT` rows: the credit was KEPT on purpose (two calls got the
     same credit and the other entry stands on it). Never refund those.
   - `QUALIFIER_REENTRY_BUYIN_REFUND_FAILED` carries `buyIn` (chips), not a
     credit. A qualifier's buy-in is 0, so it should never appear. If one does,
     return the chips with the admin chip grant (`adminGrantChips`, audited).
   - For each `credit_id`, read the credit on the MASTER database (Cloud SQL,
     not Railway):
     ```sql
     SELECT id, player_id, tier, redeemed_at, notes FROM qualifier_credits WHERE id IN ('<credit_id>', '<credit_id>');
     ```
     A consume sets `redeemed_at` and appends ` [entry:<qid>]` or
     ` [re-entry:<qid>]` to `notes`; a refund clears `redeemed_at` but keeps
     `notes`. So `redeemed_at` is always the credit's LATEST consume (an admin
     redeem also sets it, and REPLACES `notes`), and the question per row is
     whether an entry in this event stands on THAT consume. Decide per row:
     - `redeemed_at` IS NULL → it was already given back (the master answers
       `refunded:false` for a credit that is not redeemed). Nothing to do.
     - Still redeemed: compare `redeemed_at` with the LATEST
       `QUALIFIER_*_REFUND_FAILED` row for this credit, by `creditId` alone
       (any event; the durable re-entry consume / refund rows come with it):
       ```sql
       SELECT ts, action, actor, details FROM audit_log WHERE details->>'creditId' = '<credit_id>' ORDER BY ts DESC;
       ```
       - `redeemed_at` BEFORE that row → no consume came after the failure, so
         the refund that failed was for the credit's current redemption: the
         entry it paid for was refused, released or withdrawn, and nothing
         stands on it. Refund it, however many times this event's tag appears.
       - `redeemed_at` AFTER that row → the credit was given back after all (a
         lost answer, a later refund) and consumed again by a LATER entry or
         re-entry, which stands on it (had its own refund failed too, that
         would be a later FAILED row). Leave it.
       - The two times come from two clocks (the master's Cloud SQL for
         `redeemed_at`, poker-server's database for `ts`). Within a few seconds
         of each other, decide by poker-server's own lines instead: find the
         LATEST consume of this credit (`QUALIFIER_REENTRY_CREDIT_CONSUME` in
         `audit_log`; `QUALIFIER_ENTRY_CREDIT_CONSUME` only in Railway stdout,
         each `[AUDIT]` line carries its own ISO time). A `*_REFUND_FAILED` for
         the credit after it, with no successful refund line after it
         (`QUALIFIER_CREDIT_REFUND`, `QUALIFIER_ENTRY_CREDIT_REFUND`,
         `QUALIFIER_REENTRY_CREDIT_REFUND`, `QUALIFIER_SUSPENDED_CREDIT_REFUND`)
         → refund it. Nothing after it, or only a `*_SHARED_KEPT` → an entry
         stands on it: leave it.
     - NEVER decide by how many times this event's tag appears in `notes`. The
       master takes the player's OLDEST unused credit first and a refund keeps
       the notes, so a credit given back (say a no-show released at the start)
       and taken again by the same player's late entry carries this event's
       tag TWICE. If that late entry's `no_seat` refund then fails, the credit
       is still redeemed with two tags, its `redeemed_at` is before the FAILED
       row, and NO entry stands on it: it is owed (the old "tag twice → leave
       it" rule lost that credit).
     - Cross-check per player: a player in this event's
       `QUALIFIER_RESULTS_RECORDED` `finishOrder` (or with a `qualifier_entries`
       row on the master) had at least one entry stand. It does not say which
       credit it stood on, so it never overrides the rule above. A disqualified
       (suspended) entrant is left out of the finish order too.
   - The refund: no admin page can un-redeem a credit (admin Championship only
     lists and redeems). Use the same idempotent call poker-server makes, with
     the token taken from the environment (never pasted into a chat or a form).
     It only flips a redeemed credit back:
     `curl -s -X POST https://poker-prod-api-azeg4kcklq-uc.a.run.app/poker-api/qualifier-credits/refund/internal -H 'Content-Type: application/json' -H "X-Internal-Token: $INTERNAL_NOTIFY_TOKEN" -d '{"creditId":"<credit_id>"}'`
     → `{"success":true,"refunded":true}`. `refunded:false` = it was not
     redeemed (nothing changed).
   - It gives a credit back to a player, so an agent runs it only with the
     owner's OK.
   - A row written during a SIGTERM / crash flush can be lost if the process
     exits before the insert lands. The `SHUTDOWN_FLUSH` row's
     `qualifierRegistrationsReleased` says how many refunds that flush started.

## Gotchas

- **There is no SQLite (corrected 2026-10-11, CLUBS-P3-1).** Clubs (and
  friends, predictions, brackets, the economy / prize / ticket ledgers) live in
  the Railway Postgres (`DATABASE_URL`) and are durable — clubs moved off the
  ephemeral better-sqlite3 `/data/poker.db` file on 2026-06-19
  (`src/clubs/clubManager.ts` `initClubTables`). What IS ephemeral is the
  in-process state: tables, seats, sessions, reservations, running
  tournaments (a restart ends them — hard rule 1). `better-sqlite3` is still a
  package.json dependency that nothing imports (CLUBS-P3-2).
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
  2026-10-10 (F2 review): the rebalance found a human's session ONLY via
  `TournamentPlayer.socketId` — the REGISTRATION socket, never updated on a
  reconnect — so a player who reconnected once was NOT moved. FIXED by P6
  (`moveTournamentSeatPointers`): every live session pointing at his old seat
  (any socket) and his reservation follow the stack, and `socketId` follows
  the live session. Still left to the disconnect handler: a session on a
  socket that is already gone (F2's guards cover that window).
  2026-10-10 (Q1/Q2): the rebalance never breaks a table whose bust check is
  still pending (row 19), and it finds a mover by his LIVE seat — never by
  playerId alone (a qualifier re-entry leaves an old busted seat with the same
  playerId on the table).
  2026-10-10 (S1/M1): a table never deals while its bust check is pending, and a
  mover with no live seat is never seated (re-mapped or eliminated, never an AI
  with an unpaid stack).
  2026-10-10 (V1, pe3): "pending" now means EVERY completed hand's check — a
  no-bust hand too — and a bust check never takes a seat with chips in a hand
  in progress (an all-in of the next hand). A rebalance that moves an ABSENT
  seat tells his live sockets (updated `tournamentSeatKept`, row 23 V4).
  2026-10-10 (round 5, pe4): a leave whose own fold breaks the table tells
  the leaving socket the FINAL seat only; a busted seat vacated for a mover
  leaves a holder who already watches another table on that table (P-g).
  2026-10-10 (round 6, pe5 — simplify): the hand-complete DB writes before
  the bust check are SERIAL again (P-l — round 5's parallel writes were
  reverted); a sitting-out tournament seat is dealt in and blinded like an
  absent one (P-j — a heads-up with a sitting-out finalist used to never
  deal); the turn timer re-arms on a new street; a detach ends a busted
  seat's session at another table (P-g dead seat).
- **`chipVelocityAlerts` count decay — FIXED (2026-06-10 audit
  verified).** `incrementChipVelocityAlert` (index.ts:419) applies
  retroactive decay (`count - floor(idle / 24h)`) on every alert, and
  that function is the ONLY consumer of the count (the auto-ban at
  index.ts:~1552 reads `incrementChipVelocityAlert()`'s return). A user
  with 2 stale alerts + 48h idle gets recomputed to 1 on their next
  alert, NOT banned. No stale-read path exists. The previous "never
  decays" note was stale.
