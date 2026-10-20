// 2026-10-20 — imports for tests/qualifierPlaces.test.ts (the real engine + the real qualifier structure).
export { TournamentManager } from '../../src/game/TournamentManager';
import { qualifierBlindLevels } from '../../src/game/qualifierSchedule';
export const qualifierBlindLevelsForTest = () => qualifierBlindLevels(50_000);
