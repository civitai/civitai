// SPOKE verify side (Path C). Verifies a session token LOCALLY — no per-request hop:
//  1. ES256 JWS  → jose `jwtVerify` against the hub's cached JWKS (refetched only on an
//                  unknown `kid`, i.e. key rotation). This is the steady state.
//     Nothing else is a session: any other token is rejected.
//  2. revocation → an INJECTED `isRevoked(claims)` (the existing redis marker). Injected,
//                  not imported, so the package keeps zero infra deps (base-package rules).
//
// Factory mirrors the createXClients(config) injection convention.
import { createHash } from 'node:crypto';
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  importSPKI,
  jwtVerify,
  type JWTPayload,
} from 'jose';
import { sessionCookieName } from './cookies';
import { loadAuthEnv } from './env';
import { now, elapsed, isTimeoutError, safeInvoke } from './timing';
import { SESSION_LINEAGE_MAX_AGE_MS } from './family';
import type { SessionClaims } from './types';

const ALG = 'ES256'; // matches the signer (sign.ts) — EC P-256 keys, smaller signatures than RS256
const JWKS_TIMEOUT_MS = 2500; // bound the on-rotation JWKS refetch (jose default is 5000ms) — see below
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
  /** Reject tokens without `iat0`. Defaults to env.AUTH_REQUIRE_IAT0 (false). */
  requireIat0?: boolean;
  /** Clock injection (tests), epoch ms. */
  clock?: () => number;
  /** Injected revocation check (e.g. the sysRedis TOKEN_STATE marker). Fail-open inside. */
  isRevoked?: (claims: SessionClaims) => Promise<boolean> | boolean;
  /**
   * Optional instrumentation for the JWKS verify leg — fires once per ES256-via-JWKS verify with its
   * wall-clock duration. Injected (not imported) so the package stays infra-dep-free; the CALLING app wires
   * it to prom-client. `hit` = verify succeeded (keys were cached → sub-ms crypto, OR a refetch on an unknown
   * kid succeeded → the network cost shows up here); `timeout` = the bounded JWKS refetch (timeoutDuration)
   * aborted. Ordinary bad-token failures (bad signature / expiry / issuer) are NOT emitted — they aren't a
   * JWKS-leg event. Must be cheap + never throw (authed hot path). Only fires on the JWKS path, never the
   * local-public-key (hub) path.
   */
  onJwksLeg?: (outcome: 'hit' | 'timeout', durationSeconds: number) => void;
  /**
   * Opt-in: remember a successful ES256 signature + `iss`/`aud`/`exp` check per token (keyed on a
   * SHA-256 of it) so a token presented on every request is cryptographically verified once per
   * `maxTtlMs`, never past its own `exp`. Only that step is cached: failures are not, and the
   * purpose, lineage and `isRevoked` checks still run on every call. This widens key-removal
   * staleness: a token verified just before a JWKS refresh stays cached for up to `maxTtlMs`, so a
   * signing key dropped from the JWKS stays usable for jose's JWKS cache window plus up to
   * `maxTtlMs`. A cache hit fires no `onJwksLeg`.
   */
  verifiedTokenCache?: { maxEntries: number; maxTtlMs: number };
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
    requireIat0: config.requireIat0 ?? env.AUTH_REQUIRE_IAT0,
    clock: config.clock ?? (() => Date.now()),
    isRevoked: config.isRevoked,
    onJwksLeg: config.onJwksLeg,
  };

  // Verification key. Prefer a LOCAL public key (no network) when configured — the hub verifying its
  // own tokens. Otherwise a memoized remote JWKS (caches keys, refetches on an unknown kid for
  // rotation) — the spoke path. At least one must be present to verify ES256.
  let _localKey: ReturnType<typeof importSPKI> | undefined;
  const localKey = () => (_localKey ??= importSPKI(normalizePem(cfg.publicKeyPem!), ALG));
  // Bound the JWKS refetch (triggered only on an unknown `kid`, i.e. key rotation) so it can't hang the verify
  // path. jose defaults timeoutDuration to 5000ms; we tighten it to 2500ms as defense-in-depth (on the authed
  // hot path a hung JWKS fetch would otherwise stall every request whose kid isn't cached). The internal
  // AUTH_JWKS_URI (see env change) also removes the CF-edge hairpin for this fetch.
  const jwks =
    !cfg.publicKeyPem && cfg.jwksUri
      ? createRemoteJWKSet(new URL(cfg.jwksUri), { timeoutDuration: JWKS_TIMEOUT_MS })
      : undefined;
  const canVerify = () => !!cfg.publicKeyPem || !!jwks;

  // Branch so each jwtVerify call matches a single jose overload (KeyLike vs JWKS-getter).
  async function verifyAsymmetric(token: string) {
    // Pin algorithms to ES256 explicitly: the trust root is the EC public key, but the allowed alg
    // must NOT be inferred from the verification key (alg-confusion guard) — jose only ever accepts
    // an ES256 signature here, never anything the header asks for.
    const opts = { issuer: cfg.issuer, audience: cfg.audience, algorithms: [ALG] };
    if (cfg.publicKeyPem) return jwtVerify(token, await localKey(), opts);
    // JWKS path (spoke): time it so a stalled key-refetch is VISIBLE to the calling app. Emit `timeout` on the
    // bounded JWKS-refetch abort, `hit` on success; a plain bad-token failure re-throws WITHOUT emitting (not a
    // JWKS-leg event). Instrumentation must never mask the verify result → we always re-throw on failure.
    const start = now();
    try {
      const res = await jwtVerify(token, jwks!, opts);
      // safeInvoke: a throwing metric callback must NOT turn a valid verify into a re-thrown fail-closed logout.
      safeInvoke(cfg.onJwksLeg, 'hit', elapsed(start));
      return res;
    } catch (err) {
      if (isTimeoutError(err)) safeInvoke(cfg.onJwksLeg, 'timeout', elapsed(start));
      throw err;
    }
  }

  const verifiedCache = config.verifiedTokenCache
    ? createVerifiedTokenCache(config.verifiedTokenCache)
    : undefined;

  async function verifyAsymmetricPayload(token: string): Promise<JWTPayload> {
    if (!verifiedCache) return (await verifyAsymmetric(token)).payload;
    const key = createHash('sha256').update(token).digest('base64url');
    const cached = verifiedCache.get(key);
    if (cached) return structuredClone(cached);
    const { payload } = await verifyAsymmetric(token);
    verifiedCache.set(key, payload);
    return structuredClone(payload);
  }

  async function verifyToken(token: string): Promise<SessionClaims | null> {
    let claims: SessionClaims | null = null;

    let alg: string | undefined;
    try {
      const header = decodeProtectedHeader(token);
      // A session is a plain JWT; an access token (`at+jwt`) or any other typed token is not one.
      if (header.typ !== undefined && header.typ !== 'JWT') return null;
      alg = header.alg;
    } catch {
      alg = undefined;
    }

    if (alg === ALG) {
      if (!canVerify())
        throw new Error(
          `[@civitai/auth] no AUTH_JWT_PUBLIC_KEY or AUTH_JWKS_URI configured for ${ALG} verification`
        );
      try {
        const payload = await verifyAsymmetricPayload(token);
        // Session tokens carry no `aud`; without a configured audience, tokens with one are not sessions.
        if (!cfg.audience && payload.aud !== undefined) return null;
        claims = payload as SessionClaims;
      } catch {
        return null; // bad signature / expired / wrong issuer
      }
    }

    if (!claims) return null;
    // Defense-in-depth: never accept a token carrying `purpose: 'swap'` as a session token.
    if ((claims as { purpose?: unknown }).purpose === 'swap') return null;
    if (!withinLineageLimits(claims)) return null;
    if (cfg.isRevoked && (await cfg.isRevoked(claims))) return null;
    return claims;
  }

  function withinLineageLimits(claims: SessionClaims): boolean {
    const t = cfg.clock();
    if (claims.impExp != null && t >= claims.impExp) return false;
    // Every impersonation is minted with an end time; one without it predates that rule.
    if (claims.impersonatedBy != null && claims.impExp == null) return false;
    if (claims.iat0 == null) return !cfg.requireIat0;
    return t < claims.iat0 + SESSION_LINEAGE_MAX_AGE_MS;
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

  return { verifyToken, getSession, requireAuth };
}

