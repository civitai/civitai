import { createAuthVerifier, type SessionClaims } from '@civitai/auth';
import { env } from '$env/dynamic/private';
import { hubRevocationFailOpenTotal } from '../metrics';
import { sessions } from './registry';

/**
 * Wall-clock bound on the hub's revocation read, in ms. The same knob and default as the main app's
 * system-Redis read deadline (REDIS_SYS_READ_TIMEOUT_MS), read per call. `<= 0` turns the bound off.
 */
export const DEFAULT_REVOCATION_READ_TIMEOUT_MS = 1000;

export function revocationReadTimeoutMs(): number {
  const raw = env.REDIS_SYS_READ_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_REVOCATION_READ_TIMEOUT_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) ? ms : DEFAULT_REVOCATION_READ_TIMEOUT_MS;
}

class RevocationReadTimeout extends Error {
  constructor(ms: number) {
    super(`revocation read timed out after ${ms}ms`);
    this.name = 'RevocationReadTimeout';
  }
}

/**
 * The revocation check the hub verifier runs: `read`, raced against `timeoutMs()`. It fails OPEN — an
 * error or a read that has not answered by the deadline counts as not revoked — so a slow or hung session
 * store neither logs everyone out nor holds every request for as long as the store stays hung. The abandoned
 * read is not cancelled; Promise.race keeps a handler on it, so its late rejection is never unhandled.
 */
export function createHubRevocationCheck(
  read: (claims: SessionClaims) => Promise<boolean>,
  timeoutMs: () => number = revocationReadTimeoutMs,
  onFailOpen: (reason: 'timeout' | 'error') => void = (reason) =>
    hubRevocationFailOpenTotal.inc({ reason })
): (claims: SessionClaims) => Promise<boolean> {
  return async (claims) => {
    const ms = timeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!ms || ms <= 0) return await read(claims);
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RevocationReadTimeout(ms)), ms);
      });
      return await Promise.race([read(claims), deadline]);
    } catch (err) {
      try {
        onFailOpen(err instanceof RevocationReadTimeout ? 'timeout' : 'error');
      } catch {
        // Observability only.
      }
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

// The hub verifies its OWN issued tokens (to populate locals.user). It verifies the ES256 signature
// LOCALLY with AUTH_JWT_PUBLIC_KEY (createAuthVerifier defaults publicKeyPem from that env var), so
// no self-HTTP-fetch to its own JWKS endpoint — robust even if ORIGIN/the route is misconfigured.
// Plus the shared revocation check, so a logged-out or banned session is rejected here too.
// isRevoked fails OPEN and is bounded by a deadline — a redis blip must not log everyone out, and a
// hung redis must not hold every request.
export const verifier = createAuthVerifier({
  isRevoked: createHubRevocationCheck((claims) => sessions.isRevoked(claims)),
});

/** Signature and expiry only: whose session this was, even after it was signed out. Never grants access. */
export const signatureVerifier = createAuthVerifier();
