import { checkRateLimit } from '$lib/server/auth/rate-limit';

// OAuth endpoint rate limits, ported from the main app's src/server/oauth/rate-limit.ts RATE_LIMITS.
// The limiter itself (fixed-window, fail-open) is the hub's SHARED checkRateLimit — we don't fork a
// second implementation, we just carry the per-endpoint limits + identifier policy here:
//   - authorize: per-user   (10/min)
//   - token:     per-client (20/min)
//   - revoke:    per-client (20/min)
//   - session:   per-IP     (300/min) — first-party BFF exchange. Called SERVER-TO-SERVER by the spoke, so the
//                identifier is the spoke's egress IP, not an end user; the limit is a generous flood-guard
//                (gross-abuse ceiling), deliberately well above any single spoke pod's real login throughput so
//                it never throttles legitimate traffic. Invalid codes already bail cheaply at the redis lookup.
const OAUTH_RATE_LIMITS = {
  token: { limit: 20, windowSeconds: 60 },
  authorize: { limit: 10, windowSeconds: 60 },
  revoke: { limit: 20, windowSeconds: 60 },
  session: { limit: 300, windowSeconds: 60 },
} as const;

export type OAuthRateLimitBucket = keyof typeof OAUTH_RATE_LIMITS;

/**
 * Check an OAuth endpoint's rate limit for `identifier` (userId for /authorize, clientId or IP for
 * /token & /revoke). Returns true if allowed, false if the caller should 429. Fail-open on redis error.
 */
export async function checkOAuthRateLimit(
  bucket: OAuthRateLimitBucket,
  identifier: string
): Promise<boolean> {
  const cfg = OAUTH_RATE_LIMITS[bucket];
  return checkRateLimit(`oauth:${bucket}`, identifier, cfg.limit, cfg.windowSeconds);
}
