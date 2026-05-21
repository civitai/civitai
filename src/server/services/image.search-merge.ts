/**
 * Merge helper for the user-agnostic Meili PreFilter strategy.
 *
 * The main Meili query in getImagesFromSearchPreFilter runs without per-user
 * OR clauses so its cache key is shared across logged-in users. A separate
 * "own-excluded" query fetches the current user's private/blocked/unpublished/
 * poi/nsfwLevel=0 content (scoped only by userId for cacheability), and this
 * function merges those items into the first page of the primary result.
 *
 * Privacy contract:
 *   - Caller is responsible for ensuring ownExcluded[*].userId === currentUserId.
 *     This helper does NOT verify userId — it trusts the upstream Meili filter.
 *   - Items are deduplicated by id when the same image appears in both sets.
 *
 * Behavioral contract:
 *   - Content-scoping (modelVersionId/postId/types/baseModels/excludedTagIds/
 *     excludedUserIds/remixOfId/remixesOnly/nonRemixesOnly/withMeta/fromPlatform)
 *     is applied to own-excluded items to mirror the equivalent Meili filters
 *     in the primary query.
 *   - Sort order is preserved on the merged set, then sliced to `limit`.
 *     Slicing may displace some primary items from the page-1 view — those are
 *     NOT re-fetched on page 2 (BitDex precedent — acceptable correctness
 *     trade-off given typical own-excluded counts are < 20).
 */
import { ImageSort } from '~/server/common/enums';

export type MergeOwnContentScope = {
  sort: ImageSort | undefined;
  limit: number;
  modelVersionId: number | undefined;
  hideAutoResources: boolean | undefined;
  hideManualResources: boolean | undefined;
  postId: number | undefined;
  postIds: number[] | undefined;
  types: string[] | undefined;
  baseModels: string[] | undefined;
  excludedTagIds: number[] | undefined;
  excludedUserIds: number[] | undefined;
  remixOfId: number | undefined;
  remixesOnly: boolean | undefined;
  nonRemixesOnly: boolean | undefined;
  withMeta: boolean | undefined;
  fromPlatform: boolean | undefined;
};

// Minimal shape consumed by the helper. Kept structural (not nominal) so it
// composes with ImageMetricsSearchIndexRecord without dragging that import here.
export type OwnContentDoc = {
  id: number;
  userId: number;
  sortAtUnix?: number;
  type?: string;
  postId?: number | null;
  postedToId?: number | null;
  modelVersionIds?: number[];
  modelVersionIdsManual?: number[];
  baseModel?: string | null;
  tagIds?: number[];
  remixOfId?: number | null;
  hasMeta?: boolean;
  onSite?: boolean;
  reactionCount?: number;
  commentCount?: number;
  collectedCount?: number;
};

const ZERO_STATS = {
  likeCountAllTime: 0,
  laughCountAllTime: 0,
  heartCountAllTime: 0,
  cryCountAllTime: 0,
  commentCountAllTime: 0,
  collectedCountAllTime: 0,
  tippedAmountCountAllTime: 0,
  dislikeCountAllTime: 0,
  viewCountAllTime: 0,
};

