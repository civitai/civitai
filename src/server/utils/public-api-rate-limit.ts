import type { NextApiRequest } from 'next';
import requestIp from 'request-ip';
import { redis } from '~/server/redis/client';

/**
 * Conservative per-client fixed-window rate limit for the PUBLIC REST endpoints
 * that expose articles + collections (`/api/v1/articles[/:id]`,
 * `/api/v1/collections[/:id]`).
 *
 * WHY: these routes make articles/collections publicly REST-accessible for the
 * first time — a brand-new origin-exposure surface. The pre-existing public
 * endpoints (models/images) ship with NO per-endpoint ceiling; for a NEW surface
 * we start deliberately CAUTIOUS (easy to loosen later once real traffic shape is
 * known) so a scraper can't shift unbounded catalog cost onto the origin.
 *
 * PATTERN: the established fixed-window limiter — INCR + EXPIRE on the `redis`
 * cache client — byte-identical in shape to `checkBlockCatalogRateLimit` /
 * `checkSharedAppendRateLimit` / `BlockTokenService.checkRateLimit`.
 *
 * KEY: keyed on the CLIENT IP for unauthenticated callers, and on the USER ID for
 * authenticated callers (who get a higher bucket — a logged-in integration is a
 * known principal, not anonymous scraper traffic). The `family` segment
 * (`articles` | `collections`) gives each endpoint-family its OWN independent
 * bucket, so hammering articles never consumes a caller's collections budget.
 *
 * FAIL-OPEN: any redis error/timeout returns `allowed:true` — a read endpoint
 * must never hard-fail a public GET because the limiter's redis blipped. Mirrors
 * every sibling limiter. (The abuse ceiling is defence-in-depth, not the
 * authorization boundary — visibility gating is enforced independently in each
 * handler.)
 */

// CONSERVATIVE ceilings (named constants → trivially tunable). Chosen strict on
// purpose for a fresh public surface:
//   - Unauthenticated: 60 requests / minute / IP. A human browsing paginated
//     articles/collections issues at most a handful of requests per page view;
//     60/min (1/s sustained) is generous for that yet hard-caps a scraper walking
//     the catalog from a single IP.
//   - Authenticated: 120 requests / minute / user. A logged-in integration (e.g.
//     the CLI) gets 2× headroom for legitimate batch reads while still bounded.
// Both are easy to raise once real traffic is observed; err strict first.
export const PUBLIC_API_RATE_LIMIT_UNAUTH_MAX = 60;
export const PUBLIC_API_RATE_LIMIT_AUTH_MAX = 120;
export const PUBLIC_API_RATE_LIMIT_WINDOW_SECONDS = 60;

// Distinct top-level namespace so these buckets never contend with any other
// limiter's keys.
const KEY_PREFIX = 'public-api:rate-limit';

export type PublicApiRateLimitFamily = 'articles' | 'collections';

export type PublicApiRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

function resolveClientIp(req: NextApiRequest): string {
  return requestIp.getClientIp(req) ?? 'unknown';
}

async function checkFixedWindow(
  key: string,
  max: number,
  windowSeconds: number
): Promise<PublicApiRateLimitResult> {
  try {
    const count = await redis.incrBy(key as never, 1);
    if (count === 1) {
      await redis.expire(key as never, windowSeconds);
    } else {
      // Re-assert a lost TTL (a crash between INCR and EXPIRE would otherwise
      // strand a TTL-less key → permanent lock). Same mitigation the sibling
      // limiters use.
      const ttl = await redis.ttl(key as never);
      if (ttl < 0) await redis.expire(key as never, windowSeconds);
    }

    if (count <= max) return { allowed: true };

    let retryAfter = await redis.ttl(key as never);
    if (!Number.isFinite(retryAfter) || retryAfter < 1) retryAfter = windowSeconds;
    return { allowed: false, retryAfterSeconds: retryAfter };
  } catch {
    // Fail open — a redis incident must never break a public read.
    return { allowed: true };
  }
}

/**
 * Records one request against the caller's per-family window and reports whether
 * it is within the conservative ceiling.
 *
 * @param req    the incoming request (client IP is resolved from it for the
 *   unauthenticated bucket via the same `request-ip` resolver createContext uses).
 * @param family `articles` | `collections` — independent bucket per family.
 * @param userId the authenticated user id when present; keys the (higher) authed
 *   bucket. `undefined` → the per-IP unauthenticated bucket.
 */
export async function checkPublicApiRateLimit({
  req,
  family,
  userId,
}: {
  req: NextApiRequest;
  family: PublicApiRateLimitFamily;
  userId?: number;
}): Promise<PublicApiRateLimitResult> {
  const authed = typeof userId === 'number';
  const max = authed ? PUBLIC_API_RATE_LIMIT_AUTH_MAX : PUBLIC_API_RATE_LIMIT_UNAUTH_MAX;
  const bucket = authed ? `user:${userId}` : `ip:${resolveClientIp(req)}`;
  const key = `${KEY_PREFIX}:${family}:${bucket}`;
  return checkFixedWindow(key, max, PUBLIC_API_RATE_LIMIT_WINDOW_SECONDS);
}
