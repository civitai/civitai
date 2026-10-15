import { describe, expect, it } from 'vitest';
import { creatorScoreSplitFromMeta } from '~/shared/utils/creator-score';

const split = (scores: Record<string, unknown>) => creatorScoreSplitFromMeta({ scores });

describe('creatorScoreSplitFromMeta', () => {
  it('gives each category its share, the shares adding up to 100', () => {
    expect(split({ models: 1, images: 1, articles: 1, users: 0 })).toEqual({
      models: 34,
      images: 33,
      articles: 33,
      users: 0,
    });
  });

  it('rounds by largest remainder, not each share on its own', () => {
    // 66.5 / 16.75 / 16.75 would each round to 67 + 17 + 17 = 101.
    expect(split({ models: 665, images: 167.5, articles: 167.5 })).toEqual({
      models: 66,
      images: 17,
      articles: 17,
      users: 0,
    });
  });

  it('counts only models, images, articles and followers', () => {
    expect(
      split({
        models: 100,
        users: 100,
        reportsActioned: 10_000,
        staffAwarded: 10_000,
        reportsAgainst: -10_000,
        total: 1,
      })
    ).toEqual({ models: 50, images: 0, articles: 0, users: 50 });
  });

  it('treats a negative or non-numeric category as nothing', () => {
    expect(split({ models: -500, images: 300, articles: 'x', users: null })).toEqual({
      models: 0,
      images: 100,
      articles: 0,
      users: 0,
    });
  });

  it('is null when nothing is positive, or there are no scores', () => {
    expect(split({ models: 0, reportsAgainst: -1000 })).toBeNull();
    expect(creatorScoreSplitFromMeta(null)).toBeNull();
    expect(creatorScoreSplitFromMeta({})).toBeNull();
  });
});
