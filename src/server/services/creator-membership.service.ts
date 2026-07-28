import { CacheTTL, constants } from '~/server/common/constants';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { subscriptionProductMetadataSchema } from '~/server/schema/subscriptions.schema';

/**
 * Batched `hasValidCreatorMembership` for read-time gating across a list of owners
 * (metric-privacy on the model feed / v1 API / search index, and the donation-goal
 * hide). ONE `dbRead` query for all owners — never K per-owner checkouts on the
 * primary pool. Mirrors getHighestTierSubscription + hasValidCreatorMembership: pick
 * each user's highest tier (constants.memberships.tierOrder) and treat
 * non-free / non-founder as valid.
 *
 * Read-through Redis cache (Bucket A: cost/CPU reduction, no behaviour change): the
 * per-user validity boolean is near-static, so we cache `id -> boolean` and only run
 * the DB query + the per-subscription Zod parse for the cache MISSES. This removes the
 * per-request `customerSubscription.findMany` + `subscriptionProductMetadataSchema.parse`
 * from the hot model-read paths (the measured api-primary CPU / event-loop cost of
 * #3266's read-time resolution). Fail-open: any Redis error degrades to the uncached
 * DB path so a Redis stall never 500s a read. Both TRUE and FALSE are cached (the
 * resolver is a total function over the id — every input gets a definite boolean).
 *
 * Kept in this dependency-light module (dbRead + env + constants + the zod schema +
 * the redis client, no clickhouse/buzz/notification graph) so the donation-goals
 * lookup can gate on it without dragging the heavy creator-program graph into that
 * light, unit-tested path.
 */

// TTL is a staleness BACKSTOP, not the primary invalidation. All app-driven
// subscription changes (stripe/paddle webhooks, code redemption, cancel/reinstate,
// mod tooling) bust the affected user's key immediately via `invalidateSubscriptionCaches`.
// The TTL only bounds the non-webhook writers (referral grants, renewal/prepaid crons,
// direct-DB edits) that don't route through that fan-out. Kept short (10 min) so any
// missed path — including the one leak-direction gap, a referral-granted member who
// also sets a metric-hide flag — self-heals quickly while still absorbing effectively
// all hot-path read repetition (a creator's models are read many times per 10 min).
const MEMBERSHIP_CACHE_TTL = CacheTTL.md;

const getMembershipValidCacheKey = (userId: number) =>
  `${REDIS_KEYS.CACHES.CREATOR_MEMBERSHIP_VALID}:${userId}` as `${typeof REDIS_KEYS.CACHES.CREATOR_MEMBERSHIP_VALID}:${string}`;

/**
 * The origin computation: ONE `dbRead.customerSubscription.findMany` over `userIds`,
 * with a Zod parse per subscription, reducing to each user's highest tier. Returns a
 * TOTAL map — every input id gets a definite boolean (users with no qualifying
 * subscription resolve to `false`). This is exactly the pre-cache body, extracted so
 * the read-through wrapper can call it for the miss set only.
 */
async function queryValidCreatorMembership(userIds: number[]): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>();
  if (userIds.length === 0) return result;

  const subscriptions = await dbRead.customerSubscription.findMany({
    where: {
      userId: { in: userIds },
      status: { notIn: ['canceled', 'incomplete_expired', 'past_due', 'unpaid'] },
    },
    select: {
      userId: true,
      metadata: true,
      product: { select: { metadata: true } },
    },
  });

  const tierOrder = constants.memberships.tierOrder as readonly string[];
  const highestTierByUser = new Map<number, string>();
  for (const sub of subscriptions) {
    const subMeta = (sub.metadata ?? {}) as { renewalEmailSent?: boolean };
    if (subMeta.renewalEmailSent) continue;
    const productMeta = subscriptionProductMetadataSchema.parse(sub.product.metadata);
    const tier = (productMeta?.[env.TIER_METADATA_KEY] ?? 'free') as string;
    const prev = highestTierByUser.get(sub.userId);
    if (prev === undefined || tierOrder.indexOf(tier) > tierOrder.indexOf(prev))
      highestTierByUser.set(sub.userId, tier);
  }

  for (const id of userIds) {
    const tier = highestTierByUser.get(id);
    result.set(id, !!tier && tier !== 'free' && tier !== 'founder');
  }
  return result;
}

