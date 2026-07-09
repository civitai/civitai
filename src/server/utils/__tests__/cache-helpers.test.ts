import { describe, expect, it } from 'vitest';
import { resolveCacheExpiry } from '~/server/utils/cache-helpers';

/**
 * Unit coverage for resolveCacheExpiry — the pure helper that decides the
 * physical Redis EX for a cached entry. The logical freshness window is `ttl`;
 * with stale-while-revalidate the key outlives that by a stale tail (defaulting
 * to a full `ttl`, i.e. the historical `ttl * 2` expiry) which can be trimmed
 * per-cache via `staleWhileRevalidateTtl`.
 */
describe('resolveCacheExpiry', () => {
  const TTL = 28800; // 8h in seconds

  it('returns just ttl when stale-while-revalidate is off', () => {
    expect(resolveCacheExpiry(TTL, false)).toBe(28800);
  });

  it('defaults the stale tail to a full ttl (historical ttl * 2)', () => {
    expect(resolveCacheExpiry(TTL, true)).toBe(57600);
  });

  it('treats an explicitly-undefined tail the same as the default', () => {
    expect(resolveCacheExpiry(TTL, true, undefined)).toBe(57600);
  });

  it('adds a shortened tail to ttl (the tag-ids 1h-tail case → 9h)', () => {
    expect(resolveCacheExpiry(TTL, true, 3600)).toBe(32400);
  });

  it('collapses to just ttl when the tail is zero', () => {
    expect(resolveCacheExpiry(TTL, true, 0)).toBe(28800);
  });
});
