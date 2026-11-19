import { describe, expect, it } from 'vitest';
import { imageStatsToReactionMetrics } from '~/components/Reaction/image-reaction-metrics';

describe('imageStatsToReactionMetrics', () => {
  it('carries the Buzz tip total with the reaction counts', () => {
    expect(
      imageStatsToReactionMetrics({
        likeCountAllTime: 4,
        dislikeCountAllTime: 0,
        heartCountAllTime: 3,
        laughCountAllTime: 2,
        cryCountAllTime: 1,
        tippedAmountCountAllTime: 90,
      })
    ).toEqual({
      likeCount: 4,
      dislikeCount: 0,
      heartCount: 3,
      laughCount: 2,
      cryCount: 1,
      tippedAmountCount: 90,
    });
  });

  it('reads absent stats as zero counts', () => {
    expect(imageStatsToReactionMetrics(null)).toEqual({
      likeCount: 0,
      dislikeCount: 0,
      heartCount: 0,
      laughCount: 0,
      cryCount: 0,
      tippedAmountCount: 0,
    });
  });
});