export function mergeOwnExcludedIntoFirstPage<P extends { id: number }, O extends OwnContentDoc>(
  primary: P[],
  ownExcluded: O[],
  scope: MergeOwnContentScope
): P[] {
  if (!ownExcluded.length) return primary.slice(0, scope.limit);

  const primaryIds = new Set(primary.map((d) => d.id));
  let candidates = ownExcluded.filter((d) => !primaryIds.has(d.id));

  if (scope.modelVersionId != null) {
    const mv = scope.modelVersionId;
    candidates = candidates.filter((d) => {
      const auto =
        !scope.hideAutoResources && Array.isArray(d.modelVersionIds)
          ? d.modelVersionIds.includes(mv)
          : false;
      const manual =
        !scope.hideManualResources && Array.isArray(d.modelVersionIdsManual)
          ? d.modelVersionIdsManual.includes(mv)
          : false;
      const posted = d.postedToId === mv;
      return posted || auto || manual;
    });
  }
  const effectivePostIds =
    scope.postId != null
      ? [...(scope.postIds ?? []), scope.postId]
      : scope.postIds && scope.postIds.length
      ? scope.postIds
      : null;
  if (effectivePostIds) {
    const postIdSet = new Set(effectivePostIds);
    candidates = candidates.filter((d) => d.postId != null && postIdSet.has(d.postId));
  }
  if (scope.types?.length) {
    const typeSet = new Set(scope.types);
    candidates = candidates.filter((d) => (d.type ? typeSet.has(d.type) : false));
  }
  if (scope.baseModels?.length) {
    const bmSet = new Set(scope.baseModels);
    candidates = candidates.filter((d) => (d.baseModel ? bmSet.has(d.baseModel) : false));
  }
  if (scope.excludedTagIds?.length) {
    const exclSet = new Set(scope.excludedTagIds);
    candidates = candidates.filter((d) => {
      const tagIds = d.tagIds;
      if (!tagIds?.length) return true;
      return !tagIds.some((t) => exclSet.has(t));
    });
  }
  if (scope.excludedUserIds?.length) {
    const exclUserSet = new Set(scope.excludedUserIds);
    candidates = candidates.filter((d) => !exclUserSet.has(d.userId));
  }
  if (scope.remixOfId != null) {
    candidates = candidates.filter((d) => d.remixOfId === scope.remixOfId);
  }
  if (scope.remixesOnly && !scope.nonRemixesOnly) {
    candidates = candidates.filter((d) => d.remixOfId != null && d.remixOfId >= 0);
  }
  if (scope.nonRemixesOnly) {
    candidates = candidates.filter((d) => d.remixOfId == null);
  }
  if (scope.withMeta) candidates = candidates.filter((d) => d.hasMeta === true);
  if (scope.fromPlatform) candidates = candidates.filter((d) => d.onSite === true);

  if (!candidates.length) return primary.slice(0, scope.limit);

  // Synthesize the same shape as primary items (no metrics for own content — the
  // user's own private items aren't expected to have stats; default to zero).
  const synthesized = candidates.map((d) => ({ ...d, stats: { ...ZERO_STATS } } as unknown as P));

  const merged = [...primary, ...synthesized];
  switch (scope.sort) {
    case ImageSort.MostReactions:
      merged.sort(
        (a, b) =>
          ((b as unknown as OwnContentDoc).reactionCount ?? 0) -
            ((a as unknown as OwnContentDoc).reactionCount ?? 0) ||
          ((b as unknown as OwnContentDoc).sortAtUnix ?? 0) -
            ((a as unknown as OwnContentDoc).sortAtUnix ?? 0)
      );
      break;
    case ImageSort.MostComments:
      merged.sort(
        (a, b) =>
          ((b as unknown as OwnContentDoc).commentCount ?? 0) -
            ((a as unknown as OwnContentDoc).commentCount ?? 0) ||
          ((b as unknown as OwnContentDoc).sortAtUnix ?? 0) -
            ((a as unknown as OwnContentDoc).sortAtUnix ?? 0)
      );
      break;
    case ImageSort.MostCollected:
      merged.sort(
        (a, b) =>
          ((b as unknown as OwnContentDoc).collectedCount ?? 0) -
            ((a as unknown as OwnContentDoc).collectedCount ?? 0) ||
          ((b as unknown as OwnContentDoc).sortAtUnix ?? 0) -
            ((a as unknown as OwnContentDoc).sortAtUnix ?? 0)
      );
      break;
    case ImageSort.Oldest:
      merged.sort(
        (a, b) =>
          ((a as unknown as OwnContentDoc).sortAtUnix ?? 0) -
          ((b as unknown as OwnContentDoc).sortAtUnix ?? 0)
      );
      break;
    default:
      // Newest (default) — matches the Meili sort 'sortAt:desc'
      merged.sort(
        (a, b) =>
          ((b as unknown as OwnContentDoc).sortAtUnix ?? 0) -
          ((a as unknown as OwnContentDoc).sortAtUnix ?? 0)
      );
      break;
  }
  return merged.slice(0, scope.limit);
}
