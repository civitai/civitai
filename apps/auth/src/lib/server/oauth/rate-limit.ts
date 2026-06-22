import { checkRateLimit } from '$lib/server/auth/rate-limit';

// OAuth endpoint rate limits, ported from the main app's src/server/oauth/rate-limit.ts RATE_LIMITS.
// The limiter itself (fixed-window, fail-open) is the hub's SHARED checkRateLimit — we don't fork a
// second implementation, we just carry the per-endpoint limits + identifier policy here:
//   - authorize: per-user   (10/min)
//   - token:     per-client (20/min)
//   - revoke:    per-client (20/min)
const OAUTH_RATE_LIMITS = {
  token: { limit: 20, windowSeconds: 60 },
  authorize: { limit: 10, windowSeconds: 60 },
  revoke: { limit: 20, windowSeconds: 60 },
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
