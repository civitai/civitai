import { describe, it, expect, vi } from 'vitest';
import { createSessionRegistry, type SessionRegistryRedis } from '../session-registry';

// Keys are injected (from @civitai/redis in real usage). Use the real values so the assertions
// double as a check that the registry composes them correctly.
const KEYS = {
  tokenState: 'session:token-state',
  userTokens: 'session:user-tokens2',
  all: 'session:all',
};

// In-memory redis mock implementing the SessionRegistryRedis surface.
function makeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const strings = new Map<string, string>();
  const h = (k: string) => hashes.get(k) ?? (hashes.set(k, new Map()), hashes.get(k)!);
  const redis: SessionRegistryRedis & { _hashes: typeof hashes; _strings: typeof strings } = {
    _hashes: hashes,
    _strings: strings,
    async hSet(key, field, value) {
      h(key).set(field, String(value));
    },
    async hGet(key, field) {
      return hashes.get(key)?.get(field) ?? null;
    },
    async hDel(key, field) {
      hashes.get(key)?.delete(field);
    },
    async hGetAll(key) {
      return Object.fromEntries(hashes.get(key) ?? []);
    },
    async hExpire() {},
    async hLen(key) {
      return hashes.get(key)?.size ?? 0;
    },
    // Models the real client closely enough for the ceiling: COUNT bounds the page, and insertion order
    // stands in for redis's bucket order — neither is guaranteed to be value-ordered, which is the property
    // the eviction logic must not depend on.
    async hScan(key, _cursor, options) {
      const all = [...(hashes.get(key) ?? [])].map(([field, value]) => ({ field, value }));
      const page = all.slice(0, options?.COUNT ?? all.length);
      return { cursor: page.length < all.length ? 1 : 0, tuples: page };
    },
    async get(key) {
      return strings.get(key) ?? null;
    },
    async set(key, value) {
      strings.set(key, value);
    },
  };
  return redis;
}

