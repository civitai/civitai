import { CacheTTL, constants } from '~/server/common/constants';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { cacheHitCounter, cacheMissCounter } from '~/server/prom/client';
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
//
// 🔴 SCOPE: this constant is for the membership-validity cache ONLY. The
// metric-privacy-defaults cache further down has its own `METRIC_PRIVACY_DEFAULTS_TTL`
// and the two are deliberately DIFFERENT — do not re-merge them into one shared value.
// Why they differ: a membership can go invalid on its OWN, with no write anywhere in
// this app (a subscription simply lapses at its period end), so nothing can bust the
// key at the moment its value stops being true — only a short TTL bounds that. The
// privacy defaults, by contrast, only ever change via an explicit `settings` write,
// which busts the key; its TTL is a backstop for a failed bust, not for silent decay.
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

/**
 * TTL for the metric-privacy-defaults cache. DELIBERATELY NOT `MEMBERSHIP_CACHE_TTL` —
 * see the scope note on that constant for why the two must stay separate.
 *
 * Derived from an audit of every writer of the `User.settings` JSONB column, since that
 * is the only thing this cache derives from. The three `hideModel*` booleans are
 * written by exactly ONE path — `setUserSetting`, reached from the account
 * Creator-Controls toggles — and that path busts this key in the same call. The two
 * writers that touch `settings` WITHOUT going through `setUserSetting` provably cannot
 * move these flags: `setDismissedAlerts` uses a `jsonb_set` scoped to the
 * `{dismissedAlerts}` path, and `updateCreatorShopSettings` read-merge-writes the blob
 * from a fresh in-transaction row read, overriding only `creatorShop`.
 *
 * So the TTL is NOT bounding a bypassing writer. What it bounds is two ways a CORRECT
 * write can still leave a wrong value cached, and in both the TTL is the only thing
 * that ever restores correctness:
 *
 *   1. A FAILED BUST. `bustUserMetricPrivacyDefaultsCache` is best-effort and swallows
 *      its own error so a cache problem can never fail the user's mutation — so a
 *      dropped delete leaves the pre-write triple in place with nothing to retry it.
 *   2. A REPLICA-LAG REFILL. The write goes to the primary and the key is deleted, but
 *      the refill below reads `dbRead` (a replica). A refill that lands inside the
 *      replication window re-caches the OLD triple, and this is not a rare interleaving
 *      — it is exactly what happens when a user toggles the setting and immediately
 *      reloads to check it took.
 *
 * Because these flags are a user-facing privacy control, that worst case has to stay
 * short enough to be a blip rather than a support ticket, which rules out a multi-hour
 * value however clean the writer audit is.
 *
 * An hour is the balance. Going 10min -> 1h removes 5/6 of the periodic re-fetches; the
 * next step up to a day would remove only a further ~4% of the original churn, so nearly
 * all of the available win is already banked at an hour, at 1/24th the worst-case
 * staleness. Memory does not enter into it — the cached working set is a rounding error
 * against the total keyspace, and each entry is three booleans.
 *
 * If the bust is ever made durable (retry / outbox), this can go up. Until then, do not
 * raise it without re-running the `User.settings` writer audit above.
 */
const METRIC_PRIVACY_DEFAULTS_TTL = CacheTTL.hour;

/**
 * Cache-observability labels for the shared `civitai_app_cache_{hit,miss}_total`
 * counters. Counted PER USER ID (not per call) so the ratio is a true per-entry hit
 * rate over a batched lookup, matching how `createCachedArray` reports.
 *
 * NOTE FOR WHOEVER BUILDS THE DASHBOARD/ALERT: these are LABELLED counters, so a label
 * child does not exist in the registry until its first `.inc()` — at which point it is
 * already 1. A `rate()`/`increase()` can therefore never observe the 0->1 step. That is
 * harmless here because both children materialize on the first request a process
 * serves, but it does mean a freshly-started process reports nothing for this cache
 * until it has served one, and a query must not treat that gap as a real zero.
 */
const METRIC_PRIVACY_CACHE_NAME = 'user-metric-privacy-defaults';
const METRIC_PRIVACY_CACHE_TYPE = 'redisPacked';

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

  // Per-id hit/miss so the hit rate is observable. A Redis read error lands entirely in
  // `misses` (every id was reset to null above), which is the honest accounting — those
  // ids do go to the DB.
  const hits = unique.length - misses.length;
  if (hits > 0)
    cacheHitCounter.inc(
      { cache_name: METRIC_PRIVACY_CACHE_NAME, cache_type: METRIC_PRIVACY_CACHE_TYPE },
      hits
    );
  if (misses.length > 0)
    cacheMissCounter.inc(
      { cache_name: METRIC_PRIVACY_CACHE_NAME, cache_type: METRIC_PRIVACY_CACHE_TYPE },
      misses.length
    );

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
          EX: METRIC_PRIVACY_DEFAULTS_TTL,
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
 * `setUserSetting`, which is the ONLY path that writes the `hideModel*` flags, so a
 * change to a user's defaults takes effect on the next read.
 *
 * 🔴 This is best-effort by design — it swallows Redis errors so a cache problem can
 * never fail the user's settings mutation. That makes it a non-guaranteed invalidation,
 * and `METRIC_PRIVACY_DEFAULTS_TTL` the only bound on how long a swallowed delete can
 * leave a user's privacy choice un-applied. Read the derivation on that constant before
 * changing either side.
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
