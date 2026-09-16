import { redis, REDIS_KEYS } from '~/server/redis/client';

/**
 * Per-token fixed-window rate limit for the App Blocks catalog endpoints
 * (`/api/v1/blocks/models`, `/api/v1/blocks/images`).
 *
 * WHY: both catalog endpoints accept ANY valid block token and force
 * `Cache-Control: private, no-store` (so Cloudflare can't absorb the load — see
 * each endpoint's doc + withBlockScope). A security audit flagged (MEDIUM,
 * optional): with no per-token ceiling, a single block could shift catalog cost
 * onto the origin by hammering these routes. This bounds that without touching
 * the maturity-clamp authority surface.
 *
 * PATTERN: this reuses the established blocks fixed-window limiter — the SAME
 * INCR + EXPIRE + fail-open shape as `BlockTokenService.checkRateLimit` (the
 * per-token mint limiter) and the moderator-endpoint MULTI limiter. It runs on the
 * `redis` cache client (like the mint limiter), NOT the createLimiter / sysRedis
 * DB-count limiter (that one is a sliding count of a fetched DB value — wrong
 * tool for a fast burst ceiling).
 *
 * KEY: keyed on `claims.blockInstanceId` (the stable per-instance identity that
 * the same in-block iframe reuses across a paginating session) under a distinct
 * `:catalog:` sub-namespace, so this bucket NEVER contends with the mint-token
 * bucket (`TOKEN_RATE_LIMIT:<subject>:<blockInstanceId>`). We key on the
 * instance — not `jti` — because `jti` rotates on every re-mint (the host
 * re-mints a fresh token periodically), which would reset the window and let an
 * abuser churn tokens for a fresh bucket; `blockInstanceId` is stable per
 * install and is exactly what we want to throttle.
 *
 * FAIL-OPEN: any redis error/timeout returns `allowed:true` — the catalog must
 * never break because the limiter's redis is down. Mirrors
 * `BlockTokenService.checkRateLimit`.
 */

// CEILING: generous for a real in-block browser, bounded for abuse. A model/
// image selector paginates ~100 items/page; a user scrolling fast (or a
// debounced search firing as they type) issues at most a handful of fetches per
// second — well under this. The ceiling only bites a token issuing a sustained
// burst (>~12 req/s averaged over the window — 120 requests / 10s, so the 121st
// request in any 10s window trips it), which is not legitimate selector usage.
// Window is short so a tripped instance recovers within seconds.
export const BLOCK_CATALOG_RATE_LIMIT_MAX = 120;
export const BLOCK_CATALOG_RATE_LIMIT_WINDOW_SECONDS = 10;

// PUBLISH bucket (blocks.publishGenerationOutputs). A publish is FAR heavier than
// a catalog read — each image is a fetch + S3 upload + scan cycle — so it gets its
// OWN window/ceiling keyed by IMAGES (weight = image count), NOT one token per
// call. 60 published images / 5-minute window is generous for a real benchmark
// grid (which publishes a handful of results once) but hard-caps a token that
// tries to drive a sustained fetch/upload/scan fan-out onto the origin.
export const BLOCK_PUBLISH_RATE_LIMIT_MAX = 60;
export const BLOCK_PUBLISH_RATE_LIMIT_WINDOW_SECONDS = 300;

// POST bucket (blocks.createPostFromApp). A DEDICATED bucket, not a share of the
// publish one, because the two limit different things and the wrong unit gives
// the wrong answer in both directions:
//
//   - PUBLISH is weighted by IMAGES and bounds ORIGIN COST (fetch + S3 upload +
//     scan per image). 60 images / 5 min is generous there.
//   - POST is weighted by POSTS and bounds PUBLIC-FEED IMPACT + REWARD EXPOSURE.
//     A single post is cheap to serve and expensive to un-do: it carries the
//     viewer's byline into the feed, and (with `modelVersionId`) pays a model
//     owner. Charging posts against the image bucket would let one 3-image post
//     and one 60-image publish trade against each other, which is incoherent.
//
// 3 posts / hour / block instance. A real app posts a finished result once; three
// gives room for a mistake and a retry without opening a spam faucet. The window
// is long ON PURPOSE — unlike the catalog bucket (where a short window means a
// tripped instance recovers in seconds, which is what you want for a read), a
// short window here would let a block post continuously at the ceiling.
//
// ⚠️ STATED LIMITS, so nobody reads this as more than it is: the bucket is keyed
// on `blockInstanceId` (the same choice, for the same `jti`-churn reason, as the
// other two), it is a FIXED window so a 2× burst across a boundary is reachable
// by construction, and it FAILS OPEN on a Redis error. It is a cost ceiling, not
// a security control. The controls that actually bound abuse are the self-dealing
// guard, the per-source ownership proofs, and the per-post consent confirm.
export const BLOCK_POST_RATE_LIMIT_MAX = 3;
export const BLOCK_POST_RATE_LIMIT_WINDOW_SECONDS = 3600;

