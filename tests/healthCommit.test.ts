/**
 * 2026-11-02 (.online tournament broadcast, P1-S0) — /api/health carries
 * `commit`: the git commit of this build (Railway RAILWAY_GIT_COMMIT_SHA on a
 * git-push deploy), so the live build can be proved. null when unknown (a
 * `railway up` upload carries no git metadata); never an arbitrary env string.
 */
import { deployedCommitOf, DEPLOY_COMMIT_ENV } from '../src/deployInfo';
import { SRC, slice } from './helpers/indexSource';

describe('P1-S0 — the deployed commit on /api/health', () => {
  it('reads RAILWAY_GIT_COMMIT_SHA (a 7-40 hex value, lower-cased); unset / blank / junk → null', () => {
    expect(DEPLOY_COMMIT_ENV).toBe('RAILWAY_GIT_COMMIT_SHA');
    expect(deployedCommitOf({ RAILWAY_GIT_COMMIT_SHA: 'd2a52b5f0c1e2d3a4b5c6d7e8f90a1b2c3d4e5f6' })).toBe('d2a52b5f0c1e2d3a4b5c6d7e8f90a1b2c3d4e5f6');
    expect(deployedCommitOf({ RAILWAY_GIT_COMMIT_SHA: '  D2A52B5 ' })).toBe('d2a52b5');
    expect(deployedCommitOf({})).toBeNull();
    expect(deployedCommitOf({ RAILWAY_GIT_COMMIT_SHA: '' })).toBeNull();
    expect(deployedCommitOf({ RAILWAY_GIT_COMMIT_SHA: 'main' })).toBeNull();
    expect(deployedCommitOf({ RAILWAY_GIT_COMMIT_SHA: '<script>alert(1)</script>' })).toBeNull();
    expect(deployedCommitOf({ RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(41) })).toBeNull();
  });

  it('the /api/health route answers `commit` (the field is present: a value or null) in its 200 body', () => {
    const route = slice("app.get('/api/health', async (_req, res) => {", "res.status(503).json({ status: 'unhealthy'");
    expect(route).toContain('commit: deployedCommitOf(process.env),');
    expect(route.indexOf('commit: deployedCommitOf(process.env),')).toBeLessThan(route.indexOf("status: 'unhealthy'"));
    expect(SRC).toContain("import { deployedCommitOf } from './deployInfo';");
  });
});
