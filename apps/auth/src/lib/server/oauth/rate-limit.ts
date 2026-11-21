import { json } from '@sveltejs/kit';
import { checkRateLimit, isRateLimited } from '$lib/server/auth/rate-limit';

// OAuth endpoint rate limits, ported from the main app's src/server/oauth/rate-limit.ts RATE_LIMITS.
// The limiter itself (fixed-window, fail-open) is the hub's SHARED checkRateLimit — we don't fork a
// second implementation, we just carry the per-endpoint limits + identifier policy here:
//   - authorize: per-user   (10/min)
//   - authorize-anon: per-IP (60/min) — a signed-out `prompt=none` request, the one signed-out case that
//                looks the client up (to send login_required back to it). Sized like a NAT of real users.
//   - token:     per-IP     (20/min) — the authorization-code exchange.
//   - token-overflow: per-IP (120/min) — FAILED client-secret checks on a request past `token`. Charged only
//                when the secret does not check out, so an app proving its secret is never held to it; once
//                an IP has used it up, its requests are refused before any secret check.
//   - token-client: per-client, at the limit staff set on that OauthClient (`tokenRateLimit`, admin OAuth
//                Apps page) — for apps Civitai runs, whose pods send every user's code exchange and refresh
//                from one egress IP. Charged only AFTER client auth succeeds (as `introspect` is), so a flood
//                against a guessed id cannot exhaust the real client's budget. Clients without a limit set
//                get the per-IP `token` limit only, as before.
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
//   - worker-token: per-IP (600/min) — the worker token-exchange grant, in place of `token`. A pool of
//                workers can share one egress IP, each exchanging about every 15 minutes.
//   - worker-device: per-(client, device) (10/min) — charged after client auth, so the device id is
//                bound to an authenticated client before it is used as a key.
//   - introspect-worker: per-client (1200/min) — `introspect` for a caller allowed to see Worker tokens,
//                which checks each worker that registers.
//   - token-exchange: per-client (600/min, or the client's staff-set `tokenRateLimit`) — the user token
//                exchange, charged after client auth. One relay exchanges for many users from one IP, so the
//                per-IP `token` limit never applies to it.
//   - token-exchange-ip: per-IP (120/min) — FAILED client-secret checks on the user token exchange. A request
//                whose secret checks out is never charged or refused by it. With no resolvable IP the
//                failures share one bucket, never one keyed on the claimed client id.
//   - token-service: per-client (60/min) — service tokens (service-token.ts), charged after client auth. The
//                per-IP `token` limit never applies to it.
//   - introspect-jwt: per-client (1200/min) — introspection of any `at+jwt` (exchanged or service),
//                charged after client auth.
//   - app-token: per-(userId, clientId) (60/min) — internal-only app-block mint; a block refreshes at most
//                once per token TTL, so this only catches a runaway host loop.
//   - block-exchange: per-(userId, appId) (30/min) — the block token exchange (block-exchange.ts), charged
//                after client auth, the caller allowlist and the block token's signature check, on top of the
//                caller's `token-exchange` limit. A block token is exchanged once and lives 15 minutes, so a
//                legitimate (user, app) needs a handful a minute at most; this caps one user's fan-out.
const OAUTH_RATE_LIMITS = {
  token: { limit: 20, windowSeconds: 60 },
  'token-overflow': { limit: 120, windowSeconds: 60 },
  device: { limit: 30, windowSeconds: 60 },
  'device-token': { limit: 20, windowSeconds: 60 },
  'device-token-anon': { limit: 240, windowSeconds: 60 },
  authorize: { limit: 10, windowSeconds: 60 },
  'authorize-anon': { limit: 60, windowSeconds: 60 },
  revoke: { limit: 20, windowSeconds: 60 },
  session: { limit: 300, windowSeconds: 60 },
  introspect: { limit: 60, windowSeconds: 60 },
  'introspect-anon': { limit: 120, windowSeconds: 60 },
  'app-token': { limit: 60, windowSeconds: 60 },
  'worker-token': { limit: 600, windowSeconds: 60 },
  'worker-device': { limit: 10, windowSeconds: 60 },
  'introspect-worker': { limit: 1200, windowSeconds: 60 },
  'token-exchange': { limit: 600, windowSeconds: 60 },
  'token-exchange-ip': { limit: 120, windowSeconds: 60 },
  'introspect-jwt': { limit: 1200, windowSeconds: 60 },
  'token-service': { limit: 60, windowSeconds: 60 },
  'block-exchange': { limit: 30, windowSeconds: 60 },
} as const;

