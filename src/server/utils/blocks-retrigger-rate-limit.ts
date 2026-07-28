import { redis, REDIS_KEYS } from '~/server/redis/client';

/**
 * Redis-backed abuse controls for the moderator-only `blocks.retriggerBuild`
 * mutation.
 *
 * WHY NOT THE tRPC `rateLimit` MIDDLEWARE — `rateLimit` from
 * `~/server/middleware.trpc` SHORT-CIRCUITS for moderators:
 *
 *     if (ctx.user?.isModerator || isDev || isTest || isPreview) return await next();
 *
 * so on a `moderatorProcedure` it is a guaranteed NO-OP. A mod-only build
 * re-trigger therefore needs its own limiter or it has none at all. These helpers
 * follow the established blocks limiter shapes instead: the atomic
 * `setNxKeepTtlWithEx` typed-boolean NX lock used by the build callback's apply
 * dedup, and the `INCR` + `EXPIRE` fixed window used by the tip / catalog
 * limiters. Both live under the existing `BLOCKS.TOKEN_RATE_LIMIT` key family in
 * their own sub-namespaces so they never contend with the mint / apply buckets.
 *
 * FAIL DIRECTION — both helpers FAIL OPEN on a Redis error, matching
 * `markApplyTriggered` in `build-callback.ts` (the closest sibling on this exact
 * path). Rationale: this procedure exists to RECOVER from a stuck deploy, and it
 * is reachable only by a moderator who has already passed `moderatorProcedure` +
 * the inner `isModerator` recheck. Letting a Redis incident block an incident
 * recovery is strictly worse than letting a trusted operator briefly exceed a
 * courtesy cap. (Contrast `block-tip-rate-limit`, which fails CLOSED because it
 * guards a money path reachable by any user.)
 */

/**
 * Single-flight lock TTL for one publish request. Long enough that a double-click
 * / duplicated tab cannot create two Tekton PipelineRuns, short enough that a
 * genuine second attempt after a visible failure is not wedged for long.
 */
export const RETRIGGER_LOCK_TTL_SECONDS = 60;

/** Per-moderator ceiling: how many retriggers one mod may fire per window. */
export const RETRIGGER_MAX_PER_WINDOW = 10;
/** Window for {@link RETRIGGER_MAX_PER_WINDOW}. */
export const RETRIGGER_WINDOW_SECONDS = 60 * 60; // 1 hour

function lockKey(publishRequestId: string): string {
  return `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:retrigger:${publishRequestId}`;
}

function moderatorQuotaKey(reviewerUserId: number): string {
  return `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:retrigger-mod:${reviewerUserId}`;
}

/**
 * Claim the single-flight slot for `publishRequestId`.
 *
 * @returns `true` when the caller OWNS the slot and may proceed; `false` when a
 *   retrigger for this request is already in flight within the TTL window (the
 *   double-click case) and the caller must stop.
 */
export async function acquireRetriggerLock(publishRequestId: string): Promise<boolean> {
  try {
    // true = newly set (we own it); false = key already present (in flight).
    return await redis.setNxKeepTtlWithEx(
      lockKey(publishRequestId) as never,
      '1',
      RETRIGGER_LOCK_TTL_SECONDS
    );
  } catch {
    // FAIL OPEN — see the module doc. A Redis incident must not block a recovery.
    return true;
  }
}

/**
 * Release the single-flight slot early, so a moderator who saw the retrigger fail
 * can immediately try again instead of waiting out the TTL. Best-effort; the TTL
 * is the backstop. Never throws.
 */
export async function releaseRetriggerLock(publishRequestId: string): Promise<void> {
  try {
    await redis.del(lockKey(publishRequestId) as never);
  } catch {
    // swallow — the TTL releases the slot regardless.
  }
}

export type RetriggerQuotaResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Record one retrigger attempt against this moderator's fixed window and report
 * whether it is within {@link RETRIGGER_MAX_PER_WINDOW}. Bounds how hard the
 * procedure can hammer the shared build cluster even in the hands of a trusted
 * operator (or a runaway client).
 */
export async function checkRetriggerModeratorQuota(
  reviewerUserId: number
): Promise<RetriggerQuotaResult> {
  const key = moderatorQuotaKey(reviewerUserId);
  try {
    const count = await redis.incrBy(key as never, 1);
    if (count === 1) {
      await redis.expire(key as never, RETRIGGER_WINDOW_SECONDS);
    } else {
      // Self-heal a TTL-less key (re-arm ONLY when the TTL is actually missing, so
      // an active window is never extended) — same footgun guard as the siblings.
      const ttl = await redis.ttl(key as never);
      if (ttl < 0) await redis.expire(key as never, RETRIGGER_WINDOW_SECONDS);
    }

    if (count <= RETRIGGER_MAX_PER_WINDOW) return { allowed: true };

    let retryAfter = await redis.ttl(key as never);
    if (!Number.isFinite(retryAfter) || retryAfter < 1) retryAfter = RETRIGGER_WINDOW_SECONDS;
    return { allowed: false, retryAfterSeconds: retryAfter };
  } catch {
    // FAIL OPEN — see the module doc.
    return { allowed: true };
  }
}
