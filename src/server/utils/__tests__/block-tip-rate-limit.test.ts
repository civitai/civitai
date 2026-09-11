import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    set: vi.fn(async (k: string, val: string, opts?: { NX?: boolean; EX?: number }) => {
      if (opts?.NX && sysStore.has(k)) return null; // NX: only set when absent
      sysStore.set(k, val);
      if (opts?.EX != null) sysTtls.set(k, opts.EX);
      return 'OK';
    }),
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
  computeTipFingerprint,
  finalizeTipIdempotency,
  readBlockTipAllowance,
  refundBlockTipSpend,
  releaseTipIdempotency,
  reserveBlockTipSpend,
} from '../block-tip-rate-limit';

/**
 * Mid-day on purpose: 12 hours from either UTC midnight. The tip cap's key is a
 * UTC-day string, so the day rollover is the only boundary that matters here.
 */
const FROZEN_CLOCK = new Date('2026-07-31T12:00:30Z');

/**
 * 🔴 A LITERAL, NOT A DERIVATION — the UTC day of `FROZEN_CLOCK`, written out.
 *
 * It is deliberately NOT computed as `new Date().toISOString().slice(0, 10)`.
 * That is byte-identical to the expression the implementation uses
 * (`tipCapWindowKey` in `../block-tip-rate-limit`), so an expectation built that
 * way moves WITH the implementation — the "never derive a test's expectation
 * from the implementation it tests" trap. The literal is an INDEPENDENT
 * expectation, and it is also simply less machinery.
 *
 * 🔴 BE PRECISE ABOUT WHAT THAT BUYS — AN EARLIER VERSION OF THIS COMMENT
 * OVERSOLD IT AND WAS FALSE. It claimed that switching production to a
 * LOCAL-date derivation would still be caught here. MEASURED, mutating
 * `tipCapWindowKey` to `toLocaleDateString('en-CA')`: the literal SURVIVES
 * under `TZ=UTC` and `America/Winnipeg` (29/29) and dies only at UTC+13/+14.
 * `FROZEN_CLOCK` is 12:00:30Z, so the local and UTC dates agree at every offset
 * inside ±12h — every deployment TZ, CI's UTC included. The control that
 * settles it: a FROZEN-but-DERIVED expectation survives that same mutant
 * (29/29 at both TZs), so against it the two forms are EQUIVALENT, not
 * better-and-worse. (The unfrozen base did catch it — but only through the
 * import-vs-call-time skew that is the bug being fixed, so that is not
 * coverage worth preserving.)
 *
 * Choose the literal for INDEPENDENCE and simplicity, which are real. Do not
 * claim a detection property it does not have.
 *
 * ⚠️ A second, separate trap, recorded in case anyone reintroduces a derived
 * value here: this day string used to be a module-level `const`, evaluated at
 * IMPORT. A `beforeEach` freeze cannot move such a constant — it is already
 * computed — so it keeps the real date while the service returns the frozen one.
 * MEASURED: freeze-only fails 2 of 29 with `expected
 * 'system:blocks:tip-cap:42:2026-07-31' to be
 * 'system:blocks:tip-cap:42:2026-09-10'`. A literal sidesteps that entirely,
 * because it reads no clock at all.
 */
const FROZEN_DAY = '2026-07-31';

beforeEach(() => {
  // 🔴 FIRST, before the service derives any key. This pins what the SERVICE
  // computes; `FROZEN_DAY` above is the independent literal the assertions
  // compare against. Both are needed, and neither derives from the other.
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_CLOCK);
  vi.clearAllMocks();
  sysStore.clear();
  sysTtls.clear();
  cacheStore.clear();
  cacheTtls.clear();
});

afterEach(() => {
  // Hand the clock back so a fake timer cannot leak into a later file.
  vi.useRealTimers();
});

