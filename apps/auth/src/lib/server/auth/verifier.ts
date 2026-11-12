import {
  createAuthVerifier,
  createRevocationCheck,
  type SessionRegistryRedis,
} from '@civitai/auth';
import { hubRevocationFailOpenTotal } from '../metrics';
import { getSysRedis } from '../redis';

// The shared revocation check (the same one the main app and the spokes use). It fails OPEN — a redis blip
// must not log everyone out — and is bounded by REDIS_SYS_READ_TIMEOUT_MS (default 1000ms), so a hung store
// cannot hold every hub request either. Without a sys redis configured there is nothing to check, the same
// as the registry's no-op fallback.
const checkRevocation = createRevocationCheck({
  redis: () => getSysRedis() as unknown as SessionRegistryRedis,
  onError: (_err, reason) => hubRevocationFailOpenTotal.inc({ reason }),
});

// The hub verifies its OWN issued tokens (to populate locals.user). It verifies the ES256 signature
// LOCALLY with AUTH_JWT_PUBLIC_KEY (createAuthVerifier defaults publicKeyPem from that env var), so
// no self-HTTP-fetch to its own JWKS endpoint — robust even if ORIGIN/the route is misconfigured.
// Plus the shared revocation check, so a logged-out or banned session is rejected here too.
export const verifier = createAuthVerifier({
  isRevoked: async (claims) => (getSysRedis() ? checkRevocation(claims) : false),
});

/** Signature and expiry only: whose session this was, even after it was signed out. Never grants access. */
export const signatureVerifier = createAuthVerifier();
