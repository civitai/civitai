import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Direct unit coverage for the tip cap/limit REDIS PRIMITIVES
 * (`reserveBlockTipSpend` / `refundBlockTipSpend` / `checkBlockTipRateLimit`),
 * exercised against an in-memory redis mock so the concurrency/TTL/refund/
 * fail-closed logic is tested for real (the endpoint tests mock these away).
 */

const { sysStore, sysTtls, mockSys, cacheStore, cacheTtls, mockCache } = vi.hoisted(() => {
  // Holds numbers (counters via incrBy/decrBy) AND strings (idempotency records via
  // set/get) — `get` coerces to string, `incrBy` coerces to number, mirroring redis.
  const sysStore = new Map<string, string | number>();
  const sysTtls = new Map<string, number>();
  const cacheStore = new Map<string, number>();
  const cacheTtls = new Map<string, number>();
  const mockSys = {
    incrBy: vi.fn(async (k: string, n: number) => {
      const v = Number(sysStore.get(k) ?? 0) + n;
      sysStore.set(k, v);
      return v;
    }),
    decrBy: vi.fn(async (k: string, n: number) => {
      const v = Number(sysStore.get(k) ?? 0) - n;
      sysStore.set(k, v);
      return v;
    }),
    expire: vi.fn(async (k: string, s: number) => {
      sysTtls.set(k, s);
      return true;
    }),
    ttl: vi.fn(async (k: string) => sysTtls.get(k) ?? -1),
    get: vi.fn(async (k: string) => {
      const v = sysStore.get(k);
      return v == null ? null : String(v);
    }),
    set: vi.fn(
      async (k: string, val: string, opts?: { NX?: boolean; EX?: number }) => {
        if (opts?.NX && sysStore.has(k)) return null; // NX: only set when absent
        sysStore.set(k, val);
        if (opts?.EX != null) sysTtls.set(k, opts.EX);
        return 'OK';
      }
    ),
    del: vi.fn(async (k: string) => {
      const had = sysStore.has(k);
      sysStore.delete(k);
      sysTtls.delete(k);
      return had ? 1 : 0;
    }),
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
  REDIS_SYS_KEYS: {
    BLOCKS: { TIP_CAP: 'system:blocks:tip-cap', TIP_IDEM: 'system:blocks:tip-idem' },
  },
  REDIS_KEYS: { BLOCKS: { TOKEN_RATE_LIMIT: 'rl' } },
}));

