import { redis, REDIS_KEYS } from '~/server/redis/client';

/**
 * Server-side fixed-window rate limits for App Blocks SHARED storage writes —
 * `apps.shared.append` / `.update` (append bucket), `.vote` / `.unvote` (vote
 * bucket), `.report`, and `.withdraw`. That is now EVERY write op on the shared
 * surface: `withdraw` was the last one without a bucket.
 *
 * WHY (hardened design H4 — "weaponized users"): shared storage opens the app
 * datastore to cross-user PUBLIC writes for the first time. A trusted-but-hostile
 * (or compromised) account could flood requests or brigade votes. These caps are
 * the second leg of the containment triad (trust-gate + rate-limit + mod-approval):
 * they bound the write volume a SINGLE user can push through a SINGLE app,
 * independent of the per-app quota (which bounds bytes, not per-user velocity).
 *
 * KEYING (design H4): keyed on `(user_id, appBlockId)` — NOT the block instance,
 * NOT the token `jti`. The token subject (`user_id`) is the abuse principal, and
 * `appBlockId` scopes the budget per app, so one user hammering app A does not eat
 * their budget for app B, and churning fresh tokens can't reset the window (the
 * subject is stable). Sub-namespaced under the shared blocks rate-limit key so
 * these buckets never contend with the mint (`TOKEN_RATE_LIMIT:<subject>:...`) or
 * catalog (`:catalog:`) buckets.
 *
 * PATTERN: the established blocks fixed-window limiter — INCR + EXPIRE on the
 * `redis` cache client, byte-identical shape to `checkBlockCatalogRateLimit` and
 * `BlockTokenService.checkRateLimit`. FAIL-OPEN on any redis error: a limiter-redis
 * incident must never break legitimate writes (the trust-gate + content-moderation
 * + mod-approval remain as the durable controls). We NEVER fail-closed here because
 * the abuse ceiling is a defence-in-depth layer, not the authorization boundary.
 */

// APPEND: N requests/day/app/user. A real community member files a handful of
// requests a day at most; 20 bounds a flood without touching normal use. Window
// is a rolling 24h fixed bucket (resets on first hit + TTL).
export const SHARED_APPEND_RATE_LIMIT_MAX = 20;
export const SHARED_APPEND_RATE_LIMIT_WINDOW_SECONDS = 24 * 60 * 60;

// VOTE: M votes/min/app/user. Covers a user rapidly up-voting a browsed list
// while bounding a scripted brigade. Symmetric bucket covers vote + unvote so a
// toggle-spam loop is also capped.
export const SHARED_VOTE_RATE_LIMIT_MAX = 30;
export const SHARED_VOTE_RATE_LIMIT_WINDOW_SECONDS = 60;

// REPORT: R reports/day/app/user. A report is a rare, moderator-facing action
// that files a row AND fires a mod-channel webhook — so unlike votes it is the
// abuse SURFACE (report-table growth + Discord flooding), not just noise. The
// per-(reporter, key) dedup collapses re-reports of the SAME row; this daily
// bucket bounds a flood of DISTINCT-key reports (the residual webhook-spam
// vector) from a single user. Matches the append daily-window shape.
export const SHARED_REPORT_RATE_LIMIT_MAX = 20;
export const SHARED_REPORT_RATE_LIMIT_WINDOW_SECONDS = 24 * 60 * 60;

