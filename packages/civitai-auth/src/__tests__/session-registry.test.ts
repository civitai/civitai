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

  it('uses the injected key namespaces', async () => {
    const redis = makeRedis();
    const reg = createSessionRegistry({ redis, keys: { ...KEYS, tokenState: 'custom:state' } });
    await reg.invalidateToken('q');
    expect(redis._hashes.get('custom:state')?.get('q')).toBe('invalid');
  });
});