import {
  BLOCK_TIP_CAP_PER_DAY,
  BLOCK_TIP_RATE_LIMIT_MAX,
  checkBlockTipRateLimit,
  claimTipIdempotency,
  finalizeTipIdempotency,
  readBlockTipAllowance,
  refundBlockTipSpend,
  releaseTipIdempotency,
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

describe('readBlockTipAllowance (item 4)', () => {
  it('returns full cap + remaining when nothing has been tipped today', async () => {
    const a = await readBlockTipAllowance(42);
    expect(a).toEqual({ cap: BLOCK_TIP_CAP_PER_DAY, spent: 0, remaining: BLOCK_TIP_CAP_PER_DAY });
  });

  it('reflects a reservation: spent tracks the counter, remaining = cap - spent', async () => {
    await reserveBlockTipSpend(42, 4_000);
    const a = await readBlockTipAllowance(42);
    expect(a.cap).toBe(BLOCK_TIP_CAP_PER_DAY);
    expect(a.spent).toBe(4_000);
    expect(a.remaining).toBe(BLOCK_TIP_CAP_PER_DAY - 4_000);
  });

  it('reads the CURRENT-day key (same key the reserve path mutates)', async () => {
    await reserveBlockTipSpend(7, 100);
    await readBlockTipAllowance(7);
    expect(mockSys.get).toHaveBeenCalledWith(`system:blocks:tip-cap:7:${TODAY}`);
  });

  it('CLAMPS remaining at 0 when a straddling over-cap reservation pushed spent past the cap', async () => {
    await reserveBlockTipSpend(42, BLOCK_TIP_CAP_PER_DAY + 500); // momentarily over-cap
    const a = await readBlockTipAllowance(42);
    expect(a.spent).toBe(BLOCK_TIP_CAP_PER_DAY + 500);
    expect(a.remaining).toBe(0); // never negative (safe direction: under-reports)
  });

  it('FAILS-CLOSED (throws) on a redis error — the endpoint maps it to a 503', async () => {
    mockSys.get.mockRejectedValueOnce(new Error('redis down'));
    await expect(readBlockTipAllowance(42)).rejects.toThrow();
  });
});

describe('tip idempotency (item 2, tip half)', () => {
  it('first claim ACQUIRES the key with an in-progress sentinel + short TTL', async () => {
    const r = await claimTipIdempotency(42, 'key-1');
    expect(r.state).toBe('acquired');
    if (r.state !== 'acquired') throw new Error('unreachable');
    expect(r.key).toBe('system:blocks:tip-idem:42:key-1');
    // Sentinel set NX with a TTL (bounded so a lost finalize can't wedge forever).
    expect(mockSys.set).toHaveBeenCalledWith(
      'system:blocks:tip-idem:42:key-1',
      expect.any(String),
      expect.objectContaining({ NX: true, EX: expect.any(Number) })
    );
  });

  it('a concurrent claim while the first is IN PROGRESS returns in_progress (never a 2nd run)', async () => {
    await claimTipIdempotency(42, 'key-2'); // acquires, leaves the sentinel
    const second = await claimTipIdempotency(42, 'key-2');
    expect(second.state).toBe('in_progress');
  });

  it('after finalize, a replay returns the cached TERMINAL result verbatim (no 2nd charge)', async () => {
    const first = await claimTipIdempotency(42, 'key-3');
    if (first.state !== 'acquired') throw new Error('expected acquired');
    await finalizeTipIdempotency(first.key, 200, {
      ok: true,
      tip: { toUserId: 5, amount: 25, entityType: null, entityId: null },
    });

    const replay = await claimTipIdempotency(42, 'key-3');
    expect(replay.state).toBe('replay');
    if (replay.state !== 'replay') throw new Error('unreachable');
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({
      ok: true,
      tip: { toUserId: 5, amount: 25, entityType: null, entityId: null },
    });
  });

  it('a terminal 4xx is cached + replayed too (deterministic replay of the first outcome)', async () => {
    const first = await claimTipIdempotency(42, 'key-4');
    if (first.state !== 'acquired') throw new Error('expected acquired');
    await finalizeTipIdempotency(first.key, 400, { ok: false, error: 'insufficient funds' });

    const replay = await claimTipIdempotency(42, 'key-4');
    expect(replay).toMatchObject({ state: 'replay', status: 400 });
  });

  it('release DELETES the sentinel so a genuine retry (after a transient 429/503) can re-run', async () => {
    const first = await claimTipIdempotency(42, 'key-5');
    if (first.state !== 'acquired') throw new Error('expected acquired');
    await releaseTipIdempotency(first.key);
    // The key is gone → a retry ACQUIRES fresh (re-executes), not 409-in-progress.
    const retry = await claimTipIdempotency(42, 'key-5');
    expect(retry.state).toBe('acquired');
  });

  it('a MALFORMED stored value is treated as in_progress (never re-run — fail safe)', async () => {
    // Simulate a corrupt record (not the sentinel, not valid JSON with a status).
    await mockSys.set('system:blocks:tip-idem:42:key-6', '{not-json');
    const r = await claimTipIdempotency(42, 'key-6');
    expect(r.state).toBe('in_progress');
  });

  it('claim FAILS-CLOSED (throws) on a redis error at claim time (money path → 503)', async () => {
    mockSys.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(claimTipIdempotency(42, 'key-7')).rejects.toThrow();
  });

  it('finalize is best-effort — a redis error never throws (must not perturb a shipped response)', async () => {
    mockSys.set.mockRejectedValueOnce(new Error('redis blip'));
    await expect(
      finalizeTipIdempotency('system:blocks:tip-idem:42:k' as never, 200, { ok: true })
    ).resolves.toBeUndefined();
  });

  it('two DIFFERENT keys claim independently (a distinct logical tip is not deduped)', async () => {
    const a = await claimTipIdempotency(42, 'key-8a');
    const b = await claimTipIdempotency(42, 'key-8b');
    expect(a.state).toBe('acquired');
    expect(b.state).toBe('acquired');
  });
});
