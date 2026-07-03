import { checkRateLimit } from '$lib/server/auth/rate-limit';

// OAuth endpoint rate limits, ported from the main app's src/server/oauth/rate-limit.ts RATE_LIMITS.
// The limiter itself (fixed-window, fail-open) is the hub's SHARED checkRateLimit — we don't fork a
// second implementation, we just carry the per-endpoint limits + identifier policy here:
//   - authorize: per-user   (10/min)
//   - token:     per-client (20/min)
//   - revoke:    per-client (20/min)
//   - session:   per-IP     (300/min) — first-party BFF exchange. Called SERVER-TO-SERVER by the spoke, and
//                keyed via the cf-first getClientIp: on the PUBLIC path that resolves to the spoke's node egress
//                IP (the original intent — "the spoke's egress IP, not an end user", well above any single spoke
//                pod's real login throughput), and on the INTERNAL path to the END-USER IP the spoke forwards as
//                x-forwarded-for. Falls back to `client:<client_id>` only when no IP resolves (bucket-spreading
//                off the single 'unknown' key, not per-tenant abuse-proofing — client_id is unvalidated here).
//                The limit is a generous gross-abuse ceiling that never throttles legit traffic. Invalid codes
//                already bail cheaply at the redis lookup.
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
  identifier: string | null | undefined
): Promise<boolean> {
  const cfg = OAUTH_RATE_LIMITS[bucket];
  return checkRateLimit(`oauth:${bucket}`, identifier, cfg.limit, cfg.windowSeconds);
}
