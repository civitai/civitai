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
 *   - 🔴 PER-APP LIMITS: the ceilings come from `resolveAppCapLimits` (the app's
 *     spendTier + any moderator override), NOT from one global constant. Every
 *     path that fails to resolve a limit must enforce the STRICTEST ceiling —
 *     never "uncapped".
 *
 * sysRedis is a stateful in-memory fake so the atomic INCRBY accumulation (the
 * whole point of the TOCTOU-safe design) is exercised for real. The limit
 * resolver is mocked so each case can pin the ceilings it is testing.
 */

const SPEND_CAP_PREFIX = 'system:blocks:app-spend-cap';

const { store, ttls, mockSysRedis, mockResolveAppCapLimits } = vi.hoisted(() => {
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
  const mockResolveAppCapLimits = vi.fn(
    async (_appBlockId: string): Promise<{ dailyBuzz: number; velocityMaxGens: number }> => ({
      dailyBuzz: 5_000_000,
      velocityMaxGens: 600,
    })
  );
  return { store, ttls, mockSysRedis, mockResolveAppCapLimits };
});

vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSysRedis,
  REDIS_SYS_KEYS: { BLOCKS: { APP_SPEND_CAP: 'system:blocks:app-spend-cap' } },
}));

vi.mock('~/server/services/blocks/app-cap-limits.service', () => ({
  resolveAppCapLimits: (appBlockId: string) => mockResolveAppCapLimits(appBlockId),
  invalidateAppCapLimits: vi.fn(),
  normalizeCapOverrideInput: vi.fn(),
  __resetAppCapLimitsCacheForTests: vi.fn(),
}));

import {
  APP_SPEND_TIER_CAP_LIMITS,
  APP_SPEND_TIERS,
  STRICTEST_APP_CAP_LIMITS,
  type AppCapLimits,
} from '../app-cap-limits.constants';
import {
  BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY,
  BLOCK_APP_SPEND_VELOCITY_MAX_GENS,
  BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS,
  reserveAppSpend,
  refundAppSpend,
} from '../app-spend-cap.service';

const APP_BLOCK_ID = 'apb_test';

/** Pin the ceilings the resolver hands back for this case. */
function setLimits(limits: AppCapLimits) {
  mockResolveAppCapLimits.mockResolvedValue(limits);
}

