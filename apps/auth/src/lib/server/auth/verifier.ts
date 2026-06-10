import { createAuthVerifier } from '@civitai/auth';
import { sessions } from './registry';

// The hub verifies its OWN issued tokens (to populate locals.user) the same way a spoke does:
// RS256 via JWKS (set AUTH_JWKS_URI to this app's /api/auth/jwks) PLUS the shared revocation
// check, so a logged-out or banned session is rejected here too. isRevoked fails OPEN — a redis
// blip must not log everyone out.
export const verifier = createAuthVerifier({
  isRevoked: async (claims) => {
    try {
      return await sessions.isRevoked(claims);
    } catch {
      return false;
    }
  },
});
