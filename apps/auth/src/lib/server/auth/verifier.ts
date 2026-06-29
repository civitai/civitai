import { createAuthVerifier } from '@civitai/auth';
import { sessions } from './registry';

// The hub verifies its OWN issued tokens (to populate locals.user). It verifies the ES256 signature
// LOCALLY with AUTH_JWT_PUBLIC_KEY (createAuthVerifier defaults publicKeyPem from that env var), so
// no self-HTTP-fetch to its own JWKS endpoint — robust even if ORIGIN/the route is misconfigured.
// Plus the shared revocation check, so a logged-out or banned session is rejected here too.
// isRevoked fails OPEN — a redis blip must not log everyone out.
export const verifier = createAuthVerifier({
  isRevoked: async (claims) => {
    try {
      return await sessions.isRevoked(claims);
    } catch {
      return false;
    }
  },
});
