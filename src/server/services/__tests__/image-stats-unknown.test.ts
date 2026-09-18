import { describe, expect, it } from 'vitest';
import { toImageV2Stats } from '~/server/services/image.service';

// `toImageV2Stats` is the one place an image's metric row becomes a feed `stats`
// block. The distinction it has to preserve is the whole ticket: ClickHouse
// answering "no rows" is a real zero, ClickHouse not answering is unknown, and both
// arrive as zeros in the counts.
describe('toImageV2Stats', () => {
  // ClickHouse answered. `getImageMetricsObject` maps a falsy count to null via
  // `m?.Like || null`, so an image nobody reacted to is PRESENT with null counts —
  // which is exactly the shape an unknown image would have if presence were not the
  // signal. This case is why `statsUnknown` reads `!match` and not the counts.
  const answeredWithNoReactions = {
    imageId: 1,
    reactionLike: null,
    reactionHeart: null,
    reactionLaugh: null,
    reactionCry: null,
    comment: null,
    collection: null,
    buzz: null,
  };

  it('marks an image the read never answered for as unknown', () => {
    expect(toImageV2Stats(undefined).statsUnknown).toBe(true);
  });

  it('does NOT mark a real zero as unknown, though its counts are identical', () => {
    const unknown = toImageV2Stats(undefined);
    const zero = toImageV2Stats(answeredWithNoReactions);

    expect(zero.statsUnknown).toBe(false);
    // Stated as a comparison rather than two separate assertions: the counts are
    // equal in both, so `statsUnknown` is the ONLY thing carrying the difference. If
    // it stopped being derived, this is the line that fails.
    expect(zero.likeCountAllTime).toBe(unknown.likeCountAllTime);
    expect(zero.heartCountAllTime).toBe(unknown.heartCountAllTime);
    expect(zero.statsUnknown).not.toBe(unknown.statsUnknown);
  });

  it('passes real counts through untouched', () => {
    const stats = toImageV2Stats({
      ...answeredWithNoReactions,
      reactionLike: 7,
      reactionHeart: 3,
      comment: 2,
      buzz: 500,
    });

    expect(stats).toMatchObject({
      likeCountAllTime: 7,
      heartCountAllTime: 3,
      commentCountAllTime: 2,
      tippedAmountCountAllTime: 500,
      statsUnknown: false,
    });
  });
});
