import { checkRateLimit } from '$lib/server/auth/rate-limit';

// OAuth endpoint rate limits, ported from the main app's src/server/oauth/rate-limit.ts RATE_LIMITS.
// The limiter itself (fixed-window, fail-open) is the hub's SHARED checkRateLimit — we don't fork a
// second implementation, we just carry the per-endpoint limits + identifier policy here:
//   - authorize: per-user   (10/min)
//   - token:     per-IP     (20/min) — the authorization-code exchange.
//   - device:    per-IP     (30/min) — RFC 8628 authorization request. Keyed on the CALLER, never on
//                client_id: a device-flow client id is public and identical across every install of an
//                app, so charging it would both cap the whole fleet at one shared budget and let anyone
//                who knows the id exhaust it for everybody.
//   - device-token: per-device_code (20/min) — the poll loop. One device_code IS one sign-in attempt, so
//                this bounds a client polling faster than the interval we handed it without touching any
//                other user. A compliant client polls 60/DEVICE_POLL_INTERVAL = 12/min.
//   - device-token-anon: per-IP (240/min) — the coarse ceiling the per-device_code work is charged behind,
//                since device_code is attacker-supplied until the redis lookup. Sized for ~20 concurrent
//                sign-ins behind one egress IP so a NAT never binds first.
//   - revoke:    per-IP     (20/min)
//   - introspect: per-client (60/min) — server-to-server; one call per Civitai Link pairing. Charged only
//                AFTER client auth succeeds: the id is attacker-supplied until then, so charging it earlier
//                lets anyone who guesses it exhaust the real client's budget and block Link pairing.
//   - introspect-anon: per-IP (120/min) — what the pre-auth work on that endpoint is charged to instead.
//                Sits above the per-client limit so it never binds first for a legitimate caller.
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
  device: { limit: 30, windowSeconds: 60 },
  'device-token': { limit: 20, windowSeconds: 60 },
  'device-token-anon': { limit: 240, windowSeconds: 60 },
  authorize: { limit: 10, windowSeconds: 60 },
  revoke: { limit: 20, windowSeconds: 60 },
  session: { limit: 300, windowSeconds: 60 },
  introspect: { limit: 60, windowSeconds: 60 },
  'introspect-anon': { limit: 120, windowSeconds: 60 },
} as const;

export type OAuthRateLimitBucket = keyof typeof OAUTH_RATE_LIMITS;

/**
 * Check an OAuth endpoint's rate limit for `identifier` (userId for /authorize, IP for /token, /revoke
 * and /device, device_code for the device poll). Returns true if allowed, false if the caller should 429.
 * Fail-open on redis error.
 */
export async function checkOAuthRateLimit(
  bucket: OAuthRateLimitBucket,
  identifier: string | null | undefined
): Promise<boolean> {
  const cfg = OAUTH_RATE_LIMITS[bucket];
  return checkRateLimit(`oauth:${bucket}`, identifier, cfg.limit, cfg.windowSeconds);
}
