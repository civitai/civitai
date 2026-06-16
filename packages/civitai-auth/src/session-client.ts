import { createAuthVerifier, type AuthVerifier } from './verify';
import { loadAuthEnv } from './env';
import { hubBaseUrl } from './hub';
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
  // bust / cold cache doesn't fan out into N identical HTTP hops to the hub (stampede protection).
  const inflight = new Map<number, Promise<SessionUser | null>>();

  async function getSessionUser(token: string): Promise<SessionUser | null> {
    const claims = await verify(token);
    if (!claims) return null;
    const userId = Number(claims.sub);
    if (!Number.isFinite(userId)) return null;

    // 1. Shared-cache read — fail-open: a cache blip falls through to the hub fetch rather than throwing.
    let cached: SessionUser | null | undefined;
    try {
      cached = await getCacheRedis().packed.get<SessionUser>(sessionCacheKey(userId));
    } catch {
      cached = null;
    }
    // `clearedAt` marks a tombstoned entry — treat as a miss. The `typeof === 'object'` guard also
    // prevents an `in`-operator TypeError on a non-object value.
    if (cached && typeof cached === 'object' && !('clearedAt' in cached)) return cached;

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

  // WRITE: POST the hub's /api/auth/identity (service-authed) to bust (and optionally re-produce). Targets
  // an arbitrary userId, so it's authed by AUTH_INTERNAL_TOKEN — not a user session token.
  async function postInvalidate(userId: number, reproduce: boolean): Promise<SessionUser | null> {
    const base = hubBaseUrl();
    const token = loadAuthEnv().AUTH_INTERNAL_TOKEN; // shared service secret
    if (!base) throw new Error('[@civitai/auth] createSessionClient: AUTH_JWT_ISSUER is not set');
    if (!token) throw new Error('[@civitai/auth] createSessionClient: AUTH_INTERNAL_TOKEN is not set');

    const res = await fetch(`${base}/api/auth/identity`, {
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