/**
 * Bounded LRU of verified payloads. An entry lives `maxTtlMs`, or until the token's `exp` if that is
 * sooner, on `Date.now()` — the clock jose checks `exp` against.
 */
export function createVerifiedTokenCache({
  maxEntries,
  maxTtlMs,
}: {
  maxEntries: number;
  maxTtlMs: number;
}) {
  const entries = new Map<string, { payload: JWTPayload; expiresAt: number }>();
  return {
    get(key: string): JWTPayload | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (Date.now() >= entry.expiresAt) return undefined;
      entries.set(key, entry);
      return entry.payload;
    },
    set(key: string, payload: JWTPayload): void {
      const now = Date.now();
      const expiresAt =
        typeof payload.exp === 'number'
          ? Math.min(now + maxTtlMs, payload.exp * 1000)
          : now + maxTtlMs;
      if (expiresAt <= now || maxEntries <= 0) return;
      entries.delete(key);
      entries.set(key, { payload, expiresAt });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
    },
    get size() {
      return entries.size;
    },
  };
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

/** How far in the future an access token's `iat` may be, for clock skew between hub pods. */
const ACCESS_TOKEN_IAT_LEEWAY_S = 30;

export interface AccessTokenJwtVerifierConfig {
  /** The hub's SPKI public key (PEM). Defaults to AUTH_JWT_PUBLIC_KEY. */
  publicKeyPem?: string;
  clock?: () => number;
}

/**
 * Verifies the hub's own RFC 9068 access tokens (`typ: at+jwt`): ES256 only, the given issuer exactly,
 * `exp` with no leeway, and `iat` at most 30 s ahead. Returns the payload, or null on any failure.
 * Throws when no public key is configured, or when `issuer` is empty.
 */
export function createAccessTokenJwtVerifier(config: AccessTokenJwtVerifierConfig = {}) {
  const publicKeyPem = config.publicKeyPem ?? loadAuthEnv().AUTH_JWT_PUBLIC_KEY;
  const clock = config.clock ?? (() => Date.now());
  let _key: ReturnType<typeof importSPKI> | undefined;
  const key = () => {
    if (!publicKeyPem) throw new Error('[@civitai/auth] no AUTH_JWT_PUBLIC_KEY configured');
    return (_key ??= importSPKI(normalizePem(publicKeyPem), ALG));
  };

  return async function verifyAccessTokenJwt(
    token: string,
    issuer: string
  ): Promise<JWTPayload | null> {
    if (!issuer) throw new Error('[@civitai/auth] an access token is verified against an issuer');
    const k = await key();
    const nowMs = clock();
    try {
      const { payload } = await jwtVerify(token, k, {
        algorithms: [ALG],
        issuer,
        typ: 'at+jwt',
        clockTolerance: 0,
        currentDate: new Date(nowMs),
        requiredClaims: ['exp', 'iat', 'jti', 'sub', 'aud', 'client_id'],
      });
      if (typeof payload.iat !== 'number') return null;
      if (payload.iat > Math.floor(nowMs / 1000) + ACCESS_TOKEN_IAT_LEEWAY_S) return null;
      return payload;
    } catch {
      return null;
    }
  };
}
