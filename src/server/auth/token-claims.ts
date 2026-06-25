// Read a claim off a JWT payload WITHOUT verifying the signature. Use ONLY for tokens already verified upstream
// (the civ-token from a cookie/bearer that getServerAuthSession / the package verifier validated) — e.g. `exp`
// for a cookie Max-Age, `iat` for rolling-refresh timing, `impersonatedBy` for an audit attribution. NEVER use
// it to make a trust/authorization decision on an unvalidated token.
export function decodeTokenPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Read a numeric claim (returns undefined if absent/non-numeric/undecodable). */
export function decodeTokenClaim(token: string, field: string): number | undefined {
  const value = decodeTokenPayload(token)?.[field];
  return typeof value === 'number' ? value : undefined;
}