function dailyKey(app = APP_BLOCK_ID): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${SPEND_CAP_PREFIX}:${app}:${today}`;
}

function velocityKey(app = APP_BLOCK_ID): string {
  const bucket = Math.floor(Date.now() / 1000 / BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS);
  return `${SPEND_CAP_PREFIX}:vel:${app}:${bucket}`;
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
  // 🔴 `expire` needs its implementation RE-ESTABLISHED, not just `mockClear()`ed:
  // mockClear wipes call history but leaves any `mockRejectedValue` in place, so a
  // fault-injection case would leak its failure into every later test in the file.
  mockSysRedis.expire.mockImplementation(async (key: string, seconds: number) => {
    ttls.set(key, seconds);
    return 1;
  });
  mockResolveAppCapLimits.mockReset();
  // Default: the `trusted` tier (what review grants a busy app).
  mockResolveAppCapLimits.mockResolvedValue(APP_SPEND_TIER_CAP_LIMITS.trusted);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cap constants (the GLOBAL CEILINGS that clamp every tier)', () => {
  it('are positive integers with the documented defaults', () => {
    // 🔴 These are the absolute deploy-time CEILINGS, not the value any app
    // gets. They default to the hard bound — i.e. "no additional clamp" — so an
    // unset env changes nothing and a moderator's override means what they
    // typed. The per-app default is the `standard` spend tier (5,000,000 / 120),
    // asserted in app-cap-limits.constants.test.ts.
    expect(Number.isInteger(BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY)).toBe(true);
    expect(BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY).toBe(1_000_000_000);
    expect(BLOCK_APP_SPEND_VELOCITY_MAX_GENS).toBe(100_000);
    expect(BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS).toBe(60);
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
    const cap = APP_SPEND_TIER_CAP_LIMITS.trusted.dailyBuzz;
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
    const cap = APP_SPEND_TIER_CAP_LIMITS.trusted.dailyBuzz;
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
    const max = APP_SPEND_TIER_CAP_LIMITS.trusted.velocityMaxGens;
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
    const max = APP_SPEND_TIER_CAP_LIMITS.trusted.velocityMaxGens;
    let denied = 0;
    for (let i = 0; i < max + 5; i++) {
      const r = await reserveAppSpend(APP_BLOCK_ID, 0);
      if (!r.allowed) denied++;
    }
    expect(denied).toBe(5);
  });

  it('the FIXED WINDOW rolls over at floor(now/window) — a new bucket starts fresh', async () => {
    vi.useFakeTimers();
    // Land mid-bucket so the rollover is unambiguous.
    vi.setSystemTime(new Date('2026-07-31T12:00:30Z'));
    setLimits({ dailyBuzz: 5_000_000, velocityMaxGens: 3 });

    const firstBucketKey = velocityKey();
    for (let i = 0; i < 3; i++) expect((await reserveAppSpend(APP_BLOCK_ID, 0)).allowed).toBe(true);
    expect((await reserveAppSpend(APP_BLOCK_ID, 0)).allowed).toBe(false);
    expect(store.get(firstBucketKey)).toBe(4); // the denied attempt still burned a slot

    // +30s crosses into the next 60s bucket → a DIFFERENT key, count restarts.
    vi.setSystemTime(new Date('2026-07-31T12:01:00Z'));
    const secondBucketKey = velocityKey();
    expect(secondBucketKey).not.toBe(firstBucketKey);
    const after = await reserveAppSpend(APP_BLOCK_ID, 0);
    expect(after.allowed).toBe(true);
    expect(after.velocityCount).toBe(1);
    expect(store.get(secondBucketKey)).toBe(1);
    // The old bucket is untouched by the new window (it self-expires on its TTL).
    expect(store.get(firstBucketKey)).toBe(4);
  });

  it('arms the velocity TTL to exactly one window on the first write of a bucket', async () => {
    const res = await reserveAppSpend(APP_BLOCK_ID, 0);
    expect(res.allowed).toBe(true);
    expect(mockSysRedis.expire).toHaveBeenCalledWith(
      velocityKey(),
      BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS
    );
  });
});

describe('reserveAppSpend — PER-APP limits from the tier/override resolver', () => {
  it('resolves the limits for the SUBMITTING app id', async () => {
    await reserveAppSpend('apb_specific', 1);
    expect(mockResolveAppCapLimits).toHaveBeenCalledWith('apb_specific');
  });

  it.each(APP_SPEND_TIERS.map((t) => [t] as const))(
    'enforces the `%s` tier ceilings, not a global constant',
    async (tier) => {
      const limits = APP_SPEND_TIER_CAP_LIMITS[tier];
      setLimits(limits);

      // Exactly `velocityMaxGens` 0-cost gens fit; the next one is denied.
      for (let i = 0; i < limits.velocityMaxGens; i++) {
        expect((await reserveAppSpend(APP_BLOCK_ID, 0)).allowed).toBe(true);
      }
      const over = await reserveAppSpend(APP_BLOCK_ID, 0);
      expect(over.allowed).toBe(false);
      expect(over.reason).toBe('velocity');
      expect(over.limits).toEqual(limits);
    }
  );

  it('enforces the per-app DAILY ceiling from the tier (platform gets 5× the headroom)', async () => {
    setLimits(APP_SPEND_TIER_CAP_LIMITS.platform);
    const beyondStandard = APP_SPEND_TIER_CAP_LIMITS.standard.dailyBuzz + 1;
    // A spend that would breach the standard/trusted daily cap fits for platform.
    const res = await reserveAppSpend(APP_BLOCK_ID, beyondStandard);
    expect(res.allowed).toBe(true);
    expect(res.limits).toEqual(APP_SPEND_TIER_CAP_LIMITS.platform);

    // …and platform's own ceiling still binds.
    const over = await reserveAppSpend(APP_BLOCK_ID, APP_SPEND_TIER_CAP_LIMITS.platform.dailyBuzz);
    expect(over.allowed).toBe(false);
    expect(over.reason).toBe('daily');
  });

  it('an ADMIN OVERRIDE (resolved per-app) is what actually binds', async () => {
    setLimits({ dailyBuzz: 900, velocityMaxGens: 2 });
    expect((await reserveAppSpend(APP_BLOCK_ID, 400)).allowed).toBe(true);
    expect((await reserveAppSpend(APP_BLOCK_ID, 400)).allowed).toBe(true);
    // 3rd gen breaches the overridden velocity of 2 (before the 900 daily bites).
    const third = await reserveAppSpend(APP_BLOCK_ID, 1);
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe('velocity');
  });

  it('TWO APPS with different tiers are bounded independently in the same window', async () => {
    mockResolveAppCapLimits.mockImplementation(async (id: string) =>
      id === 'apb_busy' ? APP_SPEND_TIER_CAP_LIMITS.trusted : APP_SPEND_TIER_CAP_LIMITS.standard
    );
    // Drive the standard-tier app past ITS ceiling…
    for (let i = 0; i < APP_SPEND_TIER_CAP_LIMITS.standard.velocityMaxGens; i++) {
      expect((await reserveAppSpend('apb_quiet', 0)).allowed).toBe(true);
    }
    expect((await reserveAppSpend('apb_quiet', 0)).allowed).toBe(false);
    // …while the trusted app is still comfortably inside its own, higher one.
    for (let i = 0; i < APP_SPEND_TIER_CAP_LIMITS.standard.velocityMaxGens + 50; i++) {
      expect((await reserveAppSpend('apb_busy', 0)).allowed).toBe(true);
    }
  });

  it('reports the ceilings it judged against on the ALLOWED path too', async () => {
    setLimits(APP_SPEND_TIER_CAP_LIMITS.platform);
    const res = await reserveAppSpend(APP_BLOCK_ID, 5);
    expect(res.allowed).toBe(true);
    expect(res.limits).toEqual(APP_SPEND_TIER_CAP_LIMITS.platform);
  });
});

describe('THE REGRESSION THIS PR FIXES — a legitimately busy app is no longer throttled', () => {
  /**
   * The concrete failure the old global ceiling produced: ~120 concurrent
   * viewers each generating once a minute saturates 120 gens/60s AGGREGATE, and
   * every viewer past that gets an abuse rejection. Platform success → user-
   * visible failure. Same traffic, two tiers:
   */
  const BUSY_APP_GENS_PER_WINDOW = 300; // ~300 concurrent viewers, 1 gen/min each

  it('300 gens in one window ALL succeed at the `trusted` ceiling (600)', async () => {
    setLimits(APP_SPEND_TIER_CAP_LIMITS.trusted);
    let denied = 0;
    for (let i = 0; i < BUSY_APP_GENS_PER_WINDOW; i++) {
      if (!(await reserveAppSpend(APP_BLOCK_ID, 100)).allowed) denied++;
    }
    expect(denied).toBe(0);
  });

  it('…and would have been throttled at the 120 ceiling (still the `standard` tier)', async () => {
    setLimits(APP_SPEND_TIER_CAP_LIMITS.standard);
    let denied = 0;
    for (let i = 0; i < BUSY_APP_GENS_PER_WINDOW; i++) {
      if (!(await reserveAppSpend(APP_BLOCK_ID, 100)).allowed) denied++;
    }
    expect(denied).toBe(BUSY_APP_GENS_PER_WINDOW - APP_SPEND_TIER_CAP_LIMITS.standard.velocityMaxGens);
    expect(denied).toBe(180);
  });

  it('the raised velocity does NOT weaken the daily SPEND bound (the real sybil bound)', async () => {
    // At the trusted tier a ring still cannot exceed the daily Buzz ceiling,
    // however fast it fires — the money bound is independent of the rate bound.
    setLimits(APP_SPEND_TIER_CAP_LIMITS.trusted);
    const cap = APP_SPEND_TIER_CAP_LIMITS.trusted.dailyBuzz;
    const chunk = Math.floor(cap / 4);
    for (let i = 0; i < 10; i++) await reserveAppSpend(APP_BLOCK_ID, chunk);
    expect(store.get(dailyKey())!).toBeLessThanOrEqual(cap);
  });
});

describe('reserveAppSpend — FAIL-CLOSED', () => {
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

  it('DENIES when the DAILY INCRBY itself throws (nothing to roll back, no spend)', async () => {
    mockSysRedis.incrBy.mockRejectedValue(new Error('redis down'));
    const res = await reserveAppSpend(APP_BLOCK_ID, 100);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('unavailable');
    expect(res.dailyKey).toBeUndefined();
    // Nothing was reserved, so nothing is refunded — and no spend is authorised.
    expect(mockSysRedis.decrBy).not.toHaveBeenCalled();
    expect(store.get(dailyKey())).toBeUndefined();
  });

  it('DENIES when the daily TTL/expire call throws mid-reserve, rolling the reserve back', async () => {
    mockSysRedis.expire.mockRejectedValue(new Error('redis down'));
    const res = await reserveAppSpend(APP_BLOCK_ID, 250);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('unavailable');
    expect(mockSysRedis.decrBy).toHaveBeenCalledWith(dailyKey(), 250);
    expect(store.get(dailyKey())).toBe(0);
  });

  it('DENIES when LIMIT RESOLUTION throws — a lookup failure can never mean "uncapped"', async () => {
    mockResolveAppCapLimits.mockRejectedValue(new Error('resolver exploded'));
    const res = await reserveAppSpend(APP_BLOCK_ID, 100);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('unavailable');
    // The resolve happens BEFORE any Redis write, so nothing was reserved…
    expect(mockSysRedis.incrBy).not.toHaveBeenCalled();
    // …and the reported ceilings are the strictest pair, never an absent/huge one.
    expect(res.limits).toEqual(STRICTEST_APP_CAP_LIMITS);
  });

  it('enforces the STRICTEST ceilings when the resolver degrades (DB down → strictest, not uncapped)', async () => {
    // This is what `resolveAppCapLimits` actually returns on a DB error.
    setLimits(STRICTEST_APP_CAP_LIMITS);
    for (let i = 0; i < STRICTEST_APP_CAP_LIMITS.velocityMaxGens; i++) {
      expect((await reserveAppSpend(APP_BLOCK_ID, 0)).allowed).toBe(true);
    }
    const over = await reserveAppSpend(APP_BLOCK_ID, 0);
    expect(over.allowed).toBe(false);
    expect(over.reason).toBe('velocity');
  });

  it('a denied submit NEVER reports a dailyKey (nothing for the caller to refund)', async () => {
    setLimits({ dailyBuzz: 10, velocityMaxGens: 600 });
    const res = await reserveAppSpend(APP_BLOCK_ID, 50);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('daily');
    expect(res.dailyKey).toBeUndefined();
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

  it('the RESERVED key shape is unchanged — the router/settle refund sites still match it', async () => {
    // 🔴 The throw-path refunds in blocks.router.ts and the PERSISTED
    // `appSpendKey` on customComfy settle records hold keys minted here,
    // including keys written by an earlier deploy. Per-app limits must not have
    // moved the key shape.
    const res = await reserveAppSpend(APP_BLOCK_ID, 42);
    expect(res.dailyKey).toBe(`${SPEND_CAP_PREFIX}:${APP_BLOCK_ID}:${new Date()
      .toISOString()
      .slice(0, 10)}`);
  });

  it('refunds the PINNED key even when the request straddles midnight UTC', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T23:59:59Z'));
    const res = await reserveAppSpend(APP_BLOCK_ID, 90);
    const reservedKey = res.dailyKey!;
    expect(reservedKey).toContain('2026-07-31');
    expect(store.get(reservedKey)).toBe(90);

    // The orchestrator submit takes seconds; the refund lands on the NEXT day.
    vi.setSystemTime(new Date('2026-08-01T00:00:02Z'));
    await refundAppSpend(reservedKey, 90);

    // Yesterday's counter is what was decremented — today's was never touched
    // (re-deriving the key here would have handed the app free headroom).
    expect(store.get(reservedKey)).toBe(0);
    expect(store.get(`${SPEND_CAP_PREFIX}:${APP_BLOCK_ID}:2026-08-01`)).toBeUndefined();
  });
});
