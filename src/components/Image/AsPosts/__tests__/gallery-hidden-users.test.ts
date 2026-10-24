import { describe, expect, it } from 'vitest';
import { getEffectiveGalleryHiddenUserIds } from '~/components/Image/AsPosts/gallery-hidden-users';

describe('getEffectiveGalleryHiddenUserIds', () => {
  it("hides the union of the model's own list and the creator's list", () => {
    expect(
      getEffectiveGalleryHiddenUserIds({
        modelHiddenUserIds: [1, 2],
        creatorHiddenUserIds: [2, 3],
        viewerId: 99,
      }).sort()
    ).toEqual([1, 2, 3]);
  });

  // Decision: a hidden user still sees their own posts, from either list. Filtering is
  // client-side over a payload identical for every viewer, so this is the only place the viewer
  // is taken out.
  it('never hides the viewer from themselves, whichever list they are on', () => {
    expect(
      getEffectiveGalleryHiddenUserIds({
        modelHiddenUserIds: [1],
        creatorHiddenUserIds: [2],
        viewerId: 2,
      })
    ).toEqual([1]);
    expect(
      getEffectiveGalleryHiddenUserIds({
        modelHiddenUserIds: [1],
        creatorHiddenUserIds: [2],
        viewerId: 1,
      })
    ).toEqual([2]);
  });

  it('hides everyone on both lists from a logged-out viewer', () => {
    expect(
      getEffectiveGalleryHiddenUserIds({ modelHiddenUserIds: [1], creatorHiddenUserIds: [2] })
    ).toEqual([1, 2]);
  });
});