export async function getValidCreatorMembershipMap(userIds: number[]) {
  const unique = [...new Set(userIds.filter((id) => !!id))];
  const result = new Map<number, boolean>();
  if (unique.length === 0) return result;

  // 1. Read-through: batch-fetch the cached booleans. On any Redis error, treat every
  //    id as a miss and fall through to the DB (fail-open — a Redis stall must not 500
  //    a hot read).
  let cached: (boolean | null)[];
  try {
    cached = await redis.packed.mGet<boolean>(unique.map(getMembershipValidCacheKey));
  } catch {
    cached = unique.map(() => null);
  }

  const misses: number[] = [];
  unique.forEach((id, i) => {
    const hit = cached[i];
    // A stored `false` round-trips as `false` (a non-empty packed buffer), distinct
    // from a `null` cache miss — so negatives are served from cache, not re-queried.
    if (typeof hit === 'boolean') result.set(id, hit);
    else misses.push(id);
  });

  if (misses.length === 0) return result;

  // 2. DB-query + Zod-parse ONLY the misses.
  const fresh = await queryValidCreatorMembership(misses);

  // 3. Backfill each miss (best-effort; a Redis write stall never fails the request).
  //    `mSet` is disabled on the packed client, so set per key — misses are rare after
  //    warmup and small, and the sets run concurrently.
  await Promise.all(
    misses.map(async (id) => {
      const value = fresh.get(id) ?? false;
      result.set(id, value);
      try {
        await redis.packed.set(getMembershipValidCacheKey(id), value, {
          EX: MEMBERSHIP_CACHE_TTL,
        });
      } catch {
        // Best-effort cache write; the TTL bounds any residual staleness.
      }
    })
  );

  return result;
}

/**
 * Single-user, cache-backed membership check for the read-time metric-privacy gate.
 * Byte-identical (same validity boolean) to `hasValidCreatorMembership`, but served
 * through the shared read-through cache above. Use ONLY on read-time display/gating
 * paths (getModel, v1 version response, OG card) — NOT on the shop/creator-program
 * action gates, which must read live subscription state.
 */
export async function hasValidCreatorMembershipCached(userId: number): Promise<boolean> {
  if (!userId) return false;
  const map = await getValidCreatorMembershipMap([userId]);
  return map.get(userId) ?? false;
}

/**
 * The three model-metric-privacy DEFAULT flags a user sets on their `User.settings`
 * JSON. This is the ONLY slice of `settings` the read-time resolvers
 * (`getUserMetricPrivacyDefaults` -> `resolveModel/VersionHiddenMetrics`) read, so it
 * is byte-identical to feed them this tiny object instead of the full settings blob.
 */
export type UserMetricPrivacyDefaults = {
  hideModelBuzz?: boolean;
  hideModelDownloads?: boolean;
  hideModelGenerations?: boolean;
};

const getUserMetricPrivacyDefaultsCacheKey = (userId: number) =>
  `${REDIS_KEYS.CACHES.USER_METRIC_PRIVACY_DEFAULTS}:${userId}` as `${typeof REDIS_KEYS.CACHES.USER_METRIC_PRIVACY_DEFAULTS}:${string}`;

/**
 * Origin computation: ONE `dbRead.user.findMany` over `userIds`, reducing each user's
 * `settings` to the three `hideModel*` booleans. Returns a TOTAL map — every input id
 * gets a definite triple (a user with no settings / no flags resolves to all-false).
 */
