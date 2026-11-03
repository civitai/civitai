import { describe, expect, it } from 'vitest';
import {
  buildCreatorScoreUnlocks,
  compiledCreatorScoreUnlockInputs,
} from '~/server/services/creator-score-unlocks.service';

const SPARK = 500;
const turfUnlock = (hatTurfLive: boolean, turfMinScore = SPARK) =>
  buildCreatorScoreUnlocks({ ...compiledCreatorScoreUnlockInputs, hatTurfLive, turfMinScore }).find(
    (u) => u.key === 'hat-turf-team-stickers'
  );

describe('Hat Turf on the Creator Journey unlock list', () => {
  it('is listed at the turf score while Hat Turf is open to everyone', () => {
    expect(turfUnlock(true)).toMatchObject({ minScore: SPARK, surface: 'events' });
  });

  it('is absent otherwise, so testers and the end of the event leave no stale promise', () => {
    expect(turfUnlock(false)).toBeUndefined();
  });
});