export type OAuthRateLimitBucket = keyof typeof OAUTH_RATE_LIMITS;

// The only place the auth app writes this status: every 429 goes through rateLimitedResponse, and
// rate-limited-response.test.ts fails on a 429 built anywhere else.
export const RATE_LIMITED_STATUS = 429;

/**
 * A bucket's Retry-After: its static window, not the key's remaining TTL, so callers sharing one bucket
 * (a worker pool behind one IP) spread their retries instead of all returning at the window edge.
 */
export function oauthRetryAfter(bucket: OAuthRateLimitBucket): number {
  return OAUTH_RATE_LIMITS[bucket].windowSeconds;
}

const waitText = (seconds: number) => {
  if (seconds < 60) return seconds === 1 ? '1 second' : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
};

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A 429 with `Retry-After` and `retry_after` (whole seconds, at least 1). Pass `request` on a route a
 * browser navigates to: a request that accepts text/html gets a readable page instead of JSON.
 */
export function rateLimitedResponse(
  retryAfter: number,
  headers?: HeadersInit,
  description = 'Too many requests',
  options: { request?: Request } = {}
): Response {
  const seconds = Math.max(1, Math.ceil(retryAfter));
  const out = new Headers(headers);
  out.set('Retry-After', String(seconds));
  if (options.request?.headers.get('accept')?.includes('text/html')) {
    out.set('Content-Type', 'text/html; charset=utf-8');
    const text = `${escapeHtml(description)}. Try again in ${waitText(seconds)}.`;
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Too many requests</title><p>${text}</p></html>`,
      { status: RATE_LIMITED_STATUS, headers: out }
    );
  }
  return json(
    { error: 'rate_limited', error_description: description, retry_after: seconds },
    { status: RATE_LIMITED_STATUS, headers: out }
  );
}

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

/**
 * Whether an IP is past the per-IP `token` limit and has used up its `token-overflow` budget of failed
 * secret checks, so the token route checks no more secrets for it (counts nothing).
 */
export async function tokenSecretChecksExhausted(ip: string | null | undefined): Promise<boolean> {
  return (
    (await isRateLimited('oauth:token', ip, OAUTH_RATE_LIMITS.token.limit)) &&
    (await tokenOverflowExhausted(ip))
  );
}

/** Whether an IP has used up its `token-overflow` budget of failed secret checks (counts nothing). */
export async function tokenOverflowExhausted(ip: string | null | undefined): Promise<boolean> {
  return isRateLimited('oauth:token-overflow', ip, OAUTH_RATE_LIMITS['token-overflow'].limit);
}

/** The `token-client` check: a client's own per-minute /oauth/token limit, as set by staff. */
export async function checkClientTokenRateLimit(clientId: string, limit: number): Promise<boolean> {
  // The token route answers this refusal with the `token` window.
  return checkRateLimit(
    'oauth:token-client',
    clientId,
    limit,
    OAUTH_RATE_LIMITS.token.windowSeconds
  );
}

/** The `token-exchange` check: per authenticated client, at its staff-set limit when it has one. */
export async function checkTokenExchangeRateLimit(
  clientId: string,
  clientLimit: number | null
): Promise<boolean> {
  const cfg = OAUTH_RATE_LIMITS['token-exchange'];
  return checkRateLimit(
    'oauth:token-exchange',
    clientId,
    clientLimit ?? cfg.limit,
    cfg.windowSeconds
  );
}

/** Count one failed client-secret check on the user token exchange; false once the IP is past its limit. */
export async function chargeTokenExchangeFailure(ip: string | null): Promise<boolean> {
  return checkOAuthRateLimit('token-exchange-ip', ip ?? 'no-ip');
}
