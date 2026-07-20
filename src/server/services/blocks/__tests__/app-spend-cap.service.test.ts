import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G8 — per-APP aggregate generation-SPEND + VELOCITY cap. This is the dual of
 * the per-USER `BLOCK_BUZZ_CAP_PER_DAY`: it bounds the daily block-initiated
 * generation SPEND (Buzz) AND the short-window generation VELOCITY funnelled
 * through ONE app across ALL viewers, so a Sybil ring of many accounts (each
 * under its own per-user ceiling) can't drive unbounded aggregate spend through
 * one app.
 *
 * The interesting surface:
 *   - per-APP daily-Buzz key shape (appBlockId + UTC-day, NOT spender userId)
 *   - atomic INCRBY-with-TTL RESERVE-AND-REFUND (all-or-nothing: a denied submit
 *     leaves the daily counter exactly where it was)
 *   - independent VELOCITY ceiling (per-app gen count over a short window),
 *     enforced even for 0-cost gens
 *   - SYBIL case: many viewers each spending a little can never exceed the cap
 *   - fail-safe: a Redis error DENIES (no spend), rolling back a partial reserve
 *   - pinned-key refund on the throw path
 *
 * sysRedis is a stateful in-memory fake so the atomic INCRBY accumulation (the
 * whole point of the TOCTOU-safe design) is exercised for real.
 */

const SPEND_CAP_PREFIX = 'system:blocks:app-spend-cap';

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
    ttl: vi.fn(async (key: string) => (ttls.has(key) ? ttls.get(key)! : 1000)),
  };
  return { store, ttls, mockSysRedis };
});

vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSysRedis,
  REDIS_SYS_KEYS: { BLOCKS: { APP_SPEND_CAP: 'system:blocks:app-spend-cap' } },
}));

import {
  BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY,
  BLOCK_APP_SPEND_VELOCITY_MAX_GENS,
  reserveAppSpend,
  refundAppSpend,
} from '../app-spend-cap.service';

const APP_BLOCK_ID = 'apb_test';

