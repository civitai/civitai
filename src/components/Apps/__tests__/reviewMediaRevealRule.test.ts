import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  mostMatureReviewImage,
  reviewMediaNeedsReveal,
} from '~/components/Apps/reviewMediaRevealRule';

describe('reviewMediaNeedsReveal — which review images are held behind the click-to-reveal', () => {
  it.each([
    ['R', NsfwLevel.R, true],
    ['X', NsfwLevel.X, true],
    ['XXX', NsfwLevel.XXX, true],
    // A composite carrying a mature bit is mature.
    ['PG | R', NsfwLevel.PG | NsfwLevel.R, true],
    ['PG', NsfwLevel.PG, false],
    ['PG-13', NsfwLevel.PG13, false],
    ['unrated (0)', 0, false],
    ['missing', null, false],
  ])('on civitai.com: %s → %s', (_label, level, held) => {
    expect(reviewMediaNeedsReveal(false, level)).toBe(held);
    // A host whose `canViewNsfw` flag is not resolved is treated as civitai.com.
    expect(reviewMediaNeedsReveal(undefined, level)).toBe(held);
  });

  it('a host that shows mature content holds nothing back', () => {
    for (const level of [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX])
      expect(reviewMediaNeedsReveal(true, level)).toBe(false);
  });
});

describe('mostMatureReviewImage', () => {
  it('picks the highest level, skipping absent images', () => {
    const a = { imageId: 1, nsfwLevel: NsfwLevel.PG13 };
    const b = { imageId: 2, nsfwLevel: NsfwLevel.XXX };
    const c = { imageId: 3, nsfwLevel: NsfwLevel.R };
    expect(mostMatureReviewImage([a, null, b, undefined, c])).toBe(b);
    expect(mostMatureReviewImage([null, undefined])).toBeNull();
  });
});
