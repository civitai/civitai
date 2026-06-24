import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Per-APP spend-BOUNTY accrual cap (audit 🟡-2 / App-Blocks Sybil-economics
 * review). This is the dual of the per-USER `BLOCK_BUZZ_CAP_PER_DAY`: it bounds
 * the daily platform-funded BOUNTY (USD cents) accrued toward ONE app across
 * ALL viewers, so a Sybil ring of many accounts can't funnel unbounded bounty
 * at one author.
 *
 * The interesting surface:
 *   - DORMANT by construction: a 0 share never touches Redis and grants 0
 *     (this is what keeps the cap a no-op while spendSharePct=0 today)
 *   - per-APP key shape (appBlockId + UTC-day, NOT spender userId)
 *   - atomic INCRBY-with-TTL reservation (TTL armed on first write)
 *   - clamp + overshoot-refund when the cap is hit, including the SYBIL case
 *     (many small reservations across many viewers converging to the cap)
 *   - pinned-key refund on the failure/duplicate path
 *
 * sysRedis is replaced with a stateful in-memory fake so the atomic INCRBY
 * accumulation (the whole point of the TOCTOU-safe design) is exercised for
 * real rather than stubbed per-call.
 */

const BOUNTY_CAP_PREFIX = 'system:blocks:bounty-cap';

// Stateful in-memory Redis: counters + TTLs. INCRBY/DECRBY accumulate so a
// sequence of reservations (the concurrency / Sybil case) behaves like the
// real atomic counter.
const { store, ttls, mockSysRedis } = vi.hoisted(() => {
  const store = new Map<string, number>();
  const ttls = new Map<string, number>();
  const mockSysRedis = {
    incrBy: vi.fn(async (key: string, n: number) => {
      const next = (store.get(key) ?? 0) + n;
      store.set(key, next);
      return next;
    }),
    decrBy: vi.fn(async (key: string, n: number) => {
      const next = (store.get(key) ?? 0) - n;
      store.set(key, next);
      return next;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      ttls.set(key, seconds);
      return 1;
    }),
    // Default: key has a TTL (so the re-arm branch is NOT taken). Overridden in
    // the "re-arms a TTL-less key" test.
    ttl: vi.fn(async (key: string) => (ttls.has(key) ? ttls.get(key)! : 1000)),
  };
  return { store, ttls, mockSysRedis };
});

vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSysRedis,
  // Literal inlined (vi.mock factory is hoisted above module-scope consts).
  REDIS_SYS_KEYS: { BLOCKS: { BOUNTY_CAP: 'system:blocks:bounty-cap' } },
}));

import {
  BLOCK_APP_BOUNTY_CAP_CENTS_PER_DAY,
  reserveAppBountyAccrual,
  refundAppBountyAccrual,
} from '../app-bounty-cap.service';

const APP_BLOCK_ID = 'apb_test';

beforeEach(() => {
  store.clear();
  ttls.clear();
  mockSysRedis.incrBy.mockClear();
  mockSysRedis.decrBy.mockClear();
  mockSysRedis.expire.mockClear();
  mockSysRedis.ttl.mockClear();
  mockSysRedis.ttl.mockImplementation(async (key: string) =>
    ttls.has(key) ? ttls.get(key)! : 1000
  );
});

describe('BLOCK_APP_BOUNTY_CAP_CENTS_PER_DAY', () => {
  it('is a positive integer placeholder (the documented $250/day starting point)', () => {
    expect(Number.isInteger(BLOCK_APP_BOUNTY_CAP_CENTS_PER_DAY)).toBe(true);
    expect(BLOCK_APP_BOUNTY_CAP_CENTS_PER_DAY).toBeGreaterThan(0);
    // 25_000 cents = $250/day. Asserting the default so a silent change to the
    // placeholder (which NEEDS LEADERSHIP SIGN-OFF) trips this test.
    expect(BLOCK_APP_BOUNTY_CAP_CENTS_PER_DAY).toBe(25_000);
  });
});

