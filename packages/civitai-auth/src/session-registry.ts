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
  /** Required only for the per-user token ceiling; without it trackToken never evicts. */
  hLen?(key: string): Promise<number>;
  /** Ditto — the ceiling reads a BOUNDED PAGE, never the whole hash (it runs on the login hot path). */
  hScan?(
    key: string,
    cursor: number,
    options?: { COUNT?: number }
  ): Promise<{ cursor: number; tuples: Array<{ field: string; value: string }> }>;
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
  /** Max tracked sessions per user before the oldest are evicted-and-revoked (default 500). */
  maxTokensPerUser?: number;
  /** Cap on evictions in a single trackToken call, so draining a huge legacy hash can't burst (default 50). */
  maxEvictionsPerTrack?: number;
  /** Called when tokens are evicted for exceeding the ceiling — wire to a metric. */
  onEvict?: (info: { userId: number; evicted: number; total: number }) => void;
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
// 500 is ~87x the observed mean tracked-token count and above 99.9% of accounts, while leaving an 8x margin
// under the ~4000 field count at which the multi-field token-state write exceeds Lua's unpack limit and
// silently lands nothing (see src/server/redis/atomic.ts).
const DEFAULT_MAX_TOKENS_PER_USER = 500;
const DEFAULT_MAX_EVICTIONS_PER_TRACK = 50;
// Concurrency bound for the ban fan-out (individual commands, not a Lua batch).
const INVALIDATE_BATCH = 100;

export function createSessionRegistry(config: SessionRegistryConfig): SessionRegistry {
  const { keys } = config;
  const ttl = config.ttlSeconds ?? DEFAULT_TTL;
  const maxTokens = config.maxTokensPerUser ?? DEFAULT_MAX_TOKENS_PER_USER;
  const maxEvictions = config.maxEvictionsPerTrack ?? DEFAULT_MAX_EVICTIONS_PER_TRACK;
  const now = config.now ?? (() => Date.now());
  const { redis } = config;
  const userTokensKey = (userId: number) => `${keys.userTokens}:${userId}`;

  async function setState(tokenId: string, state: 'invalid' | 'refresh') {
    await redis.hSet(keys.tokenState, tokenId, state);
    if (redis.hExpire) await redis.hExpire(keys.tokenState, tokenId, ttl);
  }

  async function trackToken(tokenId: string, userId: number) {
    await evictOverCeiling(userId);
    await redis.hSet(userTokensKey(userId), tokenId, now());
    if (redis.hExpire) await redis.hExpire(userTokensKey(userId), tokenId, ttl);
  }

  /**
   * Keep a user's tracked-token hash bounded, by EVICTING AND REVOKING the oldest entries.
   *
   * Refusing to track would be the simpler shape and is wrong: trackToken runs AFTER the token is signed
   * and returned, so an untracked session is one no ban can ever find. Evicting alone has a smaller version
   * of the same flaw — an evicted jti stays validly signed for the rest of `ttl` — so each eviction writes
   * `invalid` to the token-state hash that isRevoked consults. The evicted session dies rather than escaping.
   *
   * Bounded three ways, because this runs on the login hot path against a single-threaded shared store:
   *   - one HLEN in the ordinary case; the hash is not read at all below the ceiling;
   *   - the read is ONE BOUNDED HSCAN PAGE, never the whole hash. A full read would cost ~1 µs/field
   *     server-side, so a hash that grew to 53k under the old unbounded behaviour would block sysRedis ~54 ms
   *     per login — and repeat it on every login until the hash drained, which is the drain mechanism's cost
   *     scaling with the problem it is draining;
   *   - at most `maxEvictionsPerTrack` evictions per call, so an oversized hash drains over many logins.
   *
   * Page size is the ceiling itself, which makes the ordering EXACT in the steady state (at ~500 fields one
   * page is the whole hash) and approximate only for a hash still oversized from before this existed. That
   * degradation is safe: the values are LAST-TOUCH times (trackToken re-writes the value on every call,
   * including the rolling refresh), so this is LRU, not FIFO — an actively-used old session keeps a fresh
   * value and survives. Evicting page-locally can only pick a less-recently-used entry than the global
   * oldest, never an active one over an idle one within the page.
   */
  async function evictOverCeiling(userId: number) {
    if (!redis.hLen || !redis.hScan || maxTokens <= 0) return;
    const key = userTokensKey(userId);
    const total = await redis.hLen(key);
    if (total < maxTokens) return;

    const page = await redis.hScan(key, 0, { COUNT: maxTokens });
    // Ascending by last-touch = least-recently-used first. A non-numeric value sorts as 0, i.e. goes first —
    // the safe direction for an entry we cannot date.
    const entries = page.tuples
      .slice()
      .sort((a, b) => (Number(a.value) || 0) - (Number(b.value) || 0));
    const evicting = entries
      .slice(0, Math.min(total - maxTokens + 1, maxEvictions))
      .map(({ field }) => field);
    if (!evicting.length) return;

    for (const evictedId of evicting) {
      await setState(evictedId, 'invalid');
      await redis.hDel(key, evictedId);
    }
    config.onEvict?.({ userId, evicted: evicting.length, total });
  }

  async function invalidateToken(tokenId: string, userId?: number) {
    await setState(tokenId, 'invalid');
    if (userId != null) await redis.hDel(userTokensKey(userId), tokenId);
    await config.onInvalidate?.({ scope: 'token', tokenId, userId });
  }

  async function invalidateUserSessions(userId: number) {
    if (!redis.hGetAll)
      throw new Error('[@civitai/auth] invalidateUserSessions requires redis.hGetAll');
    const key = userTokensKey(userId);
    const tokenIds = Object.keys(await redis.hGetAll(key));
    // Batched rather than one Promise.all over every token: this issues individual commands (no Lua, so no
    // unpack ceiling), and an unbounded fan-out on an account with tens of thousands of tracked tokens would
    // put that many concurrent commands on the shared auth store in one go.
    for (let i = 0; i < tokenIds.length; i += INVALIDATE_BATCH) {
      await Promise.all(
        tokenIds.slice(i, i + INVALIDATE_BATCH).map(async (tokenId) => {
          // Order matters: the revocation marker must land BEFORE the tracking entry goes. A token dropped
          // from the hash without an `invalid` marker is one no later ban can find — still validly signed for
          // the rest of its TTL, and now invisible. Awaiting setState first means a throw skips the hDel.
          await setState(tokenId, 'invalid');
          await redis.hDel(key, tokenId);
        })
      );
    }
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