describe('reserveBlockTipSpend', () => {
  it('reserves the amount, returns a UTC-day-scoped key, and SETS the TTL on the first write', async () => {
    const { total, key } = await reserveBlockTipSpend(42, 100);
    expect(total).toBe(100);
    expect(key).toBe(`system:blocks:tip-cap:42:${FROZEN_DAY}`);
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
    expect(sysStore.get(`system:blocks:tip-cap:42:${FROZEN_DAY}`)).toBeUndefined();
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
    expect(mockSys.get).toHaveBeenCalledWith(`system:blocks:tip-cap:7:${FROZEN_DAY}`);
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
  // A stable fingerprint for the "same logical tip" across a retry, and a DIFFERENT
  // one for a same-key-different-payload replay (audit 🟡-1 residual).
  const FP = computeTipFingerprint({ toUserId: 5, amount: 25 });
  const FP_OTHER = computeTipFingerprint({ toUserId: 9, amount: 25 });

  it('first claim ACQUIRES the key with an in-progress record + short TTL', async () => {
    const r = await claimTipIdempotency(42, 'apb_x', 'key-1', FP);
    expect(r.state).toBe('acquired');
    if (r.state !== 'acquired') throw new Error('unreachable');
    // audit 🟡-2: the key carries the APP segment so two apps can't share a slot.
    expect(r.key).toBe('system:blocks:tip-idem:42:apb_x:key-1');
    // In-progress record set NX with a TTL (bounded so a lost finalize can't wedge
    // forever), carrying the fingerprint but NO terminal status.
    expect(mockSys.set).toHaveBeenCalledWith(
      'system:blocks:tip-idem:42:apb_x:key-1',
      JSON.stringify({ fp: FP }),
      expect.objectContaining({ NX: true, EX: expect.any(Number) })
    );
  });

  it('a concurrent claim while the first is IN PROGRESS returns in_progress (never a 2nd run)', async () => {
    await claimTipIdempotency(42, 'apb_x', 'key-2', FP); // acquires, leaves the record
    const second = await claimTipIdempotency(42, 'apb_x', 'key-2', FP);
    expect(second.state).toBe('in_progress');
  });

  it('after finalize, a replay returns the cached TERMINAL result verbatim (no 2nd charge)', async () => {
    const first = await claimTipIdempotency(42, 'apb_x', 'key-3', FP);
    if (first.state !== 'acquired') throw new Error('expected acquired');
    await finalizeTipIdempotency(
      first.key,
      200,
      { ok: true, tip: { toUserId: 5, amount: 25, entityType: null, entityId: null } },
      FP
    );

    const replay = await claimTipIdempotency(42, 'apb_x', 'key-3', FP);
    expect(replay.state).toBe('replay');
    if (replay.state !== 'replay') throw new Error('unreachable');
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({
      ok: true,
      tip: { toUserId: 5, amount: 25, entityType: null, entityId: null },
    });
  });

  it('a terminal 4xx is cached + replayed too (deterministic replay of the first outcome)', async () => {
    const first = await claimTipIdempotency(42, 'apb_x', 'key-4', FP);
    if (first.state !== 'acquired') throw new Error('expected acquired');
    await finalizeTipIdempotency(first.key, 400, { ok: false, error: 'insufficient funds' }, FP);

    const replay = await claimTipIdempotency(42, 'apb_x', 'key-4', FP);
    expect(replay).toMatchObject({ state: 'replay', status: 400 });
  });

  it('release DELETES the record so a genuine retry (after a transient 429/503) can re-run', async () => {
    const first = await claimTipIdempotency(42, 'apb_x', 'key-5', FP);
    if (first.state !== 'acquired') throw new Error('expected acquired');
    await releaseTipIdempotency(first.key);
    // The key is gone -> a retry ACQUIRES fresh (re-executes), not 409-in-progress.
    const retry = await claimTipIdempotency(42, 'apb_x', 'key-5', FP);
    expect(retry.state).toBe('acquired');
  });

  it('a MALFORMED stored value is treated as in_progress (never re-run — fail safe)', async () => {
    // Simulate a corrupt record (not valid JSON).
    await mockSys.set('system:blocks:tip-idem:42:apb_x:key-6', '{not-json');
    const r = await claimTipIdempotency(42, 'apb_x', 'key-6', FP);
    expect(r.state).toBe('in_progress');
  });

  it('claim FAILS-CLOSED (throws) on a redis error at claim time (money path → 503)', async () => {
    mockSys.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(claimTipIdempotency(42, 'apb_x', 'key-7', FP)).rejects.toThrow();
  });

  it('finalize is best-effort — a redis error never throws (must not perturb a shipped response)', async () => {
    mockSys.set.mockRejectedValueOnce(new Error('redis blip'));
    await expect(
      finalizeTipIdempotency('system:blocks:tip-idem:42:apb_x:k' as never, 200, { ok: true }, FP)
    ).resolves.toBeUndefined();
  });

  it('two DIFFERENT keys claim independently (a distinct logical tip is not deduped)', async () => {
    const a = await claimTipIdempotency(42, 'apb_x', 'key-8a', FP);
    const b = await claimTipIdempotency(42, 'apb_x', 'key-8b', FP);
    expect(a.state).toBe('acquired');
    expect(b.state).toBe('acquired');
  });

  // ── audit 🟡-2: cross-app replay leak ────────────────────────────────────────
  describe('per-APP scoping (audit 🟡-2)', () => {
    it('the SAME key value in a DIFFERENT app claims independently — no cross-app replay', async () => {
      const a = await claimTipIdempotency(42, 'apb_appA', 'tip1', FP);
      expect(a.state).toBe('acquired');
      if (a.state !== 'acquired') throw new Error('unreachable');
      await finalizeTipIdempotency(a.key, 200, { ok: true, tip: { toUserId: 5, amount: 25 } }, FP);

      // App B hardcodes the SAME literal key. It must NOT receive app A's cached
      // body (which would leak A's recipient + amount) and its own tip must run.
      const b = await claimTipIdempotency(42, 'apb_appB', 'tip1', FP);
      expect(b.state).toBe('acquired');
      if (b.state !== 'acquired') throw new Error('unreachable');
      expect(b.key).not.toBe(a.key);
    });

    it('keys are injective across (user, app, key)', async () => {
      const claims = await Promise.all([
        claimTipIdempotency(42, 'apb_x', 'k', FP),
        claimTipIdempotency(42, 'apb_y', 'k', FP), // different app
        claimTipIdempotency(99, 'apb_x', 'k', FP), // different user
      ]);
      const keys = claims.map((c) => (c.state === 'acquired' ? c.key : ''));
      expect(new Set(keys).size).toBe(3);
    });
  });

  // ── audit 🟡-1 residual: same key, different payload ──────────────────────────
  describe('payload fingerprint (audit 🟡-1 residual)', () => {
    it('MISMATCH: the same key with a DIFFERENT payload is rejected, not replayed', async () => {
      const first = await claimTipIdempotency(42, 'apb_x', 'reused', FP);
      if (first.state !== 'acquired') throw new Error('expected acquired');
      await finalizeTipIdempotency(first.key, 200, { ok: true, tip: { toUserId: 5 } }, FP);

      // Same key, DIFFERENT recipient. Replaying would tell the app a tip to user 9
      // succeeded when the money actually went to user 5.
      const reused = await claimTipIdempotency(42, 'apb_x', 'reused', FP_OTHER);
      expect(reused.state).toBe('mismatch');
    });

    it('MISMATCH is detected while the first attempt is still IN PROGRESS too', async () => {
      await claimTipIdempotency(42, 'apb_x', 'reused2', FP);
      const reused = await claimTipIdempotency(42, 'apb_x', 'reused2', FP_OTHER);
      expect(reused.state).toBe('mismatch');
    });

    it('the fingerprint distinguishes amount and entity, not just recipient', () => {
      const base = computeTipFingerprint({ toUserId: 5, amount: 25 });
      expect(computeTipFingerprint({ toUserId: 5, amount: 26 })).not.toBe(base);
      expect(computeTipFingerprint({ toUserId: 5, amount: 25, entityType: 'Image' })).not.toBe(
        base
      );
      expect(
        computeTipFingerprint({ toUserId: 5, amount: 25, entityType: 'Image', entityId: 1 })
      ).not.toBe(
        computeTipFingerprint({ toUserId: 5, amount: 25, entityType: 'Image', entityId: 2 })
      );
      // Stable for the SAME payload (a retry must replay, not 422).
      expect(computeTipFingerprint({ toUserId: 5, amount: 25 })).toBe(base);
    });
  });
});