// APP-AGGREGATE post bucket, keyed on `claims.appId`. The per-instance bucket
// above bounds ONE INSTALL, so an app with N installs can post N × 3 per hour and
// no ceiling anywhere sees the total. This is the aggregate the per-instance
// bucket cannot express.
//
// 🔴 HOW THE NUMBER WAS CHOSEN, STATED PLAINLY BECAUSE IT IS NOT DATA-DERIVED.
// It is 100 × the per-instance ceiling: an app has to have 100 DISTINCT installs
// each posting at their own hourly maximum, in the same hour, before this engages
// at all. That is the whole rationale — there is no measurement behind it, and
// the per-instance 3/hour it multiplies is itself an acknowledged guess. It is a
// STARTING VALUE to be revised from the `block_scope_invocations` audit rows once
// a real app has run on this path; the rows record every post outcome per app, so
// the observed per-app hourly distribution is exactly what should replace it.
//
// DELIBERATELY GENEROUS, because the two failure directions are not symmetric. A
// too-tight aggregate throttles a popular, legitimate app and reaches its users
// as "posting is broken" — a quiet, diffuse failure that nobody attributes to a
// rate limit — while a too-loose one leaves a bounded amount of content that the
// self-dealing guard, the per-source ownership proofs and the per-post consent
// confirm have each already refused to admit on their own terms. Err loose.
//
// ⚠️ SAME STATED LIMITS AS THE BUCKET ABOVE: fixed window (a 2× burst across a
// boundary is reachable by construction) and FAILS OPEN on a Redis error. It is a
// cost ceiling, not a security control.
export const BLOCK_POST_APP_RATE_LIMIT_MAX = 300;
export const BLOCK_POST_APP_RATE_LIMIT_WINDOW_SECONDS = 3600;

export type BlockCatalogRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Records one catalog request against `blockInstanceId`'s window and reports
 * whether it is within the per-token ceiling.
 *
 * @param blockInstanceId stable per-instance identity from `req.blockClaims`.
 * @returns `{ allowed: true }` under the limit (or on any redis error —
 *   fail-open); `{ allowed: false, retryAfterSeconds }` once the window's count
 *   exceeds the ceiling.
 */
export async function checkBlockCatalogRateLimit(
  blockInstanceId: string
): Promise<BlockCatalogRateLimitResult> {
  const key = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:catalog:${blockInstanceId}` as const;
  try {
    // INCR returns 1 on the first hit of a fresh window; set the TTL then so the
    // key is always bounded. The atomic concern (a crash between INCR and EXPIRE
    // stranding a TTL-less key → permanent lock) is mitigated the same way the
    // mint limiter does it: re-assert the TTL when it's been lost.
    const count = await redis.incrBy(key as never, 1);
    if (count === 1) {
      await redis.expire(key as never, BLOCK_CATALOG_RATE_LIMIT_WINDOW_SECONDS);
    } else {
      const ttl = await redis.ttl(key as never);
      if (ttl < 0) await redis.expire(key as never, BLOCK_CATALOG_RATE_LIMIT_WINDOW_SECONDS);
    }

    if (count <= BLOCK_CATALOG_RATE_LIMIT_MAX) return { allowed: true };

    // Over the ceiling — surface the remaining window as Retry-After. If the TTL
    // read fails or is unset (-1/-2), fall back to the full window so the client
    // backs off sanely rather than retrying immediately.
    let retryAfter = await redis.ttl(key as never);
    if (!Number.isFinite(retryAfter) || retryAfter < 1) {
      retryAfter = BLOCK_CATALOG_RATE_LIMIT_WINDOW_SECONDS;
    }
    return { allowed: false, retryAfterSeconds: retryAfter };
  } catch {
    // Fail open — never block legitimate catalog traffic on a redis incident.
    return { allowed: true };
  }
}

/**
 * Records a PUBLISH of `weight` images against `blockInstanceId`'s publish window
 * and reports whether it is within the per-token ceiling. Distinct `:publish:`
 * sub-namespace so it NEVER contends with the catalog-read or mint buckets. The
 * cost is WEIGHTED by image count (a 20-image publish spends 20 tokens), because
 * the expense is per-image (fetch + S3 upload + scan), not per-call. Same
 * fail-open posture as the catalog limiter.
 *
 * @param blockInstanceId stable per-instance identity from the verified token.
 * @param imageCount number of images this publish will materialise (weight ≥ 1).
 */
export async function checkBlockPublishRateLimit(
  blockInstanceId: string,
  imageCount: number
): Promise<BlockCatalogRateLimitResult> {
  const key = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:publish:${blockInstanceId}` as const;
  const weight = Math.max(1, Math.floor(imageCount));
  try {
    // INCRBY by the image weight; a fresh window's first publish returns exactly
    // `weight` (the key was absent) — that's when we arm the TTL.
    const count = await redis.incrBy(key as never, weight);
    if (count === weight) {
      await redis.expire(key as never, BLOCK_PUBLISH_RATE_LIMIT_WINDOW_SECONDS);
    } else {
      const ttl = await redis.ttl(key as never);
      if (ttl < 0) await redis.expire(key as never, BLOCK_PUBLISH_RATE_LIMIT_WINDOW_SECONDS);
    }

    if (count <= BLOCK_PUBLISH_RATE_LIMIT_MAX) return { allowed: true };

    let retryAfter = await redis.ttl(key as never);
    if (!Number.isFinite(retryAfter) || retryAfter < 1) {
      retryAfter = BLOCK_PUBLISH_RATE_LIMIT_WINDOW_SECONDS;
    }
    return { allowed: false, retryAfterSeconds: retryAfter };
  } catch {
    // Fail open — never block a legitimate publish on a redis incident.
    return { allowed: true };
  }
}

