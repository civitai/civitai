import { describe, expect, it } from 'vitest';
import { isMoreLikeThisVisible, moreLikeThisHref } from '~/components/Image/MoreLikeThisButton';
import { MediaType } from '~/shared/utils/prisma/enums';

const image = { id: 42, type: MediaType.image };

describe('more like this', () => {
  it('opens the images feed under feedSearch, otherwise the image search page', () => {
    expect(moreLikeThisHref({ feedSearch: true }, 42)).toBe('/images?similarTo=42');
    expect(moreLikeThisHref({ feedSearch: false }, 42)).toBe('/search/images?similarTo=42');
  });

  it('shows for images under either search flag, never for videos or without one', () => {
    expect(isMoreLikeThisVisible({ imageSearch: false, feedSearch: true }, image)).toBe(true);
    expect(isMoreLikeThisVisible({ imageSearch: true, feedSearch: false }, image)).toBe(true);
    expect(isMoreLikeThisVisible({ imageSearch: false, feedSearch: false }, image)).toBe(false);
    expect(
      isMoreLikeThisVisible(
        { imageSearch: true, feedSearch: true },
        { id: 1, type: MediaType.video }
      )
    ).toBe(false);
  });
});