describe('createSessionRegistry', () => {
  it('tracks then invalidates a single token', async () => {
    const redis = makeRedis();
    const reg = createSessionRegistry({ redis, keys: KEYS });
    await reg.trackToken('tok-1', 5);
    expect(await reg.isRevoked({ jti: 'tok-1', signedAt: 1 })).toBe(false);

    await reg.invalidateToken('tok-1', 5);
    expect(await reg.isRevoked({ jti: 'tok-1', signedAt: 1 })).toBe(true);
    // removed from the user's tracking hash
    expect(redis._hashes.get('session:user-tokens2:5')?.has('tok-1')).toBe(false);
  });

  it("invalidates all of a user's sessions (ban)", async () => {
    const redis = makeRedis();
    const reg = createSessionRegistry({ redis, keys: KEYS });
    await reg.trackToken('a', 9);
    await reg.trackToken('b', 9);
    await reg.invalidateUserSessions(9);
    expect(await reg.isRevoked({ jti: 'a', signedAt: 1 })).toBe(true);
    expect(await reg.isRevoked({ jti: 'b', signedAt: 1 })).toBe(true);
    // …and the tracking hash is emptied, matching what logout already did per-token. Left behind, a banned
    // account keeps its full-size hash for the whole TTL and every later pass over it pays for tokens that
    // are already revoked.
    expect(redis._hashes.get('session:user-tokens2:9')?.size ?? 0).toBe(0);
  });

  it('never drops a tracking entry whose revocation marker failed to land', async () => {
    const redis = makeRedis();
    const realHSet = redis.hSet.bind(redis);
    redis.hSet = async (key, field, value) => {
      if (key === KEYS.tokenState && field === 'b') throw new Error('sysredis blip');
      return realHSet(key, field, value);
    };
    const reg = createSessionRegistry({ redis, keys: KEYS });
    await reg.trackToken('a', 11);
    await reg.trackToken('b', 11);

    await expect(reg.invalidateUserSessions(11)).rejects.toThrow('sysredis blip');
    // 'b' was never marked invalid, so it MUST still be tracked — otherwise it is a validly signed token
    // that no later ban can find.
    expect(redis._hashes.get('session:user-tokens2:11')?.has('b')).toBe(true);
  });

  it('global invalidateAll revokes tokens signed before the cutoff', async () => {
    let clock = 1000;
    const redis = makeRedis();
    const reg = createSessionRegistry({ redis, keys: KEYS, now: () => clock });
    expect(await reg.isRevoked({ jti: 'x', signedAt: 1000 })).toBe(false);

    clock = 2000;
    await reg.invalidateAll();
    expect(await reg.isRevoked({ jti: 'x', signedAt: 1000 })).toBe(true); // signed before cutoff
    expect(await reg.isRevoked({ jti: 'y', signedAt: 3000 })).toBe(false); // signed after
  });

  it('markForRefresh does not revoke', async () => {
    const redis = makeRedis();
    const reg = createSessionRegistry({ redis, keys: KEYS });
    await reg.markForRefresh('r');
    expect(await reg.isRevoked({ jti: 'r', signedAt: 1 })).toBe(false);
  });

  it('fires onInvalidate with scope info', async () => {
    const redis = makeRedis();
    const onInvalidate = vi.fn();
    const reg = createSessionRegistry({ redis, keys: KEYS, onInvalidate });
    await reg.invalidateToken('z');
    expect(onInvalidate).toHaveBeenCalledWith({ scope: 'token', tokenId: 'z', userId: undefined });
  });

  it('isRevoked is false for a token with no id', async () => {
    const reg = createSessionRegistry({ redis: makeRedis(), keys: KEYS });
    expect(await reg.isRevoked({})).toBe(false);
  });

  describe('per-user token ceiling', () => {
    const seed = async (redis: ReturnType<typeof makeRedis>, userId: number, count: number) => {
      for (let i = 0; i < count; i++)
        await redis.hSet(`session:user-tokens2:${userId}`, `tok-${i}`, 1000 + i);
    };

    it('does not evict below the ceiling', async () => {
      const redis = makeRedis();
      const onEvict = vi.fn();
      const reg = createSessionRegistry({ redis, keys: KEYS, maxTokensPerUser: 5, onEvict });
      await seed(redis, 7, 3);
      await reg.trackToken('new', 7);
      expect(redis._hashes.get('session:user-tokens2:7')?.size).toBe(4);
      expect(onEvict).not.toHaveBeenCalled();
    });

    it('evicts the OLDEST and keeps the hash at the ceiling', async () => {
      const redis = makeRedis();
      const reg = createSessionRegistry({ redis, keys: KEYS, maxTokensPerUser: 5 });
      await seed(redis, 7, 5);
      await reg.trackToken('new', 7);

      const hash = redis._hashes.get('session:user-tokens2:7')!;
      expect(hash.size).toBe(5);
      expect(hash.has('tok-0')).toBe(false); // oldest value (1000) went
      expect(hash.has('tok-4')).toBe(true);
      expect(hash.has('new')).toBe(true);
    });

    // The whole point of evict-AND-revoke: an evicted jti is still a validly signed token, so dropping
    // it from the tracking hash without marking it invalid would make it permanently unrevokable.
    it('REVOKES what it evicts', async () => {
      const redis = makeRedis();
      const reg = createSessionRegistry({ redis, keys: KEYS, maxTokensPerUser: 5 });
      await seed(redis, 7, 5);
      await reg.trackToken('new', 7);

      expect(await reg.isRevoked({ jti: 'tok-0', signedAt: 1 })).toBe(true);
      expect(await reg.isRevoked({ jti: 'new', signedAt: 1 })).toBe(false);
    });

    it('caps evictions per call so a huge legacy hash drains gradually', async () => {
      const redis = makeRedis();
      const onEvict = vi.fn();
      const reg = createSessionRegistry({
        redis,
        keys: KEYS,
        maxTokensPerUser: 5,
        maxEvictionsPerTrack: 2,
        onEvict,
      });
      await seed(redis, 7, 100);
      await reg.trackToken('new', 7);

      expect(redis._hashes.get('session:user-tokens2:7')?.size).toBe(99); // 100 - 2 evicted + 1 new
      expect(onEvict).toHaveBeenCalledWith({ userId: 7, evicted: 2, total: 100 });
    });

    // The read is on the login hot path against a single-threaded shared store. Reading the whole hash would
    // cost ~54ms server-side on the largest real account (53,877 fields at ~1 µs/field) and repeat on every
    // login until it drained. The page must stay bounded by the ceiling regardless of hash size.
    it('reads only a BOUNDED PAGE, never the whole hash', async () => {
      const redis = makeRedis();
      const scan = vi.spyOn(redis, 'hScan');
      const reg = createSessionRegistry({ redis, keys: KEYS, maxTokensPerUser: 5 });
      await seed(redis, 7, 5000);
      await reg.trackToken('new', 7);

      expect(scan).toHaveBeenCalledTimes(1);
      expect(scan.mock.calls[0][2]).toMatchObject({ COUNT: 5 });
    });

    it('evicts the least-recently-touched within the page, not whatever the page yields first', async () => {
      const redis = makeRedis();
      const reg = createSessionRegistry({ redis, keys: KEYS, maxTokensPerUser: 3 });
      // Insertion order deliberately disagrees with recency: the FIRST field scanned is the freshest.
      await redis.hSet('session:user-tokens2:7', 'fresh', 9000);
      await redis.hSet('session:user-tokens2:7', 'stale', 1000);
      await redis.hSet('session:user-tokens2:7', 'mid', 5000);
      await reg.trackToken('new', 7);

      const hash = redis._hashes.get('session:user-tokens2:7')!;
      expect(hash.has('stale')).toBe(false);
      expect(hash.has('fresh')).toBe(true);
      expect(await reg.isRevoked({ jti: 'stale', signedAt: 1 })).toBe(true);
    });

    // 🔴 The regression this guards. The stored value is a last-WRITE time, and a live session only rewrites
    // it when the spoke's rolling refresh fires (AUTH_SESSION_UPDATE_AGE, 24h default). An account minting
    // rapidly writes fresher values continuously, so ordering ALONE sorts the real session below hundreds of
    // minted-and-abandoned tokens and evicts — and revokes — the user. Reported by charlie on #3754.
    describe('age floor', () => {
      const HOUR = 3600_000;

      it('does NOT evict a session refreshed 14h ago, even when it is the oldest in the page', async () => {
        const redis = makeRedis();
        const clock = 1_000_000_000_000;
        const reg = createSessionRegistry({
          redis,
          keys: KEYS,
          maxTokensPerUser: 5,
          now: () => clock,
        });
        // The shape of a still-minting account: one real session refreshed 14h ago, junk minted in the last
        // hour. Under pure ordering the real session sorts first and dies.
        await redis.hSet('session:user-tokens2:7', 'real-session', clock - 14 * HOUR);
        for (let i = 0; i < 5; i++)
          await redis.hSet(`session:user-tokens2:7`, `junk-${i}`, clock - i * 60_000);

        await reg.trackToken('new', 7);

        expect(redis._hashes.get('session:user-tokens2:7')?.has('real-session')).toBe(true);
        expect(await reg.isRevoked({ jti: 'real-session', signedAt: 1 })).toBe(false);
      });

      it('evicts nothing at all when the whole page is inside the floor, rather than picking a victim', async () => {
        const redis = makeRedis();
        const clock = 1_000_000_000_000;
        const onEvict = vi.fn();
        const reg = createSessionRegistry({
          redis,
          keys: KEYS,
          maxTokensPerUser: 3,
          now: () => clock,
          onEvict,
        });
        for (let i = 0; i < 6; i++)
          await redis.hSet(`session:user-tokens2:7`, `recent-${i}`, clock - i * HOUR);

        await reg.trackToken('new', 7);

        expect(redis._hashes.get('session:user-tokens2:7')?.size).toBe(7); // over the ceiling, deliberately
        expect(onEvict).toHaveBeenCalledWith({ userId: 7, evicted: 0, total: 6 });
      });

      it('still evicts entries past the floor, so an oversized hash does drain', async () => {
        const redis = makeRedis();
        const clock = 1_000_000_000_000;
        const reg = createSessionRegistry({
          redis,
          keys: KEYS,
          maxTokensPerUser: 3,
          now: () => clock,
        });
        // 4 entries against a ceiling of 3 means 2 evictions. Three are past the floor, so the ordering has
        // to choose: the two oldest go and the third stays.
        await redis.hSet('session:user-tokens2:7', 'ancient', clock - 20 * 24 * HOUR);
        await redis.hSet('session:user-tokens2:7', 'mid', clock - 10 * 24 * HOUR);
        await redis.hSet('session:user-tokens2:7', 'old', clock - 5 * 24 * HOUR);
        await redis.hSet('session:user-tokens2:7', 'fresh', clock - HOUR);

        await reg.trackToken('new', 7);

        const hash = redis._hashes.get('session:user-tokens2:7')!;
        expect(hash.has('ancient')).toBe(false); // oldest past the floor
        expect(hash.has('mid')).toBe(false); // second-oldest
        expect(hash.has('old')).toBe(true); // past the floor but not needed
        expect(hash.has('fresh')).toBe(true); // inside the floor, never a candidate
        expect(await reg.isRevoked({ jti: 'ancient', signedAt: 1 })).toBe(true);
      });

      // The floor's whole guarantee is that it outlasts the spokes' rolling-refresh interval. That was a
      // docstring requirement across an app boundary — AUTH_SESSION_UPDATE_AGE lives in the main app, the
      // floor default lives here — so lengthening the interval would have silently made live sessions
      // evictable again with no error and no failing test. It is now enforced.
      it('raises the floor to outlast a longer refresh interval, ignoring a too-small configured floor', async () => {
        const redis = makeRedis();
        const clock = 1_000_000_000_000;
        const reg = createSessionRegistry({
          redis,
          keys: KEYS,
          maxTokensPerUser: 2,
          now: () => clock,
          minEvictionAgeSeconds: 60, // would make a 4-day-old live session evictable…
          refreshIntervalSeconds: 7 * 24 * 3600, // …but the deployment refreshes only weekly
        });
        await redis.hSet('session:user-tokens2:7', 'refreshed-4d-ago', clock - 4 * 24 * HOUR);
        await redis.hSet('session:user-tokens2:7', 'refreshed-6d-ago', clock - 6 * 24 * HOUR);

        await reg.trackToken('new', 7);

        expect(redis._hashes.get('session:user-tokens2:7')?.has('refreshed-4d-ago')).toBe(true);
        expect(redis._hashes.get('session:user-tokens2:7')?.has('refreshed-6d-ago')).toBe(true);
        expect(await reg.isRevoked({ jti: 'refreshed-6d-ago', signedAt: 1 })).toBe(false);
      });

      // charlie also noted the committed page-local test used a 3-entry hash a single page covers, so it never
      // exercised a global-oldest sitting OUTSIDE the page. This does.
      it('is safe when the global oldest is outside the scanned page', async () => {
        const redis = makeRedis();
        const clock = 1_000_000_000_000;
        const reg = createSessionRegistry({
          redis,
          keys: KEYS,
          maxTokensPerUser: 2,
          now: () => clock,
        });
        // Page holds the first 2 by insertion order; the globally-oldest entry is inserted last, so it is
        // NOT in the page. Eviction must still only take something past the floor.
        await redis.hSet('session:user-tokens2:7', 'in-page-stale', clock - 10 * 24 * HOUR);
        await redis.hSet('session:user-tokens2:7', 'in-page-live', clock - HOUR);
        await redis.hSet('session:user-tokens2:7', 'out-of-page-oldest', clock - 25 * 24 * HOUR);

        await reg.trackToken('new', 7);

        const hash = redis._hashes.get('session:user-tokens2:7')!;
        expect(hash.has('in-page-stale')).toBe(false); // the page-local candidate past the floor
        expect(hash.has('in-page-live')).toBe(true); // never a candidate
        expect(hash.has('out-of-page-oldest')).toBe(true); // not read, so not evicted — and that is fine
      });
    });

    it('never evicts when the redis surface lacks hLen', async () => {
      const redis = makeRedis();
      delete (redis as { hLen?: unknown }).hLen;
      const reg = createSessionRegistry({ redis, keys: KEYS, maxTokensPerUser: 2 });
      await seed(redis, 7, 5);
      await reg.trackToken('new', 7);
      expect(redis._hashes.get('session:user-tokens2:7')?.size).toBe(6);
    });
  });

  it('uses the injected key namespaces', async () => {
    const redis = makeRedis();
    const reg = createSessionRegistry({ redis, keys: { ...KEYS, tokenState: 'custom:state' } });
    await reg.invalidateToken('q');
    expect(redis._hashes.get('custom:state')?.get('q')).toBe('invalid');
  });
});
