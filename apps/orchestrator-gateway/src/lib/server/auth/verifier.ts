import {
  createAuthVerifier,
  createRevocationCheck,
  type SessionRegistryRedis,
} from '@civitai/auth';
import { getSysRedis } from '../clients/redis';
import { revocationDegradedTotal } from '../metrics';

// The shared revocation check (the same one the main app, the hub and the other spokes use), so a logged-out
// or banned session is rejected here too. Bounded by REDIS_SYS_READ_TIMEOUT_MS (default 1000ms). When the read
// fails it answers from the revocation markers this process has already read, and allows a session with none
// known — a redis blip must not reject everyone. Without a sys redis configured there is nothing to check.
const checkRevocation = createRevocationCheck({
  redis: () => getSysRedis() as unknown as SessionRegistryRedis,
  // SESSION_REVOCATION_CACHE=off|0|false (any case) turns off the record of seen revocations; anything else,
  // unset included, keeps it on. The same parse as @civitai/shared/env-switch, which this service does not
  // depend on.
  markerCache: !/^(off|0|false)$/i.test((process.env.SESSION_REVOCATION_CACHE ?? '').trim()),
  onError: (_err, _reason, _claims, verdict) => revocationDegradedTotal.inc({ verdict }),
});

// SPOKE-side verifier: the service verifies the incoming session token (`__Secure-civ-token`) or the
// per-user bearer token LOCALLY — no monolith hop. ES256 signatures are checked against the hub's cached
// JWKS (createAuthVerifier defaults jwksUri from AUTH_JWKS_URI when no local public key is set).
export const verifier = createAuthVerifier({
  isRevoked: async (claims) => (getSysRedis() ? checkRevocation(claims) : false),
});
