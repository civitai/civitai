import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  BLOCK_PUBLISH_RATE_LIMIT_WINDOW_SECONDS,
  BLOCK_UPLOAD_RATE_LIMIT_MAX,
  BLOCK_UPLOAD_RATE_LIMIT_WINDOW_SECONDS,
  checkBlockPublishRateLimit,
  checkBlockUploadRateLimit,
} from '../block-catalog-rate-limit';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mockRedis = redisMock.redis;
// Fixture viewers. Pairwise distinct, and distinct from every ceiling/window constant in
// the module (3, 60, 150, 300, 1200, 3600 …), so a key built from a constant instead of the
// viewer cannot spell either of them.
const VIEWER_A = 8123;
const VIEWER_B = 9417;
// A page app's instance id is `page_<appBlockId>` — one string for every viewer.
const PAGE_INSTANCE = 'page_apb_shared';
const KEY = 'blocks:token-rate-limit:upload:page_apb_shared:8123';

/**
 * The upload bucket `blocks.persistAppUploadImage` charges, keyed on (install, viewer).
 *
 * The key is asserted literally: the property is that BOTH the install and the viewer are in
 * it, and a key missing either half still allows and refuses correctly for a single caller.
 */
describe('checkBlockUploadRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.expire.mockResolvedValue(true);
    mockRedis.ttl.mockResolvedValue(BLOCK_UPLOAD_RATE_LIMIT_WINDOW_SECONDS);
  });

  it('keys on the install AND the viewer, in its own `:upload:` sub-namespace, one token per upload', async () => {
    mockRedis.incrBy.mockResolvedValue(1);
    await checkBlockUploadRateLimit(PAGE_INSTANCE, VIEWER_A);
    expect(mockRedis.incrBy.mock.calls).toEqual([[KEY, 1]]);
  });

  it('keeps the INSTALL in the key, so one viewer’s two apps do not share an allowance', async () => {
    mockRedis.incrBy.mockResolvedValue(1);
    await checkBlockUploadRateLimit('page_apb_one', VIEWER_A);
    await checkBlockUploadRateLimit('page_apb_two', VIEWER_A);
    expect(mockRedis.incrBy.mock.calls.map((c) => c[0])).toEqual([
      'blocks:token-rate-limit:upload:page_apb_one:8123',
      'blocks:token-rate-limit:upload:page_apb_two:8123',
    ]);
  });

  it('first hit arms the TTL with the upload window', async () => {
    mockRedis.incrBy.mockResolvedValue(1);
    await expect(checkBlockUploadRateLimit(PAGE_INSTANCE, VIEWER_A)).resolves.toEqual({
      allowed: true,
    });
    expect(mockRedis.expire.mock.calls).toEqual([[KEY, 300]]);
  });

  it('allows exactly 60 in a window and refuses the next one with the live TTL', async () => {
    expect(BLOCK_UPLOAD_RATE_LIMIT_MAX).toBe(60);
    expect(BLOCK_UPLOAD_RATE_LIMIT_WINDOW_SECONDS).toBe(300);

    mockRedis.incrBy.mockResolvedValue(60);
    await expect(checkBlockUploadRateLimit(PAGE_INSTANCE, VIEWER_A)).resolves.toEqual({
      allowed: true,
    });

    mockRedis.incrBy.mockResolvedValue(61);
    // 177: distinct from the window, so a constant returned in place of the TTL is visible.
    mockRedis.ttl.mockResolvedValue(177);
    await expect(checkBlockUploadRateLimit(PAGE_INSTANCE, VIEWER_A)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 177,
    });
  });

  it('FAILS OPEN on a redis error, like every sibling limiter', async () => {
    mockRedis.incrBy.mockRejectedValue(new Error('redis down'));
    await expect(checkBlockUploadRateLimit(PAGE_INSTANCE, VIEWER_A)).resolves.toEqual({
      allowed: true,
    });
  });

  describe('two viewers of the same page-app instance', () => {
    let counters: Map<string, number>;

    beforeEach(() => {
      counters = new Map();
      mockRedis.incrBy.mockImplementation(async (key: string, by: number) => {
        const next = (counters.get(key) ?? 0) + by;
        counters.set(key, next);
        return next;
      });
      mockRedis.ttl.mockResolvedValue(177);
    });

    it('A at the ceiling is refused; B, who has uploaded nothing, is not', async () => {
      for (let i = 0; i < 60; i++) {
        await expect(checkBlockUploadRateLimit(PAGE_INSTANCE, VIEWER_A)).resolves.toEqual({
          allowed: true,
        });
      }
      await expect(checkBlockUploadRateLimit(PAGE_INSTANCE, VIEWER_A)).resolves.toEqual({
        allowed: false,
        retryAfterSeconds: 177,
      });
      await expect(checkBlockUploadRateLimit(PAGE_INSTANCE, VIEWER_B)).resolves.toEqual({
        allowed: true,
      });

      expect([...counters.entries()].sort()).toEqual([
        ['blocks:token-rate-limit:upload:page_apb_shared:8123', 61],
        ['blocks:token-rate-limit:upload:page_apb_shared:9417', 1],
      ]);
    });
  });
});

/**
 * INVARIANT GUARD: the publish bucket is keyed on the install alone, so on a page app every
 * viewer draws on one allowance, and it is weighted by image count.
 */
describe('checkBlockPublishRateLimit — still per install', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.expire.mockResolvedValue(true);
    mockRedis.ttl.mockResolvedValue(BLOCK_PUBLISH_RATE_LIMIT_WINDOW_SECONDS);
  });

  it('has no viewer in its key, and charges the image count', async () => {
    mockRedis.incrBy.mockResolvedValue(7);
    await checkBlockPublishRateLimit(PAGE_INSTANCE, 7);
    expect(mockRedis.incrBy.mock.calls).toEqual([
      ['blocks:token-rate-limit:publish:page_apb_shared', 7],
    ]);
  });
});
