import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit coverage for the App Blocks catalog per-token rate limiter
 * (checkBlockCatalogRateLimit). Three contracts matter:
 *   (a) under the ceiling → allowed;
 *   (b) over the ceiling → not allowed + a sane Retry-After (the live TTL);
 *   (c) any redis error → FAIL OPEN (allowed) — the catalog must never break
 *       because the limiter's redis is down.
 *
 * The redis cache client is mocked so no real connection is constructed.
 */

import {
  checkBlockCatalogRateLimit,
  checkBlockEstimateCellsRateLimit,
  BLOCK_CATALOG_RATE_LIMIT_MAX,
  BLOCK_CATALOG_RATE_LIMIT_WINDOW_SECONDS,
} from '../block-catalog-rate-limit';
import { redisMock } from '~/__tests__/mocks/redis.mock';
const mockRedis = redisMock.redis;

const KEY = `blocks:token-rate-limit:catalog:bki_test`;

describe('checkBlockCatalogRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.expire.mockResolvedValue(true);
    mockRedis.ttl.mockResolvedValue(BLOCK_CATALOG_RATE_LIMIT_WINDOW_SECONDS);
  });

  it('first hit of a window → allowed and sets the TTL', async () => {
    mockRedis.incrBy.mockResolvedValue(1);
    const res = await checkBlockCatalogRateLimit('bki_test');
    expect(res).toEqual({ allowed: true });
    expect(mockRedis.incrBy).toHaveBeenCalledWith(KEY, 1);
    expect(mockRedis.expire).toHaveBeenCalledWith(KEY, BLOCK_CATALOG_RATE_LIMIT_WINDOW_SECONDS);
  });

  it('at the ceiling → still allowed (boundary is inclusive)', async () => {
    mockRedis.incrBy.mockResolvedValue(BLOCK_CATALOG_RATE_LIMIT_MAX);
    const res = await checkBlockCatalogRateLimit('bki_test');
    expect(res).toEqual({ allowed: true });
  });

  it('subsequent hit (count>1) does NOT reset the TTL on a live window', async () => {
    mockRedis.incrBy.mockResolvedValue(5);
    mockRedis.ttl.mockResolvedValue(7); // live window
    const res = await checkBlockCatalogRateLimit('bki_test');
    expect(res).toEqual({ allowed: true });
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  it('re-asserts a lost TTL (ttl<0) on a non-first hit', async () => {
    mockRedis.incrBy.mockResolvedValue(5);
    mockRedis.ttl.mockResolvedValue(-1); // TTL was lost
    await checkBlockCatalogRateLimit('bki_test');
    expect(mockRedis.expire).toHaveBeenCalledWith(KEY, BLOCK_CATALOG_RATE_LIMIT_WINDOW_SECONDS);
  });

  it('over the ceiling → not allowed + Retry-After = live TTL', async () => {
    mockRedis.incrBy.mockResolvedValue(BLOCK_CATALOG_RATE_LIMIT_MAX + 1);
    mockRedis.ttl.mockResolvedValue(4); // remaining window
    const res = await checkBlockCatalogRateLimit('bki_test');
    expect(res).toEqual({ allowed: false, retryAfterSeconds: 4 });
  });

  it('over the ceiling with an unset/invalid TTL → falls back to the full window', async () => {
    mockRedis.incrBy.mockResolvedValue(BLOCK_CATALOG_RATE_LIMIT_MAX + 10);
    mockRedis.ttl.mockResolvedValue(-2); // key reported as gone
    const res = await checkBlockCatalogRateLimit('bki_test');
    expect(res).toEqual({
      allowed: false,
      retryAfterSeconds: BLOCK_CATALOG_RATE_LIMIT_WINDOW_SECONDS,
    });
  });

  it('redis error (incr throws) → FAIL OPEN (allowed)', async () => {
    mockRedis.incrBy.mockRejectedValue(new Error('redis down'));
    const res = await checkBlockCatalogRateLimit('bki_test');
    expect(res).toEqual({ allowed: true });
  });

  it('redis error on the over-limit TTL read → FAIL OPEN (allowed)', async () => {
    // incr says over-limit, but the follow-up ttl read throws → the catch fails
    // open rather than 429ing on a half-broken redis.
    mockRedis.incrBy.mockResolvedValue(BLOCK_CATALOG_RATE_LIMIT_MAX + 1);
    mockRedis.ttl.mockRejectedValue(new Error('redis down'));
    const res = await checkBlockCatalogRateLimit('bki_test');
    expect(res).toEqual({ allowed: true });
  });
});

/**
 * The ESTIMATE-CELLS bucket: what `blocks.estimateWorkflowBatch` charges per CELL,
 * on top of the one catalog token it charges per call.
 *
 * The ceiling and window are pinned as LITERALS (64 cells / 10 s) rather than read
 * from the module's constants: an assertion built from the constant it checks
 * moves with it and can never notice the number changing.
 */
describe('checkBlockEstimateCellsRateLimit', () => {
  // Install AND viewer are both in the key; the catalog key above has no viewer.
  const CELLS_KEY = 'blocks:token-rate-limit:estimate-cells:page_apb_grid:4207';

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.expire.mockResolvedValue(true);
    mockRedis.ttl.mockResolvedValue(10);
  });

  it('charges the bucket the CELL COUNT, on a key holding the install and the viewer', async () => {
    mockRedis.incrBy.mockResolvedValue(11);
    const res = await checkBlockEstimateCellsRateLimit('page_apb_grid', 4207, 11);
    expect(res).toEqual({ allowed: true });
    expect(mockRedis.incrBy).toHaveBeenCalledTimes(1);
    expect(mockRedis.incrBy).toHaveBeenCalledWith(CELLS_KEY, 11);
  });

  it('arms a 10 s window on the first charge of a window', async () => {
    // First charge of a fresh window: the counter comes back equal to the weight.
    mockRedis.incrBy.mockResolvedValue(11);
    await checkBlockEstimateCellsRateLimit('page_apb_grid', 4207, 11);
    expect(mockRedis.expire).toHaveBeenCalledWith(CELLS_KEY, 10);
  });

  it('allows the 64th cell of a window and refuses the 65th', async () => {
    mockRedis.incrBy.mockResolvedValue(64);
    expect(await checkBlockEstimateCellsRateLimit('page_apb_grid', 4207, 16)).toEqual({
      allowed: true,
    });
    mockRedis.incrBy.mockResolvedValue(65);
    mockRedis.ttl.mockResolvedValue(7);
    expect(await checkBlockEstimateCellsRateLimit('page_apb_grid', 4207, 1)).toEqual({
      allowed: false,
      retryAfterSeconds: 7,
    });
  });

  it('two viewers of one install do not share a window', async () => {
    mockRedis.incrBy.mockResolvedValue(3);
    await checkBlockEstimateCellsRateLimit('page_apb_grid', 4207, 3);
    await checkBlockEstimateCellsRateLimit('page_apb_grid', 9113, 3);
    expect(mockRedis.incrBy.mock.calls.map((c) => c[0])).toEqual([
      'blocks:token-rate-limit:estimate-cells:page_apb_grid:4207',
      'blocks:token-rate-limit:estimate-cells:page_apb_grid:9113',
    ]);
  });

  it('redis throws → FAIL OPEN, like every sibling bucket', async () => {
    mockRedis.incrBy.mockRejectedValue(new Error('redis down'));
    expect(await checkBlockEstimateCellsRateLimit('page_apb_grid', 4207, 16)).toEqual({
      allowed: true,
    });
  });
});
