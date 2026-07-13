import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Direct unit coverage for the tip cap/limit REDIS PRIMITIVES
 * (`reserveBlockTipSpend` / `refundBlockTipSpend` / `checkBlockTipRateLimit`),
 * exercised against an in-memory redis mock so the concurrency/TTL/refund/
 * fail-closed logic is tested for real (the endpoint tests mock these away).
 */

const { sysStore, sysTtls, mockSys, cacheStore, cacheTtls, mockCache } = vi.hoisted(() => {
  const sysStore = new Map<string, number>();
  const sysTtls = new Map<string, number>();
  const cacheStore = new Map<string, number>();
  const cacheTtls = new Map<string, number>();
  const mockSys = {
    incrBy: vi.fn(async (k: string, n: number) => {
      const v = (sysStore.get(k) ?? 0) + n;
      sysStore.set(k, v);
      return v;
    }),
    decrBy: vi.fn(async (k: string, n: number) => {
      const v = (sysStore.get(k) ?? 0) - n;
      sysStore.set(k, v);
      return v;
    }),
    expire: vi.fn(async (k: string, s: number) => {
      sysTtls.set(k, s);
      return true;
    }),
    ttl: vi.fn(async (k: string) => sysTtls.get(k) ?? -1),
  };
  const mockCache = {
    incrBy: vi.fn(async (k: string, n: number) => {
      const v = (cacheStore.get(k) ?? 0) + n;
      cacheStore.set(k, v);
      return v;
    }),
    expire: vi.fn(async (k: string, s: number) => {
      cacheTtls.set(k, s);
      return true;
    }),
    ttl: vi.fn(async (k: string) => cacheTtls.get(k) ?? -1),
  };
  return { sysStore, sysTtls, mockSys, cacheStore, cacheTtls, mockCache };
});

vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSys,
  redis: mockCache,
  REDIS_SYS_KEYS: { BLOCKS: { TIP_CAP: 'system:blocks:tip-cap' } },
  REDIS_KEYS: { BLOCKS: { TOKEN_RATE_LIMIT: 'rl' } },
}));

import {
  BLOCK_TIP_RATE_LIMIT_MAX,
  checkBlockTipRateLimit,
  refundBlockTipSpend,
  reserveBlockTipSpend,
} from '../block-tip-rate-limit';

const TODAY = new Date().toISOString().slice(0, 10);

beforeEach(() => {
  vi.clearAllMocks();
  sysStore.clear();
  sysTtls.clear();
  cacheStore.clear();
  cacheTtls.clear();
});

describe('reserveBlockTipSpend', () => {
  it('reserves the amount, returns a UTC-day-scoped key, and SETS the TTL on the first write', async () => {
    const { total, key } = await reserveBlockTipSpend(42, 100);
    expect(total).toBe(100);
    expect(key).toBe(`system:blocks:tip-cap:42:${TODAY}`);
    // TTL armed on first write (~25h).
    expect(mockSys.expire).toHaveBeenCalledWith(key, 25 * 60 * 60);
    expect(sysStore.get(key)).toBe(100);
  });

  it('accumulates concurrent reservations and does NOT re-arm the TTL when one is set', async () => {
    const first = await reserveBlockTipSpend(42, 100);
    mockSys.expire.mockClear();
    const second = await reserveBlockTipSpend(42, 150);
    expect(second.total).toBe(250); // 100 + 150 — atomic INCRBY accumulation
    expect(second.key).toBe(first.key);
    // TTL already set (>=0) → no re-arm on the subsequent write.
    expect(mockSys.expire).not.toHaveBeenCalled();
  });

  it('re-arms a LOST TTL (ttl < 0) on a subsequent write (self-heal)', async () => {
    const { key } = await reserveBlockTipSpend(42, 100);
    sysTtls.delete(key); // simulate a TTL-less key (crash / manual SET)
    mockSys.expire.mockClear();
    await reserveBlockTipSpend(42, 50);
    expect(mockSys.expire).toHaveBeenCalledWith(key, 25 * 60 * 60);
  });

  it('FAILS-CLOSED (throws) on a redis error — the caller turns this into a 503', async () => {
    mockSys.incrBy.mockRejectedValueOnce(new Error('redis down'));
    await expect(reserveBlockTipSpend(42, 100)).rejects.toThrow();
  });
});

describe('refundBlockTipSpend', () => {
  it('decrements the EXACT captured key by the exact amount', async () => {
    const { key } = await reserveBlockTipSpend(42, 300);
    await refundBlockTipSpend(key, 300);
    expect(mockSys.decrBy).toHaveBeenCalledWith(key, 300);
    expect(sysStore.get(key)).toBe(0);
  });

  it('MIDNIGHT STRADDLE: refunds the day it RESERVED, not the current-day key', async () => {
    // A request that reserved yesterday must refund yesterday's key even if "now"
    // is a new UTC day. The primitive takes the CAPTURED key, so re-derivation can
    // never point it at the wrong day.
    const yesterdayKey = 'system:blocks:tip-cap:42:2020-01-01';
    sysStore.set(yesterdayKey, 500);
    await refundBlockTipSpend(yesterdayKey as never, 500);
    expect(mockSys.decrBy).toHaveBeenCalledWith(yesterdayKey, 500);
    expect(sysStore.get(yesterdayKey)).toBe(0);
    // The current-day key is untouched.
    expect(sysStore.get(`system:blocks:tip-cap:42:${TODAY}`)).toBeUndefined();
  });

  it('is best-effort — a failed DECRBY never throws (a lost refund only over-counts)', async () => {
    mockSys.decrBy.mockRejectedValueOnce(new Error('redis blip'));
    await expect(refundBlockTipSpend('k' as never, 100)).resolves.toBeUndefined();
  });
});

describe('checkBlockTipRateLimit', () => {
  it('allows under the ceiling', async () => {
    const r = await checkBlockTipRateLimit('bki_1');
    expect(r).toEqual({ allowed: true });
  });

  it('blocks once the window count exceeds the ceiling', async () => {
    let last;
    for (let i = 0; i < BLOCK_TIP_RATE_LIMIT_MAX + 1; i++) {
      last = await checkBlockTipRateLimit('bki_2');
    }
    expect(last).toMatchObject({ allowed: false });
  });

  it('FAILS-CLOSED on a redis error (money path)', async () => {
    mockCache.incrBy.mockRejectedValueOnce(new Error('redis down'));
    const r = await checkBlockTipRateLimit('bki_3');
    expect(r).toMatchObject({ allowed: false });
  });
});
