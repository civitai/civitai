import type { SessionClaims } from './types';

// The revocation/refresh MARKER PROTOCOL — a shared redis contract: spokes READ it (isRevoked),
// the hub WRITES it (track on issue, invalidate on logout), moderation WRITES it (ban → invalidate
// all of a user's sessions). Owning it here keeps that contract identical across apps.
//
// redis is INJECTED (the package stays infra-free); app side-effects (realtime signal, cache
// clear, orchestrator invalidation) are injected via onInvalidate. User re-fetch is NOT here —
// that's the app's model (resolveUser), see the package README/types.

/** Minimal redis surface needed — satisfied by @civitai/redis's client (or any compatible one). */
export interface SessionRegistryRedis {
  hSet(key: string, field: string, value: string | number): Promise<unknown>;
  hGet(key: string, field: string): Promise<string | null | undefined>;
  hDel(key: string, field: string): Promise<unknown>;
  /** Required only for invalidateUserSessions (reads a user's tracked token ids). */
  hGetAll?(key: string): Promise<Record<string, unknown>>;
  hExpire?(key: string, field: string, seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string, opts?: { EX?: number }): Promise<unknown>;
}

export type InvalidateInfo = { scope: 'token' | 'user' | 'all'; tokenId?: string; userId?: number };

/** Redis key namespaces — INJECTED from @civitai/redis (REDIS_SYS_KEYS.SESSION.TOKEN_STATE / .ALL,
 *  REDIS_KEYS.SESSION.USER_TOKENS), never re-declared here, so there's one source of truth. */
export interface SessionKeys {
  tokenState: string;
  userTokens: string;
  all: string;
}

export interface SessionRegistryConfig {
  redis: SessionRegistryRedis;
  /** Redis key namespaces, from @civitai/redis's REDIS_(SYS_)KEYS. */
  keys: SessionKeys;
  /** Token-tracking + marker TTL in seconds (default 30d). */
  ttlSeconds?: number;
  /** App side-effects to run after an invalidation (signal, cache clear, orchestrator). */
  onInvalidate?: (info: InvalidateInfo) => void | Promise<void>;
  /** Clock injection (tests). */
  now?: () => number;
}

export interface SessionRegistry {
  /** Record an issued token so it can later be invalidated (call on session issue). */
  trackToken(tokenId: string, userId: number): Promise<void>;
  /** Mark a single session invalid (logout). */
  invalidateToken(tokenId: string, userId?: number): Promise<void>;
  /** Mark every tracked session for a user invalid (ban). Requires redis.hGetAll. */
  invalidateUserSessions(userId: number): Promise<void>;
  /** Global cutoff — revokes every token signed before now (mass logout). */
  invalidateAll(): Promise<void>;
  /** Flag a token for re-mint (not a revoke). */
  markForRefresh(tokenId: string): Promise<void>;
  /** The canonical revocation read — wire this into createAuthVerifier({ isRevoked }). */
  isRevoked(claims: SessionClaims): Promise<boolean>;
}

const DEFAULT_TTL = 30 * 24 * 60 * 60;

export function createSessionRegistry(config: SessionRegistryConfig): SessionRegistry {
  const { keys } = config;
  const ttl = config.ttlSeconds ?? DEFAULT_TTL;
  const now = config.now ?? (() => Date.now());
  const { redis } = config;
  const userTokensKey = (userId: number) => `${keys.userTokens}:${userId}`;

  async function setState(tokenId: string, state: 'invalid' | 'refresh') {
    await redis.hSet(keys.tokenState, tokenId, state);
    if (redis.hExpire) await redis.hExpire(keys.tokenState, tokenId, ttl);
  }

  async function trackToken(tokenId: string, userId: number) {
    await redis.hSet(userTokensKey(userId), tokenId, now());
    if (redis.hExpire) await redis.hExpire(userTokensKey(userId), tokenId, ttl);
  }

  async function invalidateToken(tokenId: string, userId?: number) {
    await setState(tokenId, 'invalid');
    if (userId != null) await redis.hDel(userTokensKey(userId), tokenId);
    await config.onInvalidate?.({ scope: 'token', tokenId, userId });
  }

  async function invalidateUserSessions(userId: number) {
    if (!redis.hGetAll)
      throw new Error('[@civitai/auth] invalidateUserSessions requires redis.hGetAll');
    const tokenIds = Object.keys(await redis.hGetAll(userTokensKey(userId)));
    await Promise.all(tokenIds.map((t) => setState(t, 'invalid')));
    await config.onInvalidate?.({ scope: 'user', userId });
  }

  async function invalidateAll() {
    // TTL the cutoff marker (matches the main app's prior EX): it only revokes tokens signed before it, which
    // all expire within `ttl` anyway, so the marker self-cleans rather than lingering forever.
    await redis.set(keys.all, new Date(now()).toISOString(), { EX: ttl });
    await config.onInvalidate?.({ scope: 'all' });
  }

  async function markForRefresh(tokenId: string) {
    await setState(tokenId, 'refresh');
  }

  async function isRevoked(claims: SessionClaims): Promise<boolean> {
    const tokenId = claims.jti;
    if (!tokenId) return false;
    const [state, allStr] = await Promise.all([
      redis.hGet(keys.tokenState, tokenId),
      redis.get(keys.all),
    ]);
    if (state === 'invalid') return true;
    if (allStr && claims.signedAt && new Date(allStr).getTime() > claims.signedAt) return true;
    return false;
  }

  return {
    trackToken,
    invalidateToken,
    invalidateUserSessions,
    invalidateAll,
    markForRefresh,
    isRevoked,
  };
}
