import { createAuthVerifier, type AuthVerifier } from './verify';
import { loadAuthEnv } from './env';
import { hubFetch } from './hub';
import { getCacheRedis, sessionCacheKey } from './redis';
import type { SessionUser, SessionClaims } from './types';

// SESSION CLIENT — the consumer-side interface to the auth hub's session-user data (thin-session model;
// docs/thin-session-token-design.md, "LOCKED ARCHITECTURE"). One zero-config builder for every session op a
// consumer app performs:
//   - READ:  getSessionUser(token) — verify → shared redis cache → on miss, GET {iss}/api/auth/identity.
//   - WRITE: invalidate(userId) / refresh(userId) — POST the hub to bust (and optionally re-produce).
//
// There is ONE producer of session data (the hub), so reads never compute and writes never touch the DB —
// both route through the hub. ZERO CONFIG: the verifier, cache, hub URL, and service secret all come from
// env / the verified token's `iss`; nothing is injectable, so a consumer can't repoint anything.

export interface SessionClient {
  /**
   * Verify → shared-cache read → on miss fetch the hub identity endpoint. Null if no valid session.
   *
   * Date caveat: cache HITS return real `Date`s (the hub producer writes them via packed/msgpack); the rare
   * cold-miss path returns date fields as ISO strings (HTTP JSON). Coerce dates rather than assume `Date`.
   */
  getSessionUser(token: string): Promise<SessionUser | null>;
  /**
   * Read-through resolve BY userId (no token) — for consumer paths that start from a userId rather than a
   * verifiable session token: API-key/bearer auth and the legacy-cookie fallback. Same shared-cache read +
   * per-pod single-flight as getSessionUser(token), but the hub fetch is the INTERNAL-authed read-through
   * identity endpoint (`GET /api/auth/identity?userId=`, gated by AUTH_INTERNAL_TOKEN), since there's no token
   * to present. Null when there's no such user, the secret is unset, or the hub is unreachable. This is a READ
   * (getOrProduce) — use refresh(userId) to force a recompute/bust.
   */
  getSessionUserById(userId: number): Promise<SessionUser | null>;
  /** Bust the user's cached session — the next read re-produces (lazy). */
  invalidate(userId: number): Promise<void>;
  /** Bust AND re-produce now (eager); returns the fresh user, or null if there's no such user. */
  refresh(userId: number): Promise<SessionUser | null>;
}

export interface SessionClientConfig {
  /**
   * Injected revocation check (e.g. the shared redis TOKEN_STATE marker). Without it the read path verifies
   * signature + expiry ONLY — a logged-out / banned token would still resolve on a `session:data2` cache hit,
   * because the rich user is read from cache, not re-derived. Wiring it makes `getSessionUser` reject a revoked
   * token before the cache read. Fail-open inside (a redis blip must not log everyone out).
   */
  isRevoked?: (claims: SessionClaims) => Promise<boolean> | boolean;
}