async function queryUserMetricPrivacyDefaults(
  userIds: number[]
): Promise<Map<number, UserMetricPrivacyDefaults>> {
  const result = new Map<number, UserMetricPrivacyDefaults>();
  if (userIds.length === 0) return result;

  const rows = await dbRead.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, settings: true },
  });
  const settingsById = new Map<number, unknown>(rows.map((r) => [r.id, r.settings]));

  for (const id of userIds) {
    const s = (settingsById.get(id) ?? {}) as UserMetricPrivacyDefaults;
    result.set(id, {
      hideModelBuzz: !!s.hideModelBuzz,
      hideModelDownloads: !!s.hideModelDownloads,
      hideModelGenerations: !!s.hideModelGenerations,
    });
  }
  return result;
}

/**
 * Batched, cache-backed read of the per-user model-metric-privacy DEFAULT flags for the
 * read-time gate (feed / v1 list / associated-models). Replaces the per-request
 * `dbRead.user.findMany({ select: { settings } })` those paths used to run over EVERY
 * owner — which fetched + synchronously deserialized the full (large, accumulating)
 * `settings` JSON blob per owner just to read three booleans (the measured api-primary
 * longtask). Read-through Redis cache of the tiny derived triple; DB-query only the
 * misses; fail-open to the uncached DB path on any Redis error (a Redis stall must not
 * 500 a hot read). Byte-identical to reading the flags straight off `settings`.
 */
export async function getUserMetricPrivacyDefaultsMap(userIds: number[]) {
  const unique = [...new Set(userIds.filter((id) => !!id))];
  const result = new Map<number, UserMetricPrivacyDefaults>();
  if (unique.length === 0) return result;

  let cached: (UserMetricPrivacyDefaults | null)[];
  try {
    cached = await redis.packed.mGet<UserMetricPrivacyDefaults>(
      unique.map(getUserMetricPrivacyDefaultsCacheKey)
    );
  } catch {
    cached = unique.map(() => null);
  }

  const misses: number[] = [];
  unique.forEach((id, i) => {
    const hit = cached[i];
    // A stored triple round-trips as a (non-null) object; a cache miss is `null`.
    if (hit && typeof hit === 'object') result.set(id, hit);
    else misses.push(id);
  });

  if (misses.length === 0) return result;

  const fresh = await queryUserMetricPrivacyDefaults(misses);

  await Promise.all(
    misses.map(async (id) => {
      const value = fresh.get(id) ?? {
        hideModelBuzz: false,
        hideModelDownloads: false,
        hideModelGenerations: false,
      };
      result.set(id, value);
      try {
        await redis.packed.set(getUserMetricPrivacyDefaultsCacheKey(id), value, {
          EX: MEMBERSHIP_CACHE_TTL,
        });
      } catch {
        // Best-effort cache write; the TTL bounds any residual staleness.
      }
    })
  );

  return result;
}

/**
 * Bust the cached metric-privacy defaults for one or more users. Wired into
 * `setUserSetting` so any change to a user's `hideModel*` defaults takes effect on the
 * next read; the TTL backstops any writer that bypasses `setUserSetting`.
 */
export async function bustUserMetricPrivacyDefaultsCache(userId: number | number[]) {
  const ids = (Array.isArray(userId) ? userId : [userId]).filter((id) => !!id);
  if (ids.length === 0) return;
  try {
    await Promise.all(ids.map((id) => redis.del(getUserMetricPrivacyDefaultsCacheKey(id))));
  } catch {
    // Best-effort bust; the TTL bounds any residual staleness.
  }
}

/**
 * Bust the cached membership validity for one or more users. Hard delete (not a
 * staleness reset): the next read re-queries and re-populates the fresh boolean.
 * Wired into `invalidateSubscriptionCaches`, so every app-driven subscription change
 * (stripe/paddle webhook, code redemption, cancel/reinstate, mod tooling) busts
 * immediately. Best-effort — a Redis error never fails the mutation path.
 */
export async function bustCreatorMembershipValidCache(userId: number | number[]) {
  const ids = (Array.isArray(userId) ? userId : [userId]).filter((id) => !!id);
  if (ids.length === 0) return;
  try {
    await Promise.all(ids.map((id) => redis.del(getMembershipValidCacheKey(id))));
  } catch {
    // Best-effort bust; the TTL bounds any residual staleness.
  }
}
