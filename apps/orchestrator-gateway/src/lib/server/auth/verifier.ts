import { createAuthVerifier } from '@civitai/auth';
import { sessions } from './registry';

// SPOKE-side verifier: the service verifies the incoming session token (`__Secure-civ-token`) or the
// per-user bearer token LOCALLY — no monolith hop. ES256 signatures are checked against the hub's cached
// JWKS (createAuthVerifier defaults jwksUri from AUTH_JWKS_URI when no local public key is set), plus the
// shared revocation check so a logged-out/banned session is rejected here too.
//
// isRevoked fails OPEN — a redis blip must not reject everyone (matches the hub's wiring).
export const verifier = createAuthVerifier({
  isRevoked: async (claims) => {
    try {
      return await sessions.isRevoked(claims);
    } catch {
      return false;
    }
  },
});
