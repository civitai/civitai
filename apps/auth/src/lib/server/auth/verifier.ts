import {
  createAuthVerifier,
  createRevocationCheck,
  revocationReadTimeoutMs,
  type SessionClaims,
  type SessionRegistryRedis,
} from '@civitai/auth';
import { hubRevocationDeniedCachedTotal, hubRevocationFailOpenTotal } from '../metrics';
import { getSysRedis } from '../redis';
import { waitForRedisReady } from '../redis-ready';
import { markUnconfirmedSession } from './unconfirmed-session';

// The shared revocation check (the same one the main app and the spokes use). When the read fails it answers
// from the revocation markers the hub has already read and allows a session with none known — a redis blip
// must not log everyone out — and it is bounded by REDIS_SYS_READ_TIMEOUT_MS (default 1000ms), so a hung store
// cannot hold every hub request either. Without a sys redis configured there is nothing to check, the same
// as the registry's no-op fallback.
const checkRevocation = createRevocationCheck({
  redis: () => getSysRedis() as unknown as SessionRegistryRedis,
  // SESSION_REVOCATION_CACHE=off|0|false (any case) turns off the record of seen revocations; anything else,
  // unset included, keeps it on. The same parse as @civitai/shared/env-switch, which the hub does not depend on.
  markerCache: !/^(off|0|false)$/i.test((process.env.SESSION_REVOCATION_CACHE ?? '').trim()),
  // No retry after a fast error: during an outage every sign-in would wait the backoff.
  retry: false,
  onError: (_err, reason, claims, verdict) => {
    if (verdict === 'deny_cached') hubRevocationDeniedCachedTotal.inc({ reason });
    else {
      markUnconfirmedSession(claims);
      hubRevocationFailOpenTotal.inc({ reason });
    }
  },
});

let sysWasReady = false;
// The end of the start-up wait window, set by the first check. Checks share it, so a process that starts during
// a store outage waits at most one read deadline in all, not one per check.
let coldStartUntil: number | undefined;

// Until the sys client has been ready once (process start), wait for it inside the read deadline rather than
// allowing every session unread. After that a store outage allows at once, as above.
async function isRevoked(claims: SessionClaims): Promise<boolean> {
  const sys = getSysRedis() as { isReady?: boolean } | null;
  if (!sys) return false;
  if (!sysWasReady && sys.isReady !== false) sysWasReady = true;
  const budget = revocationReadTimeoutMs();
  if (sysWasReady || budget <= 0) return checkRevocation(claims);
  const started = Date.now();
  coldStartUntil ??= started + budget;
  const wait = Math.min(budget, coldStartUntil - started);
  if (wait <= 0) return checkRevocation(claims);
  await waitForRedisReady(sys, wait);
  return checkRevocation(claims, { timeoutMs: Math.max(1, budget - (Date.now() - started)) });
}

// The hub verifies its OWN issued tokens (to populate locals.user). It verifies the ES256 signature
// LOCALLY with AUTH_JWT_PUBLIC_KEY (createAuthVerifier defaults publicKeyPem from that env var), so
// no self-HTTP-fetch to its own JWKS endpoint — robust even if ORIGIN/the route is misconfigured.
// Plus the shared revocation check, so a logged-out or banned session is rejected here too.
export const verifier = createAuthVerifier({ isRevoked });

/** Signature and expiry only: whose session this was, even after it was signed out. Never grants access. */
export const signatureVerifier = createAuthVerifier();
