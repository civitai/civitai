import { describe, expect, it } from 'vitest';
import {
  isMoreLikeThisVisible,
  moreLikeThisHref,
  wantsNewTab,
} from '~/components/Image/MoreLikeThisButton';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';

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

  it('is not offered on images it cannot search from, as Remix refuses image-to-image', () => {
    const flags = { moreLikeThis: true, feedSearch: true, imageSearch: false };
    const scanned = { ...image, ingestion: ImageIngestionStatus.Scanned };
    expect(isMoreLikeThisVisible(flags, scanned)).toBe(true);
    expect(isMoreLikeThisVisible(flags, { ...scanned, minor: true })).toBe(false);
    expect(isMoreLikeThisVisible(flags, { ...scanned, poi: true })).toBe(false);
    expect(isMoreLikeThisVisible(flags, { ...scanned, blockedFor: 'Moderated' })).toBe(false);
    expect(
      isMoreLikeThisVisible(flags, { ...image, ingestion: ImageIngestionStatus.Blocked })
    ).toBe(false);
    expect(
      isMoreLikeThisVisible(flags, { ...image, ingestion: ImageIngestionStatus.Pending })
    ).toBe(false);
  });

  it('opens a new tab for a modified or middle click, and navigates in place otherwise', () => {
    const click = { ctrlKey: false, metaKey: false, shiftKey: false, button: 0 };
    expect(wantsNewTab(click)).toBe(false);
    expect(wantsNewTab({ ...click, ctrlKey: true })).toBe(true);
    expect(wantsNewTab({ ...click, metaKey: true })).toBe(true);
    expect(wantsNewTab({ ...click, shiftKey: true })).toBe(true);
    expect(wantsNewTab({ ...click, button: 1 })).toBe(true);
  });
});
