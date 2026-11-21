import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { imageRatingOfNsfwLevel } from '~/shared/constants/browsingLevel.constants';

/**
 * `imageRatingOfNsfwLevel` names the rating a `store-listing@v1` media item is published under
 * (`catalog-media.ts`), and the read model refuses an item whose level is not exactly its rating's
 * bit (`apps/app-index-go/internal/store/listing.go`). So it must be EXACT: one rating per single
 * level bit, and none for anything that is not one image's own level.
 */
describe('imageRatingOfNsfwLevel', () => {
  it.each([
    [NsfwLevel.PG, 'pg'],
    [NsfwLevel.PG13, 'pg13'],
    [NsfwLevel.R, 'r'],
    [NsfwLevel.X, 'x'],
    [NsfwLevel.XXX, 'xxx'],
  ] as const)('level %i is rating %s', (level, rating) => {
    expect(imageRatingOfNsfwLevel(level)).toBe(rating);
  });

  it.each([
    ['0 (not rated)', 0],
    ['Blocked (32)', NsfwLevel.Blocked],
    ['R|X (12), two bits', NsfwLevel.R | NsfwLevel.X],
  ] as const)('%s has no rating', (_name, level) => {
    expect(imageRatingOfNsfwLevel(level)).toBeNull();
  });
});
