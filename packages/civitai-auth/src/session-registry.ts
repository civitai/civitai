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
  /** Entries touched more recently than this are never evicted (default 3d). Must exceed the spokes'
   *  rolling-refresh interval, which is the coarsest granularity at which a live session is re-touched. */
  minEvictionAgeSeconds?: number;
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
// 500 is ~87x the observed mean tracked-token count and above 99.9% of accounts.
const DEFAULT_MAX_TOKENS_PER_USER = 500;
const DEFAULT_MAX_EVICTIONS_PER_TRACK = 50;
// Nothing touched within this window is ever evicted — see evictOverCeiling. It must stay comfortably above
// the spokes' rolling-refresh interval (AUTH_SESSION_UPDATE_AGE, default 24h), because that interval is the
// coarsest granularity at which a live session updates its entry.
const DEFAULT_MIN_EVICTION_AGE_SECONDS = 3 * 24 * 60 * 60;
// Concurrency bound for the ban fan-out (individual commands, not a Lua batch).
const INVALIDATE_BATCH = 100;

export function createSessionRegistry(config: SessionRegistryConfig): SessionRegistry {
  const { keys } = config;
  const ttl = config.ttlSeconds ?? DEFAULT_TTL;
  const maxTokens = config.maxTokensPerUser ?? DEFAULT_MAX_TOKENS_PER_USER;
  const maxEvictions = config.maxEvictionsPerTrack ?? DEFAULT_MAX_EVICTIONS_PER_TRACK;
  const minEvictionAge = config.minEvictionAgeSeconds ?? DEFAULT_MIN_EVICTION_AGE_SECONDS;
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
   * 🔴 The safety property is the AGE FLOOR, not the ordering. Nothing whose entry was touched within
   * `minEvictionAgeSeconds` is ever evicted, whatever the sort says.
   *
   * Sorting by the stored value alone is NOT sufficient and reasoning about it as LRU is wrong. The value is
   * a last-WRITE time, and a live session only rewrites it when the spoke's rolling refresh fires — every
   * AUTH_SESSION_UPDATE_AGE, 24h by default. An account minting rapidly writes fresher values continuously,
   * so a genuinely-in-use session that refreshed 14h ago sorts BELOW hundreds of tokens minted-and-abandoned
   * in the last hour. Ordering alone would therefore evict — and revoke — the real session and keep the junk,
   * and it would do so precisely on the accounts where eviction fires, because a high mint rate is what
   * pushes an account over the ceiling in the first place.
   *
   * The age floor removes that entirely: an entry older than the floor cannot belong to a session whose
   * client is still refreshing it. The cost is that the hash only drains down to roughly
   * (mint rate x floor) while a runaway minter is still running, rather than to the ceiling — correctness
   * over tightness. It reaches the ceiling once the minting itself is fixed.
   *
   * Bounded three ways, because this runs on the login hot path against a single-threaded shared store:
   *   - one HLEN in the ordinary case; the hash is not read at all below the ceiling;
   *   - the read is ONE BOUNDED HSCAN PAGE, never the whole hash. A full read costs ~1 µs/field server-side,
   *     so a hash that grew to 53k under the old unbounded behaviour would block the shared store ~54 ms per
   *     login and repeat it every login until drained — the drain's cost scaling with the damage it drains;
   *   - at most `maxEvictionsPerTrack` evictions per call, so an oversized hash drains over many logins.
   *
   * Page size is the ceiling, so in the steady state one page is the whole hash. For a still-oversized hash
   * the page is a subset and eviction is page-local; that is acceptable because the age floor — not the
   * ordering — is what protects live sessions.
   */
  async function evictOverCeiling(userId: number) {
    if (!redis.hLen || !redis.hScan || maxTokens <= 0) return;
    const key = userTokensKey(userId);
    const total = await redis.hLen(key);
    if (total < maxTokens) return;

    const page = await redis.hScan(key, 0, { COUNT: maxTokens });
    // The age floor, applied BEFORE any ordering decision — an entry touched within it may belong to a live
    // session, so it is not a candidate at all. A non-numeric value dates to 0, i.e. is always old enough,
    // which is the safe direction for an entry we cannot date.
    const floor = now() - minEvictionAge * 1000;
    const candidates = page.tuples.filter(({ value }) => (Number(value) || 0) < floor);
    // Oldest first among candidates. This only chooses WHICH stale entry goes; it never makes a live one
    // eligible.
    candidates.sort((a, b) => (Number(a.value) || 0) - (Number(b.value) || 0));
    const evicting = candidates
      .slice(0, Math.min(total - maxTokens + 1, maxEvictions))
      .map(({ field }) => field);
    // Nothing in the page is old enough: the hash stays over the ceiling this call rather than revoking a
    // session that might be in use. Reported so a persistently-over-ceiling account is visible.
    if (!evicting.length) {
      config.onEvict?.({ userId, evicted: 0, total });
      return;
    }

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
    // NOTE: this read is still the whole hash. That is tolerable only because this path is rare (ban / mass
    // logout) rather than per-login; it has not been given trackToken's bounded-page treatment.
    // Batched rather than one Promise.all over every token: an unbounded fan-out on an account with tens of
    // thousands of tracked tokens would put that many concurrent commands on the shared auth store at once.
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