describe('reserveAppBountyAccrual — DORMANT (the track-only case today)', () => {
  it('share=0 grants 0 and NEVER touches Redis (true-by-construction no-op)', async () => {
    const res = await reserveAppBountyAccrual(APP_BLOCK_ID, 0);
    expect(res.grantedCents).toBe(0);
    expect(res.clamped).toBe(false);
    expect(res.total).toBe(0);
    // The whole point: while spendSharePct=0 the cap path adds ZERO behaviour
    // and ZERO Redis load.
    expect(mockSysRedis.incrBy).not.toHaveBeenCalled();
    expect(mockSysRedis.expire).not.toHaveBeenCalled();
    expect(mockSysRedis.decrBy).not.toHaveBeenCalled();
  });

  it('negative / fractional sub-zero share is also a no-op (defensive)', async () => {
    const res = await reserveAppBountyAccrual(APP_BLOCK_ID, -50);
    expect(res.grantedCents).toBe(0);
    expect(mockSysRedis.incrBy).not.toHaveBeenCalled();
  });
});

describe('reserveAppBountyAccrual — ENFORCED (when a future rate makes the share > 0)', () => {
  it('grants the full share under the cap and arms the TTL on first write', async () => {
    const res = await reserveAppBountyAccrual(APP_BLOCK_ID, 100);
    expect(res.grantedCents).toBe(100);
    expect(res.clamped).toBe(false);
    expect(res.total).toBe(100);
    // Atomic INCRBY by the share.
    expect(mockSysRedis.incrBy).toHaveBeenCalledTimes(1);
    expect(mockSysRedis.incrBy.mock.calls[0][1]).toBe(100);
    // TTL armed on the (effectively) first write.
    expect(mockSysRedis.expire).toHaveBeenCalledTimes(1);
    // No refund when under the cap.
    expect(mockSysRedis.decrBy).not.toHaveBeenCalled();
  });

  it('keys PER-APP + UTC-day (appBlockId in the key, spender userId is NOT)', async () => {
    await reserveAppBountyAccrual(APP_BLOCK_ID, 10);
    const key = String(mockSysRedis.incrBy.mock.calls[0][0]);
    const today = new Date().toISOString().slice(0, 10);
    expect(key).toBe(`${BOUNTY_CAP_PREFIX}:${APP_BLOCK_ID}:${today}`);
    // Two different apps get two different counters; one app's accrual cannot
    // consume another's headroom.
    await reserveAppBountyAccrual('apb_other', 10);
    const otherKey = String(mockSysRedis.incrBy.mock.calls[1][0]);
    expect(otherKey).not.toBe(key);
    expect(otherKey).toContain('apb_other');
  });

  it('clamps to the remaining headroom and refunds the overshoot when the cap is hit', async () => {
    // Pre-fill the counter to just under the cap.
    const cap = BLOCK_APP_BOUNTY_CAP_CENTS_PER_DAY;
    // First reservation lands the app at cap - 30.
    await reserveAppBountyAccrual(APP_BLOCK_ID, cap - 30);
    mockSysRedis.incrBy.mockClear();
    mockSysRedis.decrBy.mockClear();

    // Next reservation wants 100 but only 30 of headroom remains.
    const res = await reserveAppBountyAccrual(APP_BLOCK_ID, 100);
    expect(res.clamped).toBe(true);
    expect(res.grantedCents).toBe(30); // only the headroom is accrued
    expect(res.total).toBe(cap + 70); // pre-refund running total

    // Overshoot (100 - 30 = 70) refunded against the SAME key.
    expect(mockSysRedis.decrBy).toHaveBeenCalledTimes(1);
    expect(mockSysRedis.decrBy.mock.calls[0][1]).toBe(70);
    expect(String(mockSysRedis.decrBy.mock.calls[0][0])).toBe(
      String(mockSysRedis.incrBy.mock.calls[0][0])
    );
    // Counter converged to exactly the cap (so a later viewer sees 0 headroom).
    const today = new Date().toISOString().slice(0, 10);
    expect(store.get(`${BOUNTY_CAP_PREFIX}:${APP_BLOCK_ID}:${today}`)).toBe(cap);
  });

  it('grants 0 once the app is already AT the cap (subsequent viewers get nothing)', async () => {
    const cap = BLOCK_APP_BOUNTY_CAP_CENTS_PER_DAY;
    await reserveAppBountyAccrual(APP_BLOCK_ID, cap); // exactly fills the cap
    const res = await reserveAppBountyAccrual(APP_BLOCK_ID, 50);
    expect(res.grantedCents).toBe(0);
    expect(res.clamped).toBe(true);
    // Full overshoot refunded → counter stays pinned at the cap.
    const today = new Date().toISOString().slice(0, 10);
    expect(store.get(`${BOUNTY_CAP_PREFIX}:${APP_BLOCK_ID}:${today}`)).toBe(cap);
  });

  it('SYBIL CASE: many viewers each spending a little can never exceed the per-app cap', async () => {
    // 1000 distinct "viewers" (the spender userId does not appear in the key —
    // that is exactly what the per-user cap is blind to) each accrue 50 cents
    // of bounty through the SAME app. Naively that is 50_000 cents = 2× the cap.
    const cap = BLOCK_APP_BOUNTY_CAP_CENTS_PER_DAY;
    let totalGranted = 0;
    for (let i = 0; i < 1000; i++) {
      const { grantedCents } = await reserveAppBountyAccrual(APP_BLOCK_ID, 50);
      totalGranted += grantedCents;
    }
    // The app's TOTAL accrued bounty is bounded by the cap regardless of how
    // many sockpuppets fan the spend out.
    expect(totalGranted).toBe(cap);
    const today = new Date().toISOString().slice(0, 10);
    expect(store.get(`${BOUNTY_CAP_PREFIX}:${APP_BLOCK_ID}:${today}`)).toBe(cap);
  });

  it('re-arms the TTL on a key that somehow lost it', async () => {
    // First reservation creates + arms the key.
    await reserveAppBountyAccrual(APP_BLOCK_ID, 10);
    const today = new Date().toISOString().slice(0, 10);
    const key = `${BOUNTY_CAP_PREFIX}:${APP_BLOCK_ID}:${today}`;
    // Simulate a key that lost its TTL (ttl < 0).
    ttls.delete(key);
    mockSysRedis.ttl.mockImplementation(async (k: string) => (k === key ? -1 : 1000));
    mockSysRedis.expire.mockClear();

    await reserveAppBountyAccrual(APP_BLOCK_ID, 10);
    // The re-arm branch fired.
    expect(mockSysRedis.expire).toHaveBeenCalledTimes(1);
    expect(mockSysRedis.expire.mock.calls[0][0]).toBe(key);
  });
});

describe('refundAppBountyAccrual', () => {
  it('decrements the pinned key by the refunded amount', async () => {
    await reserveAppBountyAccrual(APP_BLOCK_ID, 100);
    const today = new Date().toISOString().slice(0, 10);
    const key = `${BOUNTY_CAP_PREFIX}:${APP_BLOCK_ID}:${today}` as const;
    await refundAppBountyAccrual(key, 40);
    expect(store.get(key)).toBe(60);
  });

  it('is a no-op for non-positive amounts (no Redis call)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const key = `${BOUNTY_CAP_PREFIX}:${APP_BLOCK_ID}:${today}` as const;
    mockSysRedis.decrBy.mockClear();
    await refundAppBountyAccrual(key, 0);
    await refundAppBountyAccrual(key, -5);
    expect(mockSysRedis.decrBy).not.toHaveBeenCalled();
  });

  it('swallows a Redis error (best-effort — a lost refund only makes the cap stricter)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const key = `${BOUNTY_CAP_PREFIX}:${APP_BLOCK_ID}:${today}` as const;
    mockSysRedis.decrBy.mockRejectedValueOnce(new Error('redis down'));
    await expect(refundAppBountyAccrual(key, 10)).resolves.toBeUndefined();
  });
});
