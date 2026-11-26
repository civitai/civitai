import type { NextApiRequest } from 'next';
// From the package rather than the `~/server/redis/client` shim on purpose: it is a pure helper
// with no client state, and importing it through the shim would force every suite that mocks the
// shim to add it to its mock factory.
import { checkFixedWindowWith, type FixedWindowCounter, prefixCacheKey } from '@civitai/redis';
import { redis } from '~/server/redis/client';
import { resolveClientIp } from '~/server/utils/client-ip';

// Re-exported so existing importers (and this module's own test file) keep their
// import path. `resolveClientIp` now lives in `~/server/utils/client-ip` so the
// generic tRPC rate-limit middleware can share the SAME implementation without
// importing this module's redis-bound public-REST limiter. One function, two
// consumers — see the module doc in client-ip.ts for why that matters.
export { resolveClientIp };

/**
 * Conservative per-client fixed-window rate limit for the PUBLIC REST endpoints
 * that expose articles, collections and posts (`/api/v1/articles[/:id]`,
 * `/api/v1/collections[/:id]`, `/api/v1/posts/:id`).
 *
 * WHY: these routes make articles/collections/posts publicly REST-accessible for the
 * first time — a brand-new origin-exposure surface. The pre-existing public
 * endpoints (models/images) ship with NO per-endpoint ceiling; for a NEW surface
 * we start deliberately CAUTIOUS (easy to loosen later once real traffic shape is
 * known) so a scraper can't shift unbounded catalog cost onto the origin.
 *
 * PATTERN: the established fixed-window limiter — INCR + EXPIRE on the `redis`
 * cache client — byte-identical in shape to `checkBlockCatalogRateLimit` /
 * `checkSharedVoteRateLimit` / `BlockTokenService.checkRateLimit`.
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

export type PublicApiRateLimitFamily =
  | 'articles'
  | 'collections'
  | 'posts'
  | 'comics'
  | 'verify'
  | 'verify-signed-in-ip';

// /api/v1/verify parses an uploaded file of up to 10 MiB in-process, so it gets a tighter budget.
const FAMILY_MAX: Partial<Record<PublicApiRateLimitFamily, { unauth: number; auth: number }>> = {
  verify: { unauth: 10, auth: 30 },
  // Keyed by IP across signed-in callers, so one address can't multiply its budget with accounts.
  'verify-signed-in-ip': { unauth: 60, auth: 60 },
};

export type PublicApiRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export function checkFixedWindow(
  key: string,
  max: number,
  windowSeconds: number,
  options: { failOpen?: boolean } = {}
): Promise<PublicApiRateLimitResult> {
  // Fails open by default: a redis incident must never break a public read. A caller guarding
  // something other than a public read can ask to fail closed.
  return checkFixedWindowWith(
    redis as unknown as FixedWindowCounter,
    key,
    max,
    windowSeconds,
    options
  );
}

/**
 * Records one request against the caller's per-family window and reports whether
 * it is within the conservative ceiling.
 *
 * @param req    the incoming request. The unauthenticated bucket keys on the
 *   client IP resolved from it by the shared `~/server/utils/client-ip`
 *   predicate — which prefers the edge-stamped header and keeps `request-ip`
 *   only as the non-edge fallback, so it is NOT the same derivation
 *   `createContext` uses for `ctx.ip`.
 * @param family `articles` | `collections` — independent bucket per family.
 * @param userId the authenticated user id when present; keys the (higher) authed
 *   bucket. `undefined` → the per-IP unauthenticated bucket.
 */
export async function checkPublicApiRateLimit({
  req,
  family,
  userId,
  failOpen,
}: {
  req: NextApiRequest;
  family: PublicApiRateLimitFamily;
  userId?: number;
  failOpen?: boolean;
}): Promise<PublicApiRateLimitResult> {
  const authed = typeof userId === 'number';
  const limits = FAMILY_MAX[family];
  const max = authed
    ? limits?.auth ?? PUBLIC_API_RATE_LIMIT_AUTH_MAX
    : limits?.unauth ?? PUBLIC_API_RATE_LIMIT_UNAUTH_MAX;
  const bucket = authed ? `user:${userId}` : `ip:${resolveClientIp(req)}`;
  // Minted from a literal rather than derived from REDIS_KEYS, so it does not inherit the
  // environment namespace from the key table — apply it explicitly. Without this a non-production
  // deployment burns PRODUCTION users' rate-limit budget and can 429 real traffic. No-op in
  // production.
  const key = prefixCacheKey(`${KEY_PREFIX}:${family}:${bucket}`);
  return checkFixedWindow(key, max, PUBLIC_API_RATE_LIMIT_WINDOW_SECONDS, { failOpen });
}
