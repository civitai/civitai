import { createAuthVerifier } from '@civitai/auth';
import { sessions } from './registry';
import { withSysReadDeadline } from '../sys-read';

// The hub verifies its OWN issued tokens (to populate locals.user). It verifies the ES256 signature
// LOCALLY with AUTH_JWT_PUBLIC_KEY (createAuthVerifier defaults publicKeyPem from that env var), so
// no self-HTTP-fetch to its own JWKS endpoint — robust even if ORIGIN/the route is misconfigured.
// Plus the shared revocation check, so a logged-out or banned session is rejected here too.
// isRevoked fails OPEN — a redis blip must not log everyone out — and is bounded, so a hung redis
// costs a request the read deadline rather than the client's own backstop.
export const verifier = createAuthVerifier({
  isRevoked: async (claims) => {
    try {
      return await withSysReadDeadline(() => sessions.isRevoked(claims));
    } catch {
      return false;
    }
  },
});

/** Signature and expiry only: whose session this was, even after it was signed out. Never grants access. */
export const signatureVerifier = createAuthVerifier();
