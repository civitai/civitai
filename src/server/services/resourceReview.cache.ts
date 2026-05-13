// Cache-key + bust helpers for the getRatingTotals query in
// resourceReview.service.ts. Extracted to a standalone module so callers in
// other services (e.g. user.service.ts's toggleReview path) can import the
// bust helpers without forming an import cycle.

import { bustCacheTag } from '~/server/utils/cache-helpers';

// Busts the getRatingTotals cache for a single review. The cache key is keyed
// by either modelVersionId or modelId depending on which the caller passed, so
// we bust both tags whenever a review row changes — counts under either tag
// could shift. Fire-and-forget; bust failures should not surface to the caller.
export const bustRatingTotalsCache = async ({
  modelId,
  modelVersionId,
}: {
  modelId?: number | null;
  modelVersionId?: number | null;
}) => {
  const tags: string[] = [];
  if (modelVersionId) tags.push(`rating:modelVersion:${modelVersionId}`);
  if (modelId) tags.push(`rating:model:${modelId}`);
  if (tags.length === 0) return;
  await bustCacheTag(tags);
};

// Deduped bulk bust for batch mutations. Collects all distinct model/version
// tags from a set of rows, then issues a single bustCacheTag call.
export const bustRatingTotalsForRows = async (
  rows: { modelId: number | null; modelVersionId: number | null }[]
) => {
  const tags = new Set<string>();
  for (const r of rows) {
    if (r.modelVersionId) tags.add(`rating:modelVersion:${r.modelVersionId}`);
    if (r.modelId) tags.add(`rating:model:${r.modelId}`);
  }
  if (tags.size === 0) return;
  await bustCacheTag([...tags]);
};