function dailyKey(app = APP_BLOCK_ID): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${SPEND_CAP_PREFIX}:${app}:${today}`;
}

beforeEach(() => {
  store.clear();
  ttls.clear();
  mockSysRedis.incrBy.mockClear();
  mockSysRedis.decrBy.mockClear();
  mockSysRedis.expire.mockClear();
  mockSysRedis.ttl.mockClear();
  mockSysRedis.incrBy.mockImplementation(async (key: string, n: number) => {
    const next = (store.get(key) ?? 0) + n;
    store.set(key, next);
    return next;
  });
  mockSysRedis.decrBy.mockImplementation(async (key: string, n: number) => {
    const next = (store.get(key) ?? 0) - n;
    store.set(key, next);
    return next;
  });
  mockSysRedis.ttl.mockImplementation(async (key: string) => (ttls.has(key) ? ttls.get(key)! : 1000));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cap constants', () => {
  it('are positive integers with the documented defaults', () => {
    expect(Number.isInteger(BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY)).toBe(true);
    expect(BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY).toBe(5_000_000);
    expect(BLOCK_APP_SPEND_VELOCITY_MAX_GENS).toBe(120);
  });
});

describe('reserveAppSpend — DAILY Buzz aggregate', () => {
  it('allows a spend under the cap and arms the TTL on the first daily write', async () => {
    const res = await reserveAppSpend(APP_BLOCK_ID, 100);
    expect(res.allowed).toBe(true);
    expect(res.dailyTotal).toBe(100);
    expect(res.dailyKey).toBe(dailyKey());
    // daily INCRBY(100) + velocity INCRBY(1)
    expect(mockSysRedis.incrBy).toHaveBeenCalledWith(dailyKey(), 100);
    // TTL armed on the first daily write.
    expect(mockSysRedis.expire).toHaveBeenCalledWith(dailyKey(), expect.any(Number));
    expect(store.get(dailyKey())).toBe(100);
  });

  it('keys PER-APP + UTC-day (appBlockId in the key, spender userId is NOT)', async () => {
    await reserveAppSpend(APP_BLOCK_ID, 10);
    await reserveAppSpend('apb_other', 10);
    // Each app has its OWN daily counter; one cannot consume the other's headroom.
    expect(store.get(dailyKey(APP_BLOCK_ID))).toBe(10);
    expect(store.get(dailyKey('apb_other'))).toBe(10);
  });

  it('DENIES + REFUNDS (all-or-nothing) when the spend would exceed the daily cap', async () => {
    const cap = BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY;
    // Pre-fill to just under the cap.
    await reserveAppSpend(APP_BLOCK_ID, cap - 10);
    mockSysRedis.decrBy.mockClear();

    // Next spend of 100 would push over → deny + full refund (not a clamp).
    const res = await reserveAppSpend(APP_BLOCK_ID, 100);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('daily');
    // The full 100 was refunded — the counter converges back to (cap - 10), so a
    // smaller spend that DOES fit can still land afterward.
    expect(mockSysRedis.decrBy).toHaveBeenCalledWith(dailyKey(), 100);
    expect(store.get(dailyKey())).toBe(cap - 10);

    const smaller = await reserveAppSpend(APP_BLOCK_ID, 5);
    expect(smaller.allowed).toBe(true);
    expect(store.get(dailyKey())).toBe(cap - 5);
  });

  it('SYBIL CASE: many viewers each spending a little can never exceed the per-app daily cap', async () => {
    // Use a small env-independent expectation: drive spends of `cap/10 + 1` so
    // the 11th is guaranteed to breach regardless of the exact default.
    const cap = BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY;
    const chunk = Math.floor(cap / 10);
    let allowed = 0;
    let denied = 0;
    // 20 distinct "viewers" (userId is NOT in the key) each try to spend `chunk`.
    for (let i = 0; i < 20; i++) {
      const r = await reserveAppSpend(APP_BLOCK_ID, chunk);
      r.allowed ? allowed++ : denied++;
    }
    // At most `floor(cap/chunk)` can land; the rest are denied. The app's total
    // is bounded by the cap regardless of how many sockpuppets fan the spend out.
    expect(store.get(dailyKey())! <= cap).toBe(true);
    expect(allowed).toBeLessThanOrEqual(10);
    expect(denied).toBeGreaterThan(0);
  });

  it('a 0-cost gen never touches the daily counter but is still allowed', async () => {
    const res = await reserveAppSpend(APP_BLOCK_ID, 0);
    expect(res.allowed).toBe(true);
    expect(res.dailyKey).toBeUndefined();
    // No daily INCRBY — only the velocity INCRBY(1) fired.
    expect(mockSysRedis.incrBy).toHaveBeenCalledTimes(1);
    expect(store.get(dailyKey())).toBeUndefined();
  });
});

describe('reserveAppSpend — VELOCITY', () => {
  it('DENIES + REFUNDS the daily reserve when the short-window gen ceiling is exceeded', async () => {
    const max = BLOCK_APP_SPEND_VELOCITY_MAX_GENS;
    // Fill the velocity window exactly to the max (each 1-Buzz spend both counts
    // toward daily + velocity).
    for (let i = 0; i < max; i++) {
      const r = await reserveAppSpend(APP_BLOCK_ID, 1);
      expect(r.allowed).toBe(true);
    }
    const dailyBefore = store.get(dailyKey());
    mockSysRedis.decrBy.mockClear();

    // The (max+1)th gen breaches velocity → deny + refund the daily reserve for it.
    const res = await reserveAppSpend(APP_BLOCK_ID, 1);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('velocity');
    // The daily reserve made for THIS denied gen was refunded (net daily unchanged).
    expect(mockSysRedis.decrBy).toHaveBeenCalledWith(dailyKey(), 1);
    expect(store.get(dailyKey())).toBe(dailyBefore);
  });

  it('enforces velocity even for 0-cost gens (a burst of cache-hits is bounded)', async () => {
    const max = BLOCK_APP_SPEND_VELOCITY_MAX_GENS;
    let denied = 0;
    for (let i = 0; i < max + 5; i++) {
      const r = await reserveAppSpend(APP_BLOCK_ID, 0);
      if (!r.allowed) denied++;
    }
    expect(denied).toBe(5);
  });
});

describe('reserveAppSpend — fail-safe on a Redis error', () => {
  it('DENIES (no spend) and rolls back a partial daily reserve when the velocity INCRBY throws', async () => {
    // Daily INCRBY succeeds, then the velocity INCRBY throws.
    let call = 0;
    mockSysRedis.incrBy.mockImplementation(async (key: string, n: number) => {
      call++;
      if (call === 1) {
        const next = (store.get(key) ?? 0) + n;
        store.set(key, next);
        return next;
      }
      throw new Error('redis down');
    });

    const res = await reserveAppSpend(APP_BLOCK_ID, 100);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('unavailable');
    // The partial daily reservation was rolled back → counter back to 0.
    expect(mockSysRedis.decrBy).toHaveBeenCalledWith(dailyKey(), 100);
    expect(store.get(dailyKey())).toBe(0);
  });
});

describe('refundAppSpend', () => {
  it('decrements the pinned key by the refunded amount', async () => {
    const res = await reserveAppSpend(APP_BLOCK_ID, 100);
    expect(res.dailyKey).toBeDefined();
    await refundAppSpend(res.dailyKey!, 100);
    expect(store.get(dailyKey())).toBe(0);
  });

  it('is a no-op for non-positive amounts (no Redis call)', async () => {
    mockSysRedis.decrBy.mockClear();
    await refundAppSpend(dailyKey() as `system:blocks:app-spend-cap:${string}`, 0);
    await refundAppSpend(dailyKey() as `system:blocks:app-spend-cap:${string}`, -5);
    expect(mockSysRedis.decrBy).not.toHaveBeenCalled();
  });

  it('swallows a Redis error (best-effort — a lost refund only makes the cap stricter)', async () => {
    mockSysRedis.decrBy.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      refundAppSpend(dailyKey() as `system:blocks:app-spend-cap:${string}`, 10)
    ).resolves.toBeUndefined();
  });
});
