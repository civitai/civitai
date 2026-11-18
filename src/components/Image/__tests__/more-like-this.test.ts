import { describe, expect, it } from 'vitest';
import { isMoreLikeThisVisible, moreLikeThisHref } from '~/components/Image/MoreLikeThisButton';
import { MediaType } from '~/shared/utils/prisma/enums';

const image = { id: 42, type: MediaType.image };

describe('more like this', () => {
  it('opens the images feed under feedSearch, otherwise the image search page', () => {
    expect(moreLikeThisHref({ feedSearch: true }, 42)).toBe('/images?similarTo=42');
    expect(moreLikeThisHref({ feedSearch: false }, 42)).toBe('/search/images?similarTo=42');
  });

  it('shows for images under moreLikeThis and either search flag, never for videos', () => {
    const on = { moreLikeThis: true };
    expect(isMoreLikeThisVisible({ ...on, imageSearch: false, feedSearch: true }, image)).toBe(
      true
    );
    expect(isMoreLikeThisVisible({ ...on, imageSearch: true, feedSearch: false }, image)).toBe(
      true
    );
    expect(isMoreLikeThisVisible({ ...on, imageSearch: false, feedSearch: false }, image)).toBe(
      false
    );
    expect(
      isMoreLikeThisVisible(
        { ...on, imageSearch: true, feedSearch: true },
        { id: 1, type: MediaType.video }
      )
    ).toBe(false);
  });

  it('stays hidden without moreLikeThis, whatever the search flags', () => {
    expect(
      isMoreLikeThisVisible({ moreLikeThis: false, imageSearch: true, feedSearch: true }, image)
    ).toBe(false);
  });
});
