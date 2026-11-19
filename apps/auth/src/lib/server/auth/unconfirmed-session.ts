import type { SessionClaims } from '@civitai/auth';

// Claims the hub verifier accepted without reading the session store: the read failed and no revocation it
// already knew of applied. Each verifyToken call returns its own claims object, so a mark covers that one
// verification and no other.
const unconfirmed = new WeakSet<SessionClaims>();

export function markUnconfirmedSession(claims: SessionClaims): void {
  unconfirmed.add(claims);
}

export function isUnconfirmedSession(claims: SessionClaims): boolean {
  return unconfirmed.has(claims);
}