export function createSessionClient(config: SessionClientConfig = {}): SessionClient {
  // Lazy env-built verifier (jose only instantiated on first read, never at import). The verifier applies the
  // injected `isRevoked` after signature/expiry, so revocation is enforced on the cache-hit read path too.
  let _verifier: AuthVerifier | undefined;
  const verify = (token: string) =>
    (_verifier ??= createAuthVerifier({ isRevoked: config.isRevoked })).verifyToken(token);

  // Per-pod single-flight: collapse concurrent read-misses for the same user into ONE hub fetch, so a cache
  // bust / cold cache doesn't fan out into N identical HTTP hops to the hub (stampede protection). One map per
  // read path (token vs userId) — they hit the same shared cache key but are keyed/fetched differently.
  const inflight = new Map<number, Promise<SessionUser | null>>();
  const inflightById = new Map<number, Promise<SessionUser | null>>();

  // Shared-cache read for `session:data2:{userId}`, fail-open (a blip falls through to the hub fetch). The
  // `clearedAt` tombstone + non-object guard mirror the token path. Returns undefined on miss/blip.
  async function readCachedUser(userId: number): Promise<SessionUser | null | undefined> {
    try {
      const cached = await getCacheRedis().packed.get<SessionUser>(sessionCacheKey(userId));
      return cached && typeof cached === 'object' && !('clearedAt' in cached) ? cached : undefined;
    } catch {
      return undefined;
    }
  }

  async function getSessionUser(token: string): Promise<SessionUser | null> {
    const claims = await verify(token);
    if (!claims) return null;
    const userId = Number(claims.sub);
    if (!Number.isFinite(userId)) return null;

    // 1. Shared-cache read — fail-open: a cache blip falls through to the hub fetch rather than throwing.
    const cached = await readCachedUser(userId);
    if (cached) return cached;

    // 2. Single-flight the miss → hub identity fetch. The hub URL is the VERIFIED token's issuer.
    const existing = inflight.get(userId);
    if (existing) return existing;
    const baseUrl = claims.iss;
    const p = (async () => {
      if (!baseUrl) return null; // no issuer to resolve against
      try {
        return await fetchIdentity(baseUrl, token);
      } catch {
        return null; // hub unreachable — appear unauthenticated (the warm cache covers the normal path)
      }
    })().finally(() => inflight.delete(userId));
    inflight.set(userId, p);
    return p;
  }

  // READ-THROUGH by userId — for consumer paths with no session token (API-key/bearer auth, legacy cookie).
  // Shared-cache read → single-flight the miss to the INTERNAL-authed GET identity?userId= (read-through, NOT
  // a bust — refresh() is the bust path). The hub URL is AUTH_JWT_ISSUER (no token whose `iss` to read).
  async function getSessionUserById(userId: number): Promise<SessionUser | null> {
    if (!Number.isFinite(userId)) return null;
    const cached = await readCachedUser(userId);
    if (cached) return cached;

    const existing = inflightById.get(userId);
    if (existing) return existing;
    const p = (async () => {
      const internal = loadAuthEnv().AUTH_INTERNAL_TOKEN; // by-userId read is service-authed (no user token)
      if (!internal) return null;
      try {
        const res = await hubFetch(`/api/auth/identity?userId=${userId}`, {
          headers: { authorization: `Bearer ${internal}` },
        });
        if (!res.ok) return null; // 401 (bad secret) / 404 (no such user) / 5xx → treat as unauthenticated
        return (await res.json()) as SessionUser;
      } catch {
        return null; // hub unreachable / not configured
      }
    })().finally(() => inflightById.delete(userId));
    inflightById.set(userId, p);
    return p;
  }

  // WRITE: POST the hub's /api/auth/identity (service-authed) to bust (and optionally re-produce). Targets
  // an arbitrary userId, so it's authed by AUTH_INTERNAL_TOKEN — not a user session token.
  async function postInvalidate(userId: number, reproduce: boolean): Promise<SessionUser | null> {
    const token = loadAuthEnv().AUTH_INTERNAL_TOKEN; // shared service secret
    if (!token)
      throw new Error('[@civitai/auth] createSessionClient: AUTH_INTERNAL_TOKEN is not set');

    const res = await hubFetch('/api/auth/identity', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userId, refresh: reproduce }), // `refresh` is the hub's wire field
    });
    if (!res.ok) throw new Error(`[@civitai/auth] session invalidate failed: ${res.status}`);
    if (!reproduce) return null;
    return ((await res.json()) ?? null) as SessionUser | null;
  }

  return {
    getSessionUser,
    getSessionUserById,
    invalidate: (userId) => postInvalidate(userId, false).then(() => undefined),
    refresh: (userId) => postInvalidate(userId, true),
  };
}

/** Read source: GET `{iss}/api/auth/identity` with the session token as a Bearer. */
async function fetchIdentity(baseUrl: string, token: string): Promise<SessionUser | null> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/auth/identity`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 404) return null; // not authenticated / no such user
  if (!res.ok) throw new Error(`[@civitai/auth] identity fetch failed: ${res.status}`);
  return (await res.json()) as SessionUser;
}
