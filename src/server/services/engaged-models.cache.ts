import { dbRead } from '~/server/db/client';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { redis, REDIS_KEYS, REDIS_SUB_KEYS } from '~/server/redis/client';
import type { ModelEngagementType } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';

/**
 * Tier B server cache for the per-user model-engagement set that backs
 * `user.getEngagedModels` (whole set) and `user.getEngagedModelsByIds` (bounded
 * intersection — 1-in-7 of all API requests, previously uncached).
 *
 * The cached value is the user's FULL engagement set keyed by engagement type
 * (+ `Recommended`, derived from recommended resource reviews). `getEngagedModelsByIds`
 * intersects it with the requested ids IN PROCESS — a per-user key (not per-(user,ids))
 * so the hit rate isn't destroyed by the combinatorial id-set space. The wire response
 * of both handlers is byte-for-byte what it was before the cache; this is a pure,
 * transparent server-side cache.
 *
 * CORRECTNESS is by explicit invalidation at every mutation that changes a user's model
 * engagement, NOT by the TTL — the 24h TTL is only a backstop. Call `bustEngagedModelsCache`
 * from every such mutation site (see references). The key + TTL match the pre-existing
 * `MODEL_ENGAGEMENTS` cache so this shares that cache's existing bust surface.
 */

export type EngagedModelType = ModelEngagementType | 'Recommended';

// 24h backstop. Real freshness comes from bustEngagedModelsCache() at the mutation sites.
export const ENGAGED_MODELS_CACHE_TTL = 60 * 60 * 24;

const engagedModelsKey = (userId: number): RedisKeyTemplateCache =>
  `${REDIS_KEYS.USER.BASE}:${userId}:${REDIS_SUB_KEYS.USER.MODEL_ENGAGEMENTS}`;

/**
 * Get the user's full engaged-models set, served from redis when warm and rebuilt from
 * the DB on a miss (then written back). Shape: `Record<EngagedModelType, number[]>` — one
 * array of modelIds per engagement type the user has, plus `Recommended`.
 */
export async function getEngagedModelsCached(
  userId: number
): Promise<Record<EngagedModelType, number[]>> {
  const key = engagedModelsKey(userId);
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached) as Record<EngagedModelType, number[]>;

  // Rebuild from the DB. These two queries mirror `getUserEngagedModels` +
  // `getResourceReviewsByUserId({ recommended: true })` — inlined here so this cache
  // module stays dependency-light (no service-layer import cycles).
  const [engagements, recommendedReviews] = await Promise.all([
    dbRead.modelEngagement.findMany({
      where: { userId },
      select: { modelId: true, type: true },
    }),
    dbRead.resourceReview.findMany({
      where: { userId, recommended: true },
      select: { modelId: true },
    }),
  ]);

  const engagedModels = engagements.reduce<Record<EngagedModelType, number[]>>((acc, model) => {
    const { type, modelId } = model;
    if (!acc[type]) acc[type] = [];
    acc[type].push(modelId);
    return acc;
  }, {} as Record<EngagedModelType, number[]>);
  engagedModels.Recommended = recommendedReviews.map((r) => r.modelId).filter(isDefined);

  await redis.set(key, JSON.stringify(engagedModels), { EX: ENGAGED_MODELS_CACHE_TTL });

  return engagedModels;
}

/**
 * Intersect the full engaged-models set with a bounded `modelIds` set, in process.
 *
 * Reproduces the exact shape the DB-direct `getUserEngagedModelsByIds` returned: a type
 * key is present ONLY when at least one requested id is engaged under it, and `Recommended`
 * is ALWAYS present (possibly empty). Array element order is irrelevant — the client folds
 * every array into membership sets.
 */
export function filterEngagedModelsByIds(
  all: Record<EngagedModelType, number[]>,
  modelIds: number[]
): Record<EngagedModelType, number[]> {
  const wanted = new Set(modelIds);
  const result = {} as Record<EngagedModelType, number[]>;

  for (const type of Object.keys(all) as EngagedModelType[]) {
    if (type === 'Recommended') continue; // always set last, even when empty
    const filtered = (all[type] ?? []).filter((modelId) => wanted.has(modelId));
    if (filtered.length) result[type] = filtered;
  }
  result.Recommended = (all.Recommended ?? []).filter((modelId) => wanted.has(modelId));

  return result;
}

/** Invalidate the user's engaged-models cache. Call from every engagement mutation. */
export async function bustEngagedModelsCache(userId: number): Promise<void> {
  await redis.del(engagedModelsKey(userId));
}
