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
