import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The prefix is resolved at MODULE-EVAL time (the key table is a module-level const), so every
// case re-imports the module under a fresh `process.env` — the same pattern the app uses for
// `isPreview` in src/env/__tests__/other.test.ts.
//
// 🔴 Every expected value below is a HAND-WRITTEN LITERAL, never derived from the key table or
// from the prefix constant. The production assertions are what pins "production keys do not
// move": if the prefix ever leaked into a non-preview environment, these go red.
describe('cache key prefix', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const loadProd = async () => {
    const { IS_PREVIEW: _drop, ...withoutPreview } = process.env;
    process.env = withoutPreview;
    return import('../client');
  };

  const loadPreview = async () => {
    process.env = { ...process.env, IS_PREVIEW: 'true' };
    return import('../client');
  };

  describe('production (IS_PREVIEW unset)', () => {
    it('leaves every cache key byte-identical', async () => {
      const { REDIS_KEYS } = await loadProd();

      expect(REDIS_KEYS.CACHES.USER_COSMETICS).toBe('packed:caches:user-cosmetics');
      expect(REDIS_KEYS.CACHES.TAGGED_CACHE).toBe('packed:caches:tagged-cache');
      expect(REDIS_KEYS.TRPC.BASE).toBe('packed:trpc');
      expect(REDIS_KEYS.TRPC.LIMIT.KEYS).toBe('packed:trpc:limit:keys');
      expect(REDIS_KEYS.TAG).toBe('tag');
      expect(REDIS_KEYS.CACHE_LOCKS).toBe('cache-lock');
    });

    it('builds the same full entry key as before', async () => {
      const { REDIS_KEYS } = await loadProd();

      expect(`${REDIS_KEYS.CACHES.USER_COSMETICS}:123`).toBe('packed:caches:user-cosmetics:123');
      expect(`${REDIS_KEYS.CACHE_LOCKS}:some-lock`).toBe('cache-lock:some-lock');
    });

    it('exposes an empty prefix and an identity prefixCacheKey', async () => {
      const { CACHE_KEY_PREFIX, prefixCacheKey } = await loadProd();

      expect(CACHE_KEY_PREFIX).toBe('');
      expect(prefixCacheKey('getTags:v1:abc123')).toBe('getTags:v1:abc123');
    });

    it('leaves IS_PREVIEW="false" unprefixed (only the literal "true" opts in)', async () => {
      process.env = { ...process.env, IS_PREVIEW: 'false' };
      const { REDIS_KEYS, CACHE_KEY_PREFIX } = await import('../client');

      expect(CACHE_KEY_PREFIX).toBe('');
      expect(REDIS_KEYS.CACHES.USER_COSMETICS).toBe('packed:caches:user-cosmetics');
    });
  });

  describe('preview (IS_PREVIEW=true)', () => {
    it('prefixes every cache key', async () => {
      const { REDIS_KEYS } = await loadPreview();

      expect(REDIS_KEYS.CACHES.USER_COSMETICS).toBe('preview:packed:caches:user-cosmetics');
      expect(REDIS_KEYS.CACHES.TAGGED_CACHE).toBe('preview:packed:caches:tagged-cache');
      expect(REDIS_KEYS.TRPC.BASE).toBe('preview:packed:trpc');
      expect(REDIS_KEYS.TRPC.LIMIT.KEYS).toBe('preview:packed:trpc:limit:keys');
      expect(REDIS_KEYS.TAG).toBe('preview:tag');
      expect(REDIS_KEYS.CACHE_LOCKS).toBe('preview:cache-lock');
    });

    it('builds a full entry key that cannot collide with production', async () => {
      const { REDIS_KEYS } = await loadPreview();

      expect(`${REDIS_KEYS.CACHES.USER_COSMETICS}:123`).toBe(
        'preview:packed:caches:user-cosmetics:123'
      );
      expect(`${REDIS_KEYS.CACHE_LOCKS}:some-lock`).toBe('preview:cache-lock:some-lock');
    });

    it('prefixes an on-the-fly key via prefixCacheKey', async () => {
      const { CACHE_KEY_PREFIX, prefixCacheKey } = await loadPreview();

      expect(CACHE_KEY_PREFIX).toBe('preview:');
      expect(prefixCacheKey('getTags:v1:abc123')).toBe('preview:getTags:v1:abc123');
    });

    it('prefixes each key exactly once (no double-prefixing of nested tables)', async () => {
      const { REDIS_KEYS } = await loadPreview();

      // TRPC.LIMIT.BASE is a nested leaf whose literal already contains TRPC.BASE's text — a
      // deep-map bug that prefixed parents and children separately would produce
      // `preview:preview:…` here.
      expect(REDIS_KEYS.TRPC.LIMIT.BASE).toBe('preview:packed:trpc:limit');
      expect(REDIS_KEYS.TRPC.LIMIT.BASE.match(/preview:/g)).toHaveLength(1);
    });
  });

  describe('system keyspace', () => {
    // sysRedis is explicitly out of scope: previews get their own system instance, and the
    // system client must keep addressing the keys it always has.
    it('never prefixes REDIS_SYS_KEYS, in either environment', async () => {
      const prod = await loadProd();
      expect(prod.REDIS_SYS_KEYS.DEVICE.ACCOUNTS).toBe('device:accounts');

      vi.resetModules();
      const preview = await loadPreview();
      expect(preview.REDIS_SYS_KEYS.DEVICE.ACCOUNTS).toBe('device:accounts');
    });
  });
});
