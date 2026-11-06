import type { SessionClaims } from './types';

/** No session outlives this, counted from the sign-in it descends from (`iat0`). */
export const SESSION_LINEAGE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export type FamilyClaims = Pick<SessionClaims, 'sid' | 'iat0' | 'impersonatedBy' | 'impExp'>;

/** A root session is its own family; every descendant carries the root's id as `sid`. */
export function familyId(claims: Pick<SessionClaims, 'sid' | 'jti'>): string | undefined {
  return claims.sid ?? claims.jti;
}

/**
 * The lineage claims every session mint carries. `parent` is the session being refreshed, switched from or
 * impersonated from; null for a fresh sign-in.
 */
export function familyClaims(
  parent: SessionClaims | null,
  opts: { iat0?: number; clearImpersonation?: boolean; now?: number } = {}
): FamilyClaims {
  const out: FamilyClaims = {
    iat0: opts.iat0 ?? parent?.iat0 ?? opts.now ?? Date.now(),
  };
  const sid = parent ? familyId(parent) : undefined;
  if (sid) out.sid = sid;
  if (parent && !opts.clearImpersonation) {
    if (parent.impersonatedBy != null) out.impersonatedBy = parent.impersonatedBy;
    if (parent.impExp != null) out.impExp = parent.impExp;
  }
  return out;
}
