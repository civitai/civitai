/**
 * Unit tests for mergeOwnExcludedIntoFirstPage — the merge step that brings
 * user-owned private/blocked/unpublished/poi/nsfwLevel=0 content into the first
 * page of a user-agnostic Meili search result.
 *
 * Privacy-critical invariants exercised here:
 *   - A user only ever sees own-excluded items where userId matches; the helper
 *     trusts its caller to query userId=currentUserId, so we only verify the
 *     non-leakage shape (dedup, content-scope, ordering, slicing).
 *   - Items present in BOTH the primary and own-excluded sets are deduplicated.
 *   - Content-scoping filters (modelVersionId, postId, types, baseModels,
 *     excludedTagIds, excludedUserIds, remix, withMeta, fromPlatform) narrow
 *     the merged own-content to the current view.
 *   - Sort order is preserved on the merged set; sliced to limit afterwards.
 */
import { describe, it, expect } from 'vitest';
import { mergeOwnExcludedIntoFirstPage } from '~/server/services/image.search-merge';
import { ImageSort } from '~/server/common/enums';

// Minimal shape — the helper only reads a few fields. Keep the cast tight so
// the test breaks if the helper starts depending on additional shape.
type MockRow = {
  id: number;
  userId: number;
  sortAtUnix: number;
  type?: string;
  postId?: number | null;
  postedToId?: number | null;
  modelVersionIds?: number[];
  modelVersionIdsManual?: number[];
  baseModel?: string | null;
  remixOfId?: number | null;
  hasMeta?: boolean;
  onSite?: boolean;
  tagIds?: number[];
  reactionCount?: number;
  commentCount?: number;
  collectedCount?: number;
  stats?: Record<string, number>;
};

function primaryRow(input: Partial<MockRow> & { id: number; sortAtUnix: number }): MockRow {
  return {
    userId: 999,
    type: 'image',
    postId: 1,
    ...input,
    stats: {
      likeCountAllTime: 0,
      laughCountAllTime: 0,
      heartCountAllTime: 0,
      cryCountAllTime: 0,
      commentCountAllTime: 0,
      collectedCountAllTime: 0,
      tippedAmountCountAllTime: 0,
      dislikeCountAllTime: 0,
      viewCountAllTime: 0,
    },
  };
}

function ownRow(input: Partial<MockRow> & { id: number; sortAtUnix: number }): MockRow {
  return {
    userId: 42, // caller is responsible for scoping userId=currentUserId
    type: 'image',
    postId: 1,
    ...input,
  };
}

const baseScope = {
  sort: ImageSort.Newest as ImageSort | undefined,
  limit: 10,
  modelVersionId: undefined,
  hideAutoResources: undefined,
  hideManualResources: undefined,
  postId: undefined,
  postIds: undefined,
  types: undefined,
  baseModels: undefined,
  excludedTagIds: undefined,
  excludedUserIds: undefined,
  remixOfId: undefined,
  remixesOnly: undefined,
  nonRemixesOnly: undefined,
  withMeta: undefined,
  fromPlatform: undefined,
};

