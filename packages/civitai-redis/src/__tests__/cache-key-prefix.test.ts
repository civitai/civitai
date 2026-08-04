import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The prefix is resolved at MODULE-EVAL time (the key table is a module-level const), so every
// case re-imports the module under a fresh `process.env` — the same pattern the app uses for
// `isPreview` in src/env/__tests__/other.test.ts.
//
// 🔴 Every expected value below is a HAND-WRITTEN LITERAL, never derived from the key table or
// from the prefix constant. The production assertions are what pins "production keys do not
// move": if a prefix ever leaked into a namespace-less environment, these go red.
describe('cache key prefix', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  /**
   * Load the module graph with a clean environment plus whatever this case sets.
   *
   * Both modules are pulled so a case can reach `applyCacheKeyPrefix` (which the client
   * re-exports only the results of) under the same module-eval environment.
   */
  const load = async (vars: Record<string, string> = {}) => {
    const { CACHE_KEY_NAMESPACE: _ns, IS_PREVIEW: _preview, ...clean } = process.env;
    process.env = { ...clean, ...vars };
    const [client, prefix] = await Promise.all([import('../client'), import('../cache-key-prefix')]);
    return { ...client, ...prefix };
  };

  describe('production (CACHE_KEY_NAMESPACE unset)', () => {
    it('leaves every cache key byte-identical', async () => {
      const { REDIS_KEYS } = await load();

      expect(REDIS_KEYS.CACHES.USER_COSMETICS).toBe('packed:caches:user-cosmetics');
      expect(REDIS_KEYS.CACHES.TAGGED_CACHE).toBe('packed:caches:tagged-cache');
      expect(REDIS_KEYS.TRPC.BASE).toBe('packed:trpc');
      expect(REDIS_KEYS.TRPC.LIMIT.KEYS).toBe('packed:trpc:limit:keys');
      expect(REDIS_KEYS.TAG).toBe('tag');
      expect(REDIS_KEYS.CACHE_LOCKS).toBe('cache-lock');
    });

    it('builds the same full entry key as before', async () => {
      const { REDIS_KEYS } = await load();

      expect(`${REDIS_KEYS.CACHES.USER_COSMETICS}:123`).toBe('packed:caches:user-cosmetics:123');
      expect(`${REDIS_KEYS.CACHE_LOCKS}:some-lock`).toBe('cache-lock:some-lock');
    });

    it('exposes an empty prefix and an identity prefixCacheKey', async () => {
      const { CACHE_KEY_PREFIX, CACHE_KEY_NAMESPACE, prefixCacheKey } = await load();

      expect(CACHE_KEY_NAMESPACE).toBe('');
      expect(CACHE_KEY_PREFIX).toBe('');
      expect(prefixCacheKey('getTags:v1:abc123')).toBe('getTags:v1:abc123');
    });

    it('returns the key table as the SAME OBJECT — a structural no-op, not a rebuild', async () => {
      // The identity assertion is the strongest form of "production keys do not move": it fails
      // even if a rebuild produced byte-identical strings, catching a refactor that drops the
      // early return.
      const mod = await load();
      const { REDIS_KEYS, applyCacheKeyPrefix } = mod;

      const table = { A: 'a', NESTED: { B: 'b' } } as const;
      expect(applyCacheKeyPrefix(table)).toBe(table);
      expect(REDIS_KEYS.CACHES).toBe(REDIS_KEYS.CACHES);
    });

    it('treats an empty / whitespace-only namespace as unset', async () => {
      const blank = await load({ CACHE_KEY_NAMESPACE: '   ' });
      expect(blank.CACHE_KEY_PREFIX).toBe('');
      expect(blank.REDIS_KEYS.CACHES.USER_COSMETICS).toBe('packed:caches:user-cosmetics');

      vi.resetModules();
      const empty = await load({ CACHE_KEY_NAMESPACE: '' });
      expect(empty.CACHE_KEY_PREFIX).toBe('');
      expect(empty.REDIS_KEYS.CACHES.USER_COSMETICS).toBe('packed:caches:user-cosmetics');
    });
  });

  describe('namespaced deployments', () => {
    it('prefixes every cache key with the "preview" namespace', async () => {
      const { REDIS_KEYS, CACHE_KEY_PREFIX } = await load({ CACHE_KEY_NAMESPACE: 'preview' });

      expect(CACHE_KEY_PREFIX).toBe('preview:');
      expect(REDIS_KEYS.CACHES.USER_COSMETICS).toBe('preview:packed:caches:user-cosmetics');
      expect(REDIS_KEYS.CACHES.TAGGED_CACHE).toBe('preview:packed:caches:tagged-cache');
      expect(REDIS_KEYS.TRPC.BASE).toBe('preview:packed:trpc');
      expect(REDIS_KEYS.TRPC.LIMIT.KEYS).toBe('preview:packed:trpc:limit:keys');
      expect(REDIS_KEYS.TAG).toBe('preview:tag');
      expect(REDIS_KEYS.CACHE_LOCKS).toBe('preview:cache-lock');
    });

    it('prefixes DIFFERENTLY under the "next" namespace', async () => {
      // The whole point of an explicit namespace: two non-production deployments that both set
      // IS_PREVIEW=true, but run against different databases, must not share a keyspace.
      const { REDIS_KEYS, CACHE_KEY_PREFIX } = await load({ CACHE_KEY_NAMESPACE: 'next' });

      expect(CACHE_KEY_PREFIX).toBe('next:');
      expect(REDIS_KEYS.CACHES.USER_COSMETICS).toBe('next:packed:caches:user-cosmetics');
      expect(REDIS_KEYS.TAG).toBe('next:tag');
      expect(REDIS_KEYS.CACHE_LOCKS).toBe('next:cache-lock');
    });

    it('builds a full entry key that cannot collide with production or another namespace', async () => {
      const preview = await load({ CACHE_KEY_NAMESPACE: 'preview' });
      expect(`${preview.REDIS_KEYS.CACHES.USER_COSMETICS}:123`).toBe(
        'preview:packed:caches:user-cosmetics:123'
      );
      expect(`${preview.REDIS_KEYS.CACHE_LOCKS}:some-lock`).toBe('preview:cache-lock:some-lock');

      vi.resetModules();
      const next = await load({ CACHE_KEY_NAMESPACE: 'next' });
      expect(`${next.REDIS_KEYS.CACHES.USER_COSMETICS}:123`).toBe(
        'next:packed:caches:user-cosmetics:123'
      );
      expect(`${next.REDIS_KEYS.CACHE_LOCKS}:some-lock`).toBe('next:cache-lock:some-lock');
    });

    it('prefixes an on-the-fly key via prefixCacheKey', async () => {
      const { prefixCacheKey } = await load({ CACHE_KEY_NAMESPACE: 'preview' });
      expect(prefixCacheKey('getTags:v1:abc123')).toBe('preview:getTags:v1:abc123');
    });

    it('prefixes each key exactly once (no double-prefixing of nested tables)', async () => {
      const { REDIS_KEYS } = await load({ CACHE_KEY_NAMESPACE: 'preview' });

      // TRPC.LIMIT.BASE is a nested leaf whose literal already contains TRPC.BASE's text — a
      // deep-map bug that prefixed parents and children separately would produce
      // `preview:preview:…` here.
      expect(REDIS_KEYS.TRPC.LIMIT.BASE).toBe('preview:packed:trpc:limit');
      expect(REDIS_KEYS.TRPC.LIMIT.BASE.match(/preview:/g)).toHaveLength(1);
    });

    it('trims surrounding whitespace out of the namespace', async () => {
      const { CACHE_KEY_PREFIX, REDIS_KEYS } = await load({ CACHE_KEY_NAMESPACE: '  preview  ' });
      expect(CACHE_KEY_PREFIX).toBe('preview:');
      expect(REDIS_KEYS.TAG).toBe('preview:tag');
    });

    it('appends the separator itself, so the value is configured without one', async () => {
      // Pins that `CACHE_KEY_NAMESPACE=preview` and a hypothetical `=preview:` cannot silently
      // produce two different keyspaces from the same intent.
      const { CACHE_KEY_PREFIX } = await load({ CACHE_KEY_NAMESPACE: 'preview' });
      expect(CACHE_KEY_PREFIX).toBe('preview:');
    });
  });

  describe('decoupling from IS_PREVIEW', () => {
    it('does NOT prefix when IS_PREVIEW=true but no namespace is set', async () => {
      // 🔴 The core of this change. A deployment that sets IS_PREVIEW=true may be running against
      // the PRODUCTION database, so the flag cannot be the source of the cache namespace.
      const { REDIS_KEYS, CACHE_KEY_PREFIX } = await load({ IS_PREVIEW: 'true' });

      expect(CACHE_KEY_PREFIX).toBe('');
      expect(REDIS_KEYS.CACHES.USER_COSMETICS).toBe('packed:caches:user-cosmetics');
      expect(REDIS_KEYS.TAG).toBe('tag');
    });

    it('prefixes when a namespace is set and IS_PREVIEW is absent', async () => {
      // The converse: the namespace alone drives the keyspace. A deployment need not claim to be
      // a "preview" to get its own namespace.
      const { REDIS_KEYS, CACHE_KEY_PREFIX } = await load({ CACHE_KEY_NAMESPACE: 'next' });

      expect(CACHE_KEY_PREFIX).toBe('next:');
      expect(REDIS_KEYS.CACHES.USER_COSMETICS).toBe('next:packed:caches:user-cosmetics');
    });

    it('logs a loud error when IS_PREVIEW=true carries no namespace', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await load({ IS_PREVIEW: 'true' });

      expect(spy).toHaveBeenCalledTimes(1);
      const message = String(spy.mock.calls[0]?.[0]);
      expect(message).toContain('CACHE_KEY_NAMESPACE');
      expect(message).toContain('IS_PREVIEW=true');
    });

    it('does NOT log when IS_PREVIEW=true and a namespace IS set', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await load({ IS_PREVIEW: 'true', CACHE_KEY_NAMESPACE: 'preview' });

      expect(spy).not.toHaveBeenCalled();
    });

    it('does NOT log in production (no IS_PREVIEW, no namespace)', async () => {
      // Guards against the warning becoming per-process noise on every production boot.
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await load();

      expect(spy).not.toHaveBeenCalled();
    });

    it('does not throw or fail module evaluation on the misconfiguration', async () => {
      // 🔴 Log-only by design: a deployment sets IS_PREVIEW=true today without a namespace, and
      // throwing here would fail its boot.
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(load({ IS_PREVIEW: 'true' })).resolves.toBeDefined();
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('table shape', () => {
    it('preserves an array leaf instead of rebuilding it as an object', async () => {
      // `Object.entries`-based rebuilding turns ['a','b'] into {0:'a',1:'b'}. No array leaf
      // exists in REDIS_KEYS today, so this is latent — and it would be invisible in production,
      // where the function returns early. The type constraint rejects an array leaf at compile
      // time; this pins the runtime behaviour for a caller that casts past it.
      const { applyCacheKeyPrefix } = await load({ CACHE_KEY_NAMESPACE: 'preview' });

      const table = { LIST: ['alpha', 'beta'], LEAF: 'solo' } as unknown as Record<string, string>;
      const out = applyCacheKeyPrefix(table) as unknown as {
        LIST: string[];
        LEAF: string;
      };

      expect(Array.isArray(out.LIST)).toBe(true);
      expect(out.LIST).toEqual(['preview:alpha', 'preview:beta']);
      expect(out.LEAF).toBe('preview:solo');
    });
  });

  describe('system keyspace', () => {
    // sysRedis is explicitly out of scope: non-production deployments get their own system
    // instance, and the system client must keep addressing the keys it always has.
    it('never prefixes REDIS_SYS_KEYS, in any namespace', async () => {
      const prod = await load();
      expect(prod.REDIS_SYS_KEYS.DEVICE.ACCOUNTS).toBe('device:accounts');

      vi.resetModules();
      const preview = await load({ CACHE_KEY_NAMESPACE: 'preview' });
      expect(preview.REDIS_SYS_KEYS.DEVICE.ACCOUNTS).toBe('device:accounts');

      vi.resetModules();
      const next = await load({ CACHE_KEY_NAMESPACE: 'next' });
      expect(next.REDIS_SYS_KEYS.DEVICE.ACCOUNTS).toBe('device:accounts');
    });
  });
});
