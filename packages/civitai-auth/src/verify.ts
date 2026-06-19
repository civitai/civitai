// SPOKE verify side (Path C). Verifies a session token LOCALLY — no per-request hop:
//  1. ES256 JWS  → jose `jwtVerify` against the hub's cached JWKS (refetched only on an
//                  unknown `kid`, i.e. key rotation). This is the steady state.
//  2. legacy JWE → decoded with NEXTAUTH_SECRET via a jose reimplementation (legacy-cookie.ts) — NO next-auth
//                  dependency — ONLY to READ old `civitai-token` cookies until they age out post-cutover.
//  3. revocation → an INJECTED `isRevoked(claims)` (the existing redis marker). Injected,
//                  not imported, so the package keeps zero infra deps (base-package rules).
//
// Factory mirrors the createXClients(config) injection convention.
import { createRemoteJWKSet, decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';
import { sessionCookieName } from './cookies';
import { decodeLegacySessionCookie } from './legacy-cookie';
import { loadAuthEnv } from './env';
import type { SessionClaims } from './types';

const ALG = 'ES256'; // matches the signer (sign.ts) — EC P-256 keys, smaller signatures than RS256
// Accept a multiline PEM or a single-line value with literal `\n` escapes (matches sign.ts).
const normalizePem = (pem: string) => pem.replace(/\\n/g, '\n');

export interface AuthVerifierConfig {
  jwksUri?: string;
  issuer?: string;
  audience?: string;
  cookieName?: string;
  /**
   * Verify ES256 tokens LOCALLY with this SPKI public key instead of fetching JWKS. The hub uses
   * this to verify its OWN cookies — it already holds the key, so no self-HTTP-fetch to its JWKS
   * endpoint (which is fragile behind a misconfigured proxy). Defaults to env.AUTH_JWT_PUBLIC_KEY,
   * so a hub (which sets it) verifies locally while spokes (which only set AUTH_JWKS_URI) use JWKS.
   * Single-key only — for key ROTATION across multiple kids, use JWKS (spokes) instead.
   */
  publicKeyPem?: string;
  /** Migration-window only: secret to decode legacy next-auth JWE cookies. */
  legacySecret?: string;
  /**
   * Explicit kill-switch for the legacy next-auth JWE fallback. The legacy decode is a SECOND trust
   * root (symmetric, no iss/aud — the old cookies never carried them), so it must be gated by an
   * explicit decision, not merely inferred from `legacySecret` presence. Defaults to "on when a
   * legacy secret is configured" to preserve migration-window behavior; set `false` at cutover to
   * hard-disable legacy acceptance even while NEXTAUTH_SECRET is still in the env, then remove this
   * whole branch once all legacy cookies have aged out.
   */
  legacyEnabled?: boolean;
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
   * Verify a cross-root SWAP transport token (minted by the hub's mintSwapToken). Returns the userId + the
   * token's `jti` (so the hub can burn it for single-use) or null. Used by the cross-domain exchange to
   * establish a local session on a different root domain — no shared secret, JWKS only.
   */
  verifySwapToken(token: string): Promise<{ userId: number; jti: string } | null>;
}

export function createAuthVerifier(config: AuthVerifierConfig = {}): AuthVerifier {
  const env = loadAuthEnv();
  const issuer = config.issuer ?? env.AUTH_JWT_ISSUER;
  const cfg = {
    jwksUri: config.jwksUri ?? env.AUTH_JWKS_URI,
    issuer,
    audience: config.audience,
    // Cookie name is a hardcoded cross-app contract (see cookies.ts), NOT configurable. The
    // `__Secure-` prefix tracks the deployment protocol exactly like the main app's
    // libs/auth.ts (useSecureCookies = base URL is https) — here the hub issuer stands in for
    // that base URL (http://localhost → unprefixed, https://auth.civitai.com → __Secure-).
    cookieName: config.cookieName ?? sessionCookieName(issuer?.startsWith('https://') ?? false),
    publicKeyPem: config.publicKeyPem ?? env.AUTH_JWT_PUBLIC_KEY,
    legacySecret: config.legacySecret ?? env.NEXTAUTH_SECRET,
    // Explicit gate for the legacy JWE trust root. Default: enabled iff a legacy secret is present
    // (preserves migration-window behavior); pass `legacyEnabled: false` to force it off at cutover.
    legacyEnabled: config.legacyEnabled ?? true,
    isRevoked: config.isRevoked,
  };

  // Verification key. Prefer a LOCAL public key (no network) when configured — the hub verifying its
  // own tokens. Otherwise a memoized remote JWKS (caches keys, refetches on an unknown kid for
  // rotation) — the spoke path. At least one must be present to verify ES256.
  let _localKey: ReturnType<typeof importSPKI> | undefined;
  const localKey = () => (_localKey ??= importSPKI(normalizePem(cfg.publicKeyPem!), ALG));
  const jwks = !cfg.publicKeyPem && cfg.jwksUri ? createRemoteJWKSet(new URL(cfg.jwksUri)) : undefined;
  const canVerify = () => !!cfg.publicKeyPem || !!jwks;

  // Branch so each jwtVerify call matches a single jose overload (KeyLike vs JWKS-getter).
  async function verifyAsymmetric(token: string) {
    // Pin algorithms to ES256 explicitly: the trust root is the EC public key, but the allowed alg
    // must NOT be inferred from the verification key (alg-confusion guard) — jose only ever accepts
    // an ES256 signature here, never anything the header asks for.
    const opts = { issuer: cfg.issuer, audience: cfg.audience, algorithms: [ALG] };
    return cfg.publicKeyPem ? jwtVerify(token, await localKey(), opts) : jwtVerify(token, jwks!, opts);
  }

  async function verifyToken(token: string): Promise<SessionClaims | null> {
    let claims: SessionClaims | null = null;

    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      alg = undefined;
    }

    if (alg === ALG) {
      if (!canVerify())
        throw new Error(
          `[@civitai/auth] no AUTH_JWT_PUBLIC_KEY or AUTH_JWKS_URI configured for ${ALG} verification`
        );
      try {
        const { payload } = await verifyAsymmetric(token);
        claims = payload as SessionClaims;
      } catch {
        return null; // bad signature / expired / wrong issuer
      }
    } else if (cfg.legacyEnabled && cfg.legacySecret) {
      // Legacy next-auth JWE (encrypted, hkdf from NEXTAUTH_SECRET) — decoded with jose, no next-auth dep
      // (legacy-cookie.ts). Gated behind the explicit `legacyEnabled` switch (a second, symmetric trust
      // root with no iss/aud), not just secret presence. Returns null on a corrupt/foreign/expired
      // cookie. Drop this branch post-cutover.
      claims = await decodeLegacySessionCookie(token, cfg.legacySecret);
    }

    if (!claims) return null;
    // A SWAP transport token must NEVER be accepted as a session token (it shares iss/aud/kid with one) — the
    // exchange flow redeems it via verifySwapToken, not here.
    if ((claims as { purpose?: unknown }).purpose === 'swap') return null;
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

  async function verifySwapToken(token: string): Promise<{ userId: number; jti: string } | null> {
    if (!canVerify())
      throw new Error(
        '[@civitai/auth] no AUTH_JWT_PUBLIC_KEY or AUTH_JWKS_URI configured for swap verification'
      );
    try {
      const { payload } = await verifyAsymmetric(token);
      if (payload.purpose !== 'swap') return null;
      const userId = Number(payload.sub);
      // `jti` lets the exchange enforce single-use (the hub burns it after redeeming).
      return Number.isFinite(userId) && typeof payload.jti === 'string'
        ? { userId, jti: payload.jti }
        : null;
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