// WITHDRAW: W withdrawals/min/app/user. `apps.shared.withdraw` was the ONE write
// op on this surface with NO bucket at all — every sibling (append, update, vote,
// unvote, report) has one. It is a DELETE of the caller's OWN shared_kv row, so it
// grows nothing; what each call does spend is a pooled connection, a real
// transaction, an FK cascade across votes/counters/reports and a quota trigger —
// i.e. the cost profile of `vote`, not of `append`.
//
// So it takes the VOTE shape (30/min) rather than the append/report daily shape,
// and deliberately its OWN sub-namespace rather than sharing the vote bucket:
//   - the DAILY shape is wrong here. With a per-user shared_kv row cap of 50, a
//     user legitimately clearing their own history can need dozens of withdrawals
//     in one sitting; a 20/day ceiling would strand rows they have every right to
//     delete — a worse failure than the flood it bounds.
//   - SHARING the vote bucket is wrong for the mirror-image reason: browsing and
//     up-voting a feed is the highest-velocity legitimate action on this surface,
//     and it must never be able to starve a user's ability to delete their own
//     content (nor a cleanup sweep starve their voting).
// 30/min bounds a scripted append/withdraw churn loop while sitting far above any
// human rate. Fail-open like every other bucket here — defence in depth, never the
// authorization boundary.
export const SHARED_WITHDRAW_RATE_LIMIT_MAX = 30;
export const SHARED_WITHDRAW_RATE_LIMIT_WINDOW_SECONDS = 60;

export type SharedStorageRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

async function checkFixedWindow(
  key: string,
  max: number,
  windowSeconds: number
): Promise<SharedStorageRateLimitResult> {
  try {
    const count = await redis.incrBy(key as never, 1);
    if (count === 1) {
      await redis.expire(key as never, windowSeconds);
    } else {
      // Re-assert a lost TTL (crash between INCR and EXPIRE would otherwise strand
      // a TTL-less key → permanent lock). Same mitigation as the mint limiter.
      const ttl = await redis.ttl(key as never);
      if (ttl < 0) await redis.expire(key as never, windowSeconds);
    }

    if (count <= max) return { allowed: true };

    let retryAfter = await redis.ttl(key as never);
    if (!Number.isFinite(retryAfter) || retryAfter < 1) retryAfter = windowSeconds;
    return { allowed: false, retryAfterSeconds: retryAfter };
  } catch {
    // Fail open — a redis incident must not break shared writes.
    return { allowed: true };
  }
}

/** One `append` against the (user, app) daily bucket. */
export async function checkSharedAppendRateLimit(
  userId: number,
  appBlockId: string
): Promise<SharedStorageRateLimitResult> {
  const key =
    `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:shared-append:${appBlockId}:${userId}` as const;
  return checkFixedWindow(
    key,
    SHARED_APPEND_RATE_LIMIT_MAX,
    SHARED_APPEND_RATE_LIMIT_WINDOW_SECONDS
  );
}

/** One `vote`/`unvote` against the (user, app) per-minute bucket. */
export async function checkSharedVoteRateLimit(
  userId: number,
  appBlockId: string
): Promise<SharedStorageRateLimitResult> {
  const key = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:shared-vote:${appBlockId}:${userId}` as const;
  return checkFixedWindow(key, SHARED_VOTE_RATE_LIMIT_MAX, SHARED_VOTE_RATE_LIMIT_WINDOW_SECONDS);
}

/** One `withdraw` against the (user, app) per-minute bucket (own sub-namespace). */
export async function checkSharedWithdrawRateLimit(
  userId: number,
  appBlockId: string
): Promise<SharedStorageRateLimitResult> {
  const key =
    `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:shared-withdraw:${appBlockId}:${userId}` as const;
  return checkFixedWindow(
    key,
    SHARED_WITHDRAW_RATE_LIMIT_MAX,
    SHARED_WITHDRAW_RATE_LIMIT_WINDOW_SECONDS
  );
}

/** One `report` against the (user, app) daily bucket (own sub-namespace). */
export async function checkSharedReportRateLimit(
  userId: number,
  appBlockId: string
): Promise<SharedStorageRateLimitResult> {
  const key =
    `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:shared-report:${appBlockId}:${userId}` as const;
  return checkFixedWindow(
    key,
    SHARED_REPORT_RATE_LIMIT_MAX,
    SHARED_REPORT_RATE_LIMIT_WINDOW_SECONDS
  );
}
