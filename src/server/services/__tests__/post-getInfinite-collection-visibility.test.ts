import { describe, it, expect } from 'vitest';
import {
  CollectionContributorPermission,
  CollectionReadConfiguration,
} from '~/shared/utils/prisma/enums';
import { canViewCollectionPost } from '~/server/services/post-collection-visibility';

// Regression test for the prod 500 on `post.getInfinite`:
//   INTERNAL_SERVER_ERROR "Cannot read properties of undefined (reading '0')"
//   (22 occurrences / 3h on civitai-dp-prod).
//
// Root cause: the collection-permission filter in `getPostsInfinite` indexed
// `collection.contributors[0]` unconditionally, but `contributors` is only
// selected when the request has a logged-in user. For an anonymous viewer of a
// NON-Public collection, `contributors` is `undefined`, so `contributors[0]`
// threw `reading '0'`. `canViewCollectionPost` is the extracted predicate that
// carries the guard; we exercise it directly (no DB) so the seam is cheap.

describe('canViewCollectionPost (post.getInfinite collection filter)', () => {
  it("does NOT throw and hides the post when an anonymous viewer hits a non-Public collection (contributors undefined) — the exact prod crash", () => {
    // The precise value that reached the old code: a non-Public collection whose
    // `contributors` field was never selected (anonymous request).
    const collection = { read: CollectionReadConfiguration.Private } as {
      read: CollectionReadConfiguration;
      contributors?: { permissions: CollectionContributorPermission[] }[];
    };
    expect(collection.contributors).toBeUndefined();

    // Sanity-anchor: the ORIGINAL unguarded access on this exact value throws the
    // exact prod error signature. The guarded predicate must NOT.
    expect(() => (collection.contributors as any)[0]).toThrowError(
      /Cannot read properties of undefined \(reading '0'\)/
    );

    expect(() => canViewCollectionPost(collection)).not.toThrow();
    expect(canViewCollectionPost(collection)).toBe(false);
  });

  it('hides the post for a non-Public collection with an empty contributors array', () => {
    expect(
      canViewCollectionPost({ read: CollectionReadConfiguration.Private, contributors: [] })
    ).toBe(false);
  });

  it('shows the post for a non-Public collection where the viewer has VIEW permission', () => {
    expect(
      canViewCollectionPost({
        read: CollectionReadConfiguration.Private,
        contributors: [{ permissions: [CollectionContributorPermission.VIEW] }],
      })
    ).toBe(true);
  });

  it('hides the post for a non-Public collection where the contributor lacks VIEW permission', () => {
    expect(
      canViewCollectionPost({
        read: CollectionReadConfiguration.Private,
        contributors: [{ permissions: [CollectionContributorPermission.ADD] }],
      })
    ).toBe(false);
  });

  it('shows the post for a Public collection even when contributors is undefined (anonymous viewer)', () => {
    expect(canViewCollectionPost({ read: CollectionReadConfiguration.Public })).toBe(true);
  });
});
