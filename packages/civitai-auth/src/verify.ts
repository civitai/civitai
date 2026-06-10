// SPOKE verify side (Path C). Verifies a session token LOCALLY — no per-request hop:
//  1. RS256 JWS  → jose `jwtVerify` against the hub's cached JWKS (refetched only on an
//                  unknown `kid`, i.e. key rotation). This is the steady state.
//  2. legacy JWE → next-auth's own `decode` with NEXTAUTH_SECRET, ONLY during the
//                  HS256->RS256 migration window (parent doc: "token-format migration").
//  3. revocation → an INJECTED `isRevoked(claims)` (the existing redis marker). Injected,
//                  not imported, so the package keeps zero infra deps (base-package rules).
//
// Factory mirrors the createXClients(config) injection convention.
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { sessionCookieName } from './cookies';
import { loadAuthEnv } from './env';
import type { SessionClaims } from './types';

// next-auth is imported DYNAMICALLY (only in the legacy-decode branch) so the package's
// static module graph stays jose + zod only — non-next-auth consumers (e.g. the SvelteKit
// hub under Vite SSR) can import @civitai/auth without pulling next-auth.

export interface AuthVerifierConfig {
  jwksUri?: string;
  issuer?: string;
  audience?: string;
  cookieName?: string;
  /** Migration-window only: secret to decode legacy next-auth JWE cookies. */
  legacySecret?: string;
  /** Injected revocation check (e.g. the sysRedis TOKEN_STATE marker). Fail-open inside. */
  isRevoked?: (claims: SessionClaims) => Promise<boolean> | boolean;
}

export interface AuthVerifier {
  /** Verify a raw token string. Returns claims or null. */
  verifyToken(token: string): Promise<SessionClaims | null>;
  /** Pull the session cookie out of a Cookie header (or map) and verify it. */
  getSession(cookies: string | Record<string, string | undefined>): Promise<SessionClaims | null>;
  /** Convenience guard: claims, or a login redirect URL for the caller to 302 to. */
  requireAuth(
    cookies: string | Record<string, string | undefined>,
    callbackUrl: string
  ): Promise<{ session: SessionClaims } | { redirect: string }>;
  /**
   * Verify a cross-root SWAP transport token (minted by the hub's mintSwapToken).
   * Returns the userId or null. Used by the `account-switch` receiver on a different
   * root domain to establish a local session — no shared secret, JWKS only.
   */
  verifySwapToken(token: string): Promise<{ userId: number } | null>;
}

export function createAuthVerifier(config: AuthVerifierConfig = {}): AuthVerifier {
  const env = loadAuthEnv();
  const issuer = config.issuer ?? env.AUTH_JWT_ISSUER;
  const cfg = {
    jwksUri: config.jwksUri ?? env.AUTH_JWKS_URI,
    issuer,
    audience: config.audience ?? env.AUTH_JWT_AUDIENCE,
    // Cookie name is a hardcoded cross-app contract (see cookies.ts), NOT configurable. The
    // `__Secure-` prefix tracks the deployment protocol exactly like the main app's
    // libs/auth.ts (useSecureCookies = base URL is https) — here the hub issuer stands in for
    // that base URL (http://localhost → unprefixed, https://auth.civitai.com → __Secure-).
    cookieName: config.cookieName ?? sessionCookieName(issuer?.startsWith('https://') ?? false),
    legacySecret: config.legacySecret ?? env.NEXTAUTH_SECRET,
    isRevoked: config.isRevoked,
  };

  // Memoized remote keyset: caches keys, refetches only on an unknown kid (rotation).
  const jwks = cfg.jwksUri ? createRemoteJWKSet(new URL(cfg.jwksUri)) : undefined;

  async function verifyToken(token: string): Promise<SessionClaims | null> {
    let claims: SessionClaims | null = null;

    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      alg = undefined;
    }

    if (alg === 'RS256') {
      if (!jwks)
        throw new Error('[@civitai/auth] AUTH_JWKS_URI not configured for RS256 verification');
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: cfg.issuer,
          audience: cfg.audience,
        });
        claims = payload as SessionClaims;
      } catch {
        return null; // bad signature / expired / wrong issuer
      }
    } else if (cfg.legacySecret) {
      // Legacy next-auth JWE (encrypted, hkdf from secret). Drop this branch post-cutover.
      const { decode: nextAuthDecode } = await import('next-auth/jwt');
      claims = (await nextAuthDecode({ token, secret: cfg.legacySecret })) as SessionClaims | null;
    }

    if (!claims) return null;
    if (cfg.isRevoked && (await cfg.isRevoked(claims))) return null;
    return claims;
  }

  async function getSession(
    cookies: string | Record<string, string | undefined>
  ): Promise<SessionClaims | null> {
    const token = readCookie(cookies, cfg.cookieName);
    return token ? verifyToken(token) : null;
  }

  async function requireAuth(
    cookies: string | Record<string, string | undefined>,
    callbackUrl: string
  ): Promise<{ session: SessionClaims } | { redirect: string }> {
    const session = await getSession(cookies);
    if (session) return { session };
    const base = cfg.issuer ?? '';
    const redirect = `${base}/login?callbackUrl=${encodeURIComponent(callbackUrl)}`;
    return { redirect };
  }

  async function verifySwapToken(token: string): Promise<{ userId: number } | null> {
    if (!jwks)
      throw new Error('[@civitai/auth] AUTH_JWKS_URI not configured for swap verification');
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: cfg.issuer,
        audience: cfg.audience,
      });
      if (payload.purpose !== 'swap') return null;
      const userId = Number(payload.sub);
      return Number.isFinite(userId) ? { userId } : null;
    } catch {
      return null;
    }
  }

  return { verifyToken, getSession, requireAuth, verifySwapToken };
}

function readCookie(
  cookies: string | Record<string, string | undefined>,
  name: string
): string | undefined {
  if (typeof cookies !== 'string') return cookies[name];
  for (const part of cookies.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}