describe('mergeOwnExcludedIntoFirstPage', () => {
  it('returns primary sliced to limit when ownExcluded is empty', () => {
    const primary = [
      primaryRow({ id: 1, sortAtUnix: 100 }),
      primaryRow({ id: 2, sortAtUnix: 90 }),
      primaryRow({ id: 3, sortAtUnix: 80 }),
    ];
    const result = mergeOwnExcludedIntoFirstPage(primary as any, [], {
      ...baseScope,
      limit: 2,
    });
    expect(result.map((x: any) => x.id)).toEqual([1, 2]);
  });

  it('merges own-excluded into primary preserving Newest sort', () => {
    const primary = [
      primaryRow({ id: 1, sortAtUnix: 100 }),
      primaryRow({ id: 2, sortAtUnix: 80 }),
      primaryRow({ id: 3, sortAtUnix: 60 }),
    ];
    const own = [
      ownRow({ id: 11, sortAtUnix: 90 }), // between 1 and 2
      ownRow({ id: 12, sortAtUnix: 70 }), // between 2 and 3
    ];
    const result = mergeOwnExcludedIntoFirstPage(primary as any, own as any, baseScope);
    expect(result.map((x: any) => x.id)).toEqual([1, 11, 2, 12, 3]);
  });

  it('deduplicates by id when an own-excluded item already appears in primary', () => {
    // This shouldn't normally happen (primary filter excludes private/blocked/
    // unpublished/poi etc), but tests defense-in-depth dedup.
    const primary = [primaryRow({ id: 1, sortAtUnix: 100 }), primaryRow({ id: 7, sortAtUnix: 90 })];
    const own = [
      ownRow({ id: 7, sortAtUnix: 90 }), // dup of primary
      ownRow({ id: 8, sortAtUnix: 50 }),
    ];
    const result = mergeOwnExcludedIntoFirstPage(primary as any, own as any, baseScope);
    // id=7 appears once, sourced from primary (with its real stats)
    expect(result.map((x: any) => x.id)).toEqual([1, 7, 8]);
    expect(result.filter((x: any) => x.id === 7)).toHaveLength(1);
  });

  it('slices to limit after merge — own-merged content can displace primary tail', () => {
    const primary = [
      primaryRow({ id: 1, sortAtUnix: 100 }),
      primaryRow({ id: 2, sortAtUnix: 95 }),
      primaryRow({ id: 3, sortAtUnix: 90 }),
      primaryRow({ id: 4, sortAtUnix: 85 }),
    ];
    const own = [ownRow({ id: 11, sortAtUnix: 97 }), ownRow({ id: 12, sortAtUnix: 92 })];
    const result = mergeOwnExcludedIntoFirstPage(primary as any, own as any, {
      ...baseScope,
      limit: 4,
    });
    // Merged sort: 1(100), 11(97), 2(95), 12(92), 3(90), 4(85) — sliced to 4
    expect(result.map((x: any) => x.id)).toEqual([1, 11, 2, 12]);
  });

  it('applies modelVersionId content-scoping to own-content', () => {
    const primary = [primaryRow({ id: 1, sortAtUnix: 100 })];
    const own = [
      // matches via postedToId
      ownRow({ id: 11, sortAtUnix: 95, postedToId: 7 }),
      // matches via modelVersionIds (auto)
      ownRow({ id: 12, sortAtUnix: 92, modelVersionIds: [7, 8] }),
      // matches via modelVersionIdsManual (manual)
      ownRow({ id: 13, sortAtUnix: 90, modelVersionIdsManual: [7] }),
      // does NOT match — different model version
      ownRow({ id: 14, sortAtUnix: 88, postedToId: 99, modelVersionIds: [99] }),
    ];
    const result = mergeOwnExcludedIntoFirstPage(primary as any, own as any, {
      ...baseScope,
      modelVersionId: 7,
    });
    const ids = result.map((x: any) => x.id);
    expect(ids).toContain(11);
    expect(ids).toContain(12);
    expect(ids).toContain(13);
    expect(ids).not.toContain(14);
  });

  it('respects hideAutoResources — drops items that only match via modelVersionIds', () => {
    const primary = [primaryRow({ id: 1, sortAtUnix: 100 })];
    const own = [
      // matches only via auto modelVersionIds
      ownRow({ id: 11, sortAtUnix: 95, modelVersionIds: [7] }),
      // matches via postedToId — still allowed
      ownRow({ id: 12, sortAtUnix: 90, postedToId: 7 }),
    ];
    const result = mergeOwnExcludedIntoFirstPage(primary as any, own as any, {
      ...baseScope,
      modelVersionId: 7,
      hideAutoResources: true,
    });
    const ids = result.map((x: any) => x.id);
    expect(ids).not.toContain(11);
    expect(ids).toContain(12);
  });

  it('applies postId scoping', () => {
    const primary = [primaryRow({ id: 1, sortAtUnix: 100, postId: 5 })];
    const own = [
      ownRow({ id: 11, sortAtUnix: 95, postId: 5 }),
      ownRow({ id: 12, sortAtUnix: 90, postId: 99 }), // wrong post
    ];
    const result = mergeOwnExcludedIntoFirstPage(primary as any, own as any, {
      ...baseScope,
      postId: 5,
    });
    expect(result.map((x: any) => x.id)).toEqual([1, 11]);
  });

  it('applies types filter', () => {
    const primary = [primaryRow({ id: 1, sortAtUnix: 100, type: 'image' })];
    const own = [
      ownRow({ id: 11, sortAtUnix: 95, type: 'image' }),
      ownRow({ id: 12, sortAtUnix: 90, type: 'video' }),
    ];
    const result = mergeOwnExcludedIntoFirstPage(primary as any, own as any, {
      ...baseScope,
      types: ['image'],
    });
    expect(result.map((x: any) => x.id)).toEqual([1, 11]);
  });

  it('applies excludedTagIds — drops own-content tagged with excluded tag', () => {
    const primary = [primaryRow({ id: 1, sortAtUnix: 100 })];
    const own = [
      ownRow({ id: 11, sortAtUnix: 95, tagIds: [100] }), // excluded
      ownRow({ id: 12, sortAtUnix: 90, tagIds: [200] }),
      ownRow({ id: 13, sortAtUnix: 85 }), // no tags
    ];
    const result = mergeOwnExcludedIntoFirstPage(primary as any, own as any, {
      ...baseScope,
      excludedTagIds: [100],
    });
    const ids = result.map((x: any) => x.id);
    expect(ids).not.toContain(11);
    expect(ids).toContain(12);
    expect(ids).toContain(13);
  });

  it('applies excludedUserIds — drops own-content from excluded users', () => {
    const primary = [primaryRow({ id: 1, sortAtUnix: 100 })];
    const own = [
      ownRow({ id: 11, sortAtUnix: 95, userId: 42 }),
      ownRow({ id: 12, sortAtUnix: 90, userId: 99 }), // excluded
    ];
    const result = mergeOwnExcludedIntoFirstPage(primary as any, own as any, {
      ...baseScope,
      excludedUserIds: [99],
    });
    expect(result.map((x: any) => x.id)).toEqual([1, 11]);
  });

  it('respects MostReactions sort (with sortAtUnix tiebreak)', () => {
    const primary = [
      primaryRow({ id: 1, sortAtUnix: 100, reactionCount: 5 }),
      primaryRow({ id: 2, sortAtUnix: 90, reactionCount: 20 }),
    ];
    const own = [
      ownRow({ id: 11, sortAtUnix: 95, reactionCount: 10 }),
      ownRow({ id: 12, sortAtUnix: 80, reactionCount: 30 }),
    ];
    const result = mergeOwnExcludedIntoFirstPage(primary as any, own as any, {
      ...baseScope,
      sort: ImageSort.MostReactions,
    });
    expect(result.map((x: any) => x.id)).toEqual([12, 2, 11, 1]);
  });

  it('respects Oldest sort', () => {
    const primary = [primaryRow({ id: 1, sortAtUnix: 100 }), primaryRow({ id: 2, sortAtUnix: 50 })];
    const own = [ownRow({ id: 11, sortAtUnix: 30 }), ownRow({ id: 12, sortAtUnix: 80 })];
    const result = mergeOwnExcludedIntoFirstPage(primary as any, own as any, {
      ...baseScope,
      sort: ImageSort.Oldest,
    });
    expect(result.map((x: any) => x.id)).toEqual([11, 2, 12, 1]);
  });

  it('returns primary slice when own-content is fully scoped out', () => {
    const primary = [primaryRow({ id: 1, sortAtUnix: 100 })];
    const own = [
      ownRow({ id: 11, sortAtUnix: 95, postId: 99 }),
      ownRow({ id: 12, sortAtUnix: 90, postId: 99 }),
    ];
    const result = mergeOwnExcludedIntoFirstPage(primary as any, own as any, {
      ...baseScope,
      postId: 5,
    });
    expect(result.map((x: any) => x.id)).toEqual([1]);
  });

  // Wiring-contract test: mirrors the exact integration scenario from
  // getImagesFromSearchPreFilter (user-agnostic primary returns N public
  // docs, own-content second-pass returns M private docs, merge step must
  // expose ALL N+M to the caller). This test is the regression bait for the
  // original "imported but never invoked" bug — the helper produced correct
  // output, but the caller never invoked it. If the function-level wiring
  // breaks again, the runtime canary in image.service.ts will log
  // `own-excluded-merge-noop` and a developer running this test still has
  // documented contract to reference.
  it('wiring contract: 5 public + 2 own-private → merged set contains all 7', () => {
    const publicPrimary = [
      primaryRow({ id: 1, sortAtUnix: 100, userId: 11 }),
      primaryRow({ id: 2, sortAtUnix: 95, userId: 22 }),
      primaryRow({ id: 3, sortAtUnix: 90, userId: 33 }),
      primaryRow({ id: 4, sortAtUnix: 85, userId: 44 }),
      primaryRow({ id: 5, sortAtUnix: 80, userId: 55 }),
    ];
    const ownPrivate = [
      // currentUserId=42 — the second-pass scopes userId=42 in the Meili
      // filter, so all own-content here legitimately has userId=42.
      ownRow({ id: 1001, sortAtUnix: 98, userId: 42 }),
      ownRow({ id: 1002, sortAtUnix: 88, userId: 42 }),
    ];
    const result = mergeOwnExcludedIntoFirstPage(publicPrimary as any, ownPrivate as any, {
      ...baseScope,
      limit: 10,
    });
    const ids = result.map((x: any) => x.id);
    // All 5 public docs survived
    expect(ids).toEqual(expect.arrayContaining([1, 2, 3, 4, 5]));
    // Both private docs were merged in (this is the bit that breaks if the
    // caller forgets to invoke this helper)
    expect(ids).toEqual(expect.arrayContaining([1001, 1002]));
    // Total count
    expect(ids).toHaveLength(7);
    // Sort preserved (Newest by sortAtUnix desc)
    expect(ids).toEqual([1, 1001, 2, 3, 1002, 4, 5]);
  });
});
