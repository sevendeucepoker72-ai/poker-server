/**
 * 2026-11-02 (broadcast P1-S0) — WHICH COMMIT this process runs, for
 * `/api/health` (`commit`, and `broadcast.commit`).
 *
 * WHY. Nothing proved that the live Railway build equals a given git commit:
 * `/api/health` had no commit hash, so "is d2a52b5 live?" was unanswerable
 * from the dev box (Railway env is not readable from it). A broadcast deploy
 * freeze and a rollback both need that answer.
 *
 * SOURCE. Railway injects `RAILWAY_GIT_COMMIT_SHA` (with RAILWAY_GIT_BRANCH /
 * _AUTHOR / _COMMIT_MESSAGE) into deployments it builds FROM A GIT PUSH. A
 * `railway up` upload from a working tree carries no git metadata, so the value
 * is absent there. That the variable is set on our service is UNCONFIRMED
 * (2026-11-02: the Railway CLI on the dev box was signed out): `commit: null`
 * after a deploy means "this build was not a git-push build", never "broken".
 *
 * Only a plain 7-40 hex value is reported (lower-cased); anything else is null,
 * so the health JSON can never echo an arbitrary env string.
 */
export const DEPLOY_COMMIT_ENV = 'RAILWAY_GIT_COMMIT_SHA';

export function deployedCommitOf(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env[DEPLOY_COMMIT_ENV];
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return /^[0-9a-f]{7,40}$/i.test(v) ? v.toLowerCase() : null;
}