/**
 * Records ONE post against `blockInstanceId`'s post window and reports whether it
 * is within the per-instance ceiling. Distinct `:post:` sub-namespace so it can
 * NEVER contend with the catalog-read, publish or mint buckets.
 *
 * Weight is always 1 — a post is the unit, regardless of how many images it
 * carries. The per-image origin cost of adopting/persisting those images is
 * charged SEPARATELY against the publish bucket by the caller, so a block cannot
 * use the post path to bypass the image ceiling.
 *
 * Same fail-open posture as the sibling limiters: a Redis incident must not break
 * a legitimate post. See the ceiling constants above for what this bucket is and
 * is not.
 */
export async function checkBlockPostRateLimit(
  blockInstanceId: string
): Promise<BlockCatalogRateLimitResult> {
  const key = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:post:${blockInstanceId}` as const;
  try {
    const count = await redis.incrBy(key as never, 1);
    if (count === 1) {
      await redis.expire(key as never, BLOCK_POST_RATE_LIMIT_WINDOW_SECONDS);
    } else {
      const ttl = await redis.ttl(key as never);
      if (ttl < 0) await redis.expire(key as never, BLOCK_POST_RATE_LIMIT_WINDOW_SECONDS);
    }

    if (count <= BLOCK_POST_RATE_LIMIT_MAX) return { allowed: true };

    let retryAfter = await redis.ttl(key as never);
    if (!Number.isFinite(retryAfter) || retryAfter < 1) {
      retryAfter = BLOCK_POST_RATE_LIMIT_WINDOW_SECONDS;
    }
    return { allowed: false, retryAfterSeconds: retryAfter };
  } catch {
    // Fail open — never block a legitimate post on a redis incident.
    return { allowed: true };
  }
}

/**
 * Records ONE post against `appId`'s AGGREGATE post window — the ceiling the
 * per-instance bucket structurally cannot express, because it is keyed on the
 * install and an app has many of those.
 *
 * Distinct `:post-app:` sub-namespace so it can never contend with the
 * per-instance `:post:` bucket, the publish, catalog or mint buckets. Weight is
 * always 1, the same unit as the per-instance bucket, so the two numbers are
 * directly comparable.
 *
 * 🔴 ADDITIVE, NOT A REPLACEMENT. The caller checks BOTH; either refusing refuses
 * the post. Neither subsumes the other: the per-instance bucket stops one install
 * spamming, this one stops an app aggregating that allowance across installs.
 *
 * Same fail-open posture as every sibling limiter — a Redis incident must not
 * break a legitimate post. See `BLOCK_POST_APP_RATE_LIMIT_MAX` for how the
 * ceiling was chosen and why it is not derived from data.
 */
export async function checkBlockPostAppRateLimit(
  appId: string
): Promise<BlockCatalogRateLimitResult> {
  const key = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:post-app:${appId}` as const;
  try {
    const count = await redis.incrBy(key as never, 1);
    if (count === 1) {
      await redis.expire(key as never, BLOCK_POST_APP_RATE_LIMIT_WINDOW_SECONDS);
    } else {
      const ttl = await redis.ttl(key as never);
      if (ttl < 0) await redis.expire(key as never, BLOCK_POST_APP_RATE_LIMIT_WINDOW_SECONDS);
    }

    if (count <= BLOCK_POST_APP_RATE_LIMIT_MAX) return { allowed: true };

    let retryAfter = await redis.ttl(key as never);
    if (!Number.isFinite(retryAfter) || retryAfter < 1) {
      retryAfter = BLOCK_POST_APP_RATE_LIMIT_WINDOW_SECONDS;
    }
    return { allowed: false, retryAfterSeconds: retryAfter };
  } catch {
    // Fail open — never block a legitimate post on a redis incident.
    return { allowed: true };
  }
}
