import { redis, REDIS_KEYS } from '~/server/redis/client';

/**
 * Redis-backed abuse controls for the moderator-only `appListings.messageAppOwner`
 * mutation.
 *
 * 🔴 WHY NOT THE tRPC `rateLimit` MIDDLEWARE — `rateLimit` from
 * `~/server/middleware.trpc` SHORT-CIRCUITS for moderators:
 *
 *     if (ctx.user?.isModerator || isDev || isTest || isPreview) return await next();
 *
 * so on a `moderatorProcedure` it is a guaranteed NO-OP. Wiring it here would look
 * like a rate limit in review, in the router source, and in a diff — and cap nothing.
 * This mirrors `blocks-retrigger-rate-limit.ts`, which exists for the same reason.
 *
 * 🔴 TWO COUNTERS, BECAUSE THEY BOUND DIFFERENT HARMS. One would not do:
 *   - the PER-MODERATOR window bounds a runaway client / a compromised mod session
 *     spraying the developer population, and is the one a single actor can exhaust;
 *   - the PER-LISTING window bounds what any ONE developer can be made to receive,
 *     ACROSS ALL moderators. That is the harassment ceiling, and a per-moderator cap
 *     cannot express it: three moderators at nine messages an hour each are all
 *     individually under a per-mod cap of ten while the recipient gets 27.
 *
 * FAIL DIRECTION — both FAIL OPEN on a Redis error, matching
 * `blocks-retrigger-rate-limit` and the shared-storage limiters. The reasoning is that
 * these are courtesy caps on an actor who is individually IDENTIFIED and permanently
 * ATTRIBUTED: every send writes an `AppListingModerationEvent` carrying `actorUserId`,
 * in Postgres, before anything is delivered. That record — not the counter — is the
 * accountability mechanism, and it does not depend on Redis. Failing closed would mean
 * a Redis incident silently blocks moderation correspondence while leaving every other
 * mod action working. (Contrast `block-tip-rate-limit`, which fails CLOSED because it
 * guards a money path reachable by any user.)
 */

/** Per-moderator ceiling: how many owner-messages one mod may send per window. */
export const MOD_MESSAGE_MAX_PER_MODERATOR = 30;
/** Per-listing ceiling: how many owner-messages ONE app may receive per window, from all mods. */
export const MOD_MESSAGE_MAX_PER_LISTING = 5;
/** Window for both ceilings. */
export const MOD_MESSAGE_WINDOW_SECONDS = 60 * 60; // 1 hour

function moderatorQuotaKey(moderatorUserId: number): string {
  return `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:mod-message-actor:${moderatorUserId}`;
}

function listingQuotaKey(appListingId: string): string {
  return `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:mod-message-listing:${appListingId}`;
}

export type ModMessageQuotaResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * One INCR + EXPIRE fixed window. Shared by both counters so the two ceilings cannot
 * drift in their TTL self-heal or their retry-after arithmetic — the duplication this
 * replaces is what lets one of a pair of limiters quietly become TTL-less.
 */
async function checkFixedWindow(key: string, max: number): Promise<ModMessageQuotaResult> {
  try {
    const count = await redis.incrBy(key as never, 1);
    if (count === 1) {
      await redis.expire(key as never, MOD_MESSAGE_WINDOW_SECONDS);
    } else {
      // Self-heal a TTL-less key (re-arm ONLY when the TTL is actually missing, so an
      // active window is never extended) — same footgun guard as the siblings.
      const ttl = await redis.ttl(key as never);
      if (ttl < 0) await redis.expire(key as never, MOD_MESSAGE_WINDOW_SECONDS);
    }

    if (count <= max) return { allowed: true };

    let retryAfter = await redis.ttl(key as never);
    if (!Number.isFinite(retryAfter) || retryAfter < 1) retryAfter = MOD_MESSAGE_WINDOW_SECONDS;
    return { allowed: false, retryAfterSeconds: retryAfter };
  } catch {
    // FAIL OPEN — see the module doc.
    return { allowed: true };
  }
}

/** Record one send against this moderator's window. */
export async function checkModMessageModeratorQuota(
  moderatorUserId: number
): Promise<ModMessageQuotaResult> {
  return checkFixedWindow(moderatorQuotaKey(moderatorUserId), MOD_MESSAGE_MAX_PER_MODERATOR);
}

/**
 * Record one send against this LISTING's window.
 *
 * 🔴 Keyed on the PARENT listing id, which the caller must have resolved already — a
 * shadow revision is the same app, so keying on whatever id the moderator happened to
 * paste would hand a second full allowance per open revision.
 */
export async function checkModMessageListingQuota(
  appListingId: string
): Promise<ModMessageQuotaResult> {
  return checkFixedWindow(listingQuotaKey(appListingId), MOD_MESSAGE_MAX_PER_LISTING);
}
