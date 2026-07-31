import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PER-APP cap-limit RESOLUTION — the cached `app_blocks` read behind
 * `reserveAppSpend`.
 *
 * Two things are load-bearing here and both are pinned below:
 *
 *  1. HOT-PATH COST. This runs on EVERY block generation submit. A cache hit
 *     must do zero IO, and concurrent cold misses for one app must collapse to a
 *     SINGLE query — otherwise a popular app's cold pod stampedes the DB at
 *     exactly the moment it is busiest.
 *
 *  2. FAIL-CLOSED. Missing row, DB outage, garbage tier, absent override — every
 *     one resolves to the STRICTEST tier and NEVER throws, so a lookup problem
 *     can never present as "this app has no cap".
 *
 * `dbRead` is mocked; the resolver dynamic-imports it, so the mock applies.
 */

const { mockFindUnique } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { appBlock: { findUnique: mockFindUnique } },
  dbWrite: { appBlock: { findUnique: mockFindUnique } },
}));

import {
  APP_CAP_OVERRIDE_MAX_DAILY_BUZZ,
  APP_CAP_OVERRIDE_MAX_VELOCITY_GENS,
  APP_TIER_CAP_LIMITS,
  APP_TRUST_TIERS,
  STRICTEST_APP_CAP_LIMITS,
} from '../app-cap-limits.constants';
import {
  __resetAppCapLimitsCacheForTests,
  invalidateAppCapLimits,
  normalizeCapOverrideInput,
  resolveAppCapLimits,
} from '../app-cap-limits.service';

const APP = 'apb_test';

function row(over: Record<string, unknown> = {}) {
  return {
    trustTier: 'unverified',
    spendCapBuzzPerDay: null,
    spendVelocityMaxGens: null,
    ...over,
  };
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetAppCapLimitsCacheForTests();
  mockFindUnique.mockReset();
  mockFindUnique.mockResolvedValue(row());
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  warnSpy.mockRestore();
});

describe('resolveAppCapLimits — tier resolution', () => {
  it.each(APP_TRUST_TIERS.map((t) => [t] as const))(
    'resolves the `%s` tier to its table entry',
    async (tier) => {
      mockFindUnique.mockResolvedValue(row({ trustTier: tier }));
      await expect(resolveAppCapLimits(APP)).resolves.toEqual(APP_TIER_CAP_LIMITS[tier]);
    }
  );

  it('reads exactly the three columns it needs, keyed on the app id', async () => {
    await resolveAppCapLimits(APP);
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: APP },
      select: { trustTier: true, spendCapBuzzPerDay: true, spendVelocityMaxGens: true },
    });
  });

  it('an ADMIN OVERRIDE takes precedence over the tier', async () => {
    mockFindUnique.mockResolvedValue(
      row({ trustTier: 'unverified', spendCapBuzzPerDay: 12_345, spendVelocityMaxGens: 4_321 })
    );
    await expect(resolveAppCapLimits(APP)).resolves.toEqual({
      dailyBuzz: 12_345,
      velocityMaxGens: 4_321,
    });
  });

  it('an ABSENT override falls back to the tier', async () => {
    mockFindUnique.mockResolvedValue(row({ trustTier: 'internal' }));
    await expect(resolveAppCapLimits(APP)).resolves.toEqual(APP_TIER_CAP_LIMITS.internal);
  });

  it('an override is CLAMPED to the hard bound, never honoured unbounded', async () => {
    mockFindUnique.mockResolvedValue(row({ spendCapBuzzPerDay: 9e15, spendVelocityMaxGens: 9e15 }));
    await expect(resolveAppCapLimits(APP)).resolves.toEqual({
      dailyBuzz: APP_CAP_OVERRIDE_MAX_DAILY_BUZZ,
      velocityMaxGens: APP_CAP_OVERRIDE_MAX_VELOCITY_GENS,
    });
  });
});

describe('resolveAppCapLimits — FAIL-CLOSED', () => {
  it('an UNKNOWN tier resolves to the strictest limits, never uncapped', async () => {
    mockFindUnique.mockResolvedValue(row({ trustTier: 'platinum' }));
    await expect(resolveAppCapLimits(APP)).resolves.toEqual(STRICTEST_APP_CAP_LIMITS);
  });

  it('a MISSING app row resolves to the strictest limits', async () => {
    mockFindUnique.mockResolvedValue(null);
    await expect(resolveAppCapLimits(APP)).resolves.toEqual(STRICTEST_APP_CAP_LIMITS);
  });

  it('a DB ERROR resolves to the strictest limits and does NOT throw', async () => {
    // The cap resolver must never be the thing that takes generation down, and
    // must never be the thing that lets an app off its leash. Both at once.
    mockFindUnique.mockRejectedValue(new Error('connection terminated'));
    const limits = await resolveAppCapLimits(APP);
    expect(limits).toEqual(STRICTEST_APP_CAP_LIMITS);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('a DB error resolves LOWER than every non-strictest tier (it cannot widen anything)', async () => {
    mockFindUnique.mockRejectedValue(new Error('db down'));
    const limits = await resolveAppCapLimits(APP);
    expect(limits.velocityMaxGens).toBeLessThan(APP_TIER_CAP_LIMITS.internal.velocityMaxGens);
    expect(limits.dailyBuzz).toBeLessThan(APP_TIER_CAP_LIMITS.internal.dailyBuzz);
  });

  it('the MIGRATION-NOT-YET-APPLIED case (unknown column) degrades to the strictest tier', async () => {
    // Prisma raises when a selected column does not exist. Until the manual
    // migration lands, that is the state of every environment — and it must
    // present as the PRE-CHANGE ceilings, not as "no cap".
    mockFindUnique.mockRejectedValue(
      new Error('The column `app_blocks.spend_cap_buzz_per_day` does not exist')
    );
    await expect(resolveAppCapLimits(APP)).resolves.toEqual(STRICTEST_APP_CAP_LIMITS);
  });

  it('never returns a non-positive or non-finite ceiling across all failure shapes', async () => {
    const failures: unknown[] = [null, undefined, row({ trustTier: null }), row({ trustTier: 42 })];
    for (const value of failures) {
      __resetAppCapLimitsCacheForTests();
      mockFindUnique.mockResolvedValue(value);
      const l = await resolveAppCapLimits(APP);
      expect(l.dailyBuzz).toBeGreaterThan(0);
      expect(l.velocityMaxGens).toBeGreaterThan(0);
      expect(Number.isFinite(l.dailyBuzz)).toBe(true);
      expect(Number.isFinite(l.velocityMaxGens)).toBe(true);
    }
  });
});

describe('resolveAppCapLimits — hot-path cost', () => {
  it('a warm hit does ZERO IO (one query serves many submits)', async () => {
    await resolveAppCapLimits(APP);
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i++) await resolveAppCapLimits(APP);
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
  });

  it('SINGLE-FLIGHTS concurrent cold misses for the same app into ONE query', async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    mockFindUnique.mockImplementation(async () => {
      await gate;
      return row({ trustTier: 'verified' });
    });

    const all = Promise.all(Array.from({ length: 25 }, () => resolveAppCapLimits(APP)));
    release(undefined);
    const results = await all;

    expect(mockFindUnique).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toEqual(APP_TIER_CAP_LIMITS.verified);
  });

  it('caches PER APP (one app cannot serve another app its limits)', async () => {
    mockFindUnique.mockImplementation(async (args: unknown) => {
      const id = (args as { where: { id: string } }).where.id;
      return row({ trustTier: id === 'apb_a' ? 'internal' : 'unverified' });
    });
    await expect(resolveAppCapLimits('apb_a')).resolves.toEqual(APP_TIER_CAP_LIMITS.internal);
    await expect(resolveAppCapLimits('apb_b')).resolves.toEqual(APP_TIER_CAP_LIMITS.unverified);
    expect(mockFindUnique).toHaveBeenCalledTimes(2);
  });

  it('re-reads after the TTL expires (a tier change lands without a deploy)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T00:00:00Z'));
    mockFindUnique.mockResolvedValue(row({ trustTier: 'unverified' }));
    await expect(resolveAppCapLimits(APP)).resolves.toEqual(APP_TIER_CAP_LIMITS.unverified);

    mockFindUnique.mockResolvedValue(row({ trustTier: 'verified' }));
    // Still cached at +59s…
    vi.setSystemTime(new Date('2026-07-31T00:00:59Z'));
    await expect(resolveAppCapLimits(APP)).resolves.toEqual(APP_TIER_CAP_LIMITS.unverified);
    expect(mockFindUnique).toHaveBeenCalledTimes(1);

    // …refreshed past the 60s TTL.
    vi.setSystemTime(new Date('2026-07-31T00:01:01Z'));
    await expect(resolveAppCapLimits(APP)).resolves.toEqual(APP_TIER_CAP_LIMITS.verified);
    expect(mockFindUnique).toHaveBeenCalledTimes(2);
  });

  it('caches a FAILURE only briefly (recovers fast, but does not stampede a sick DB)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T00:00:00Z'));
    mockFindUnique.mockRejectedValue(new Error('db down'));
    await expect(resolveAppCapLimits(APP)).resolves.toEqual(STRICTEST_APP_CAP_LIMITS);

    // A burst of submits during the outage does NOT become a burst of queries.
    for (let i = 0; i < 20; i++) await resolveAppCapLimits(APP);
    expect(mockFindUnique).toHaveBeenCalledTimes(1);

    // The short fallback TTL is well under the success TTL, so recovery is quick.
    mockFindUnique.mockResolvedValue(row({ trustTier: 'internal' }));
    vi.setSystemTime(new Date('2026-07-31T00:00:06Z'));
    await expect(resolveAppCapLimits(APP)).resolves.toEqual(APP_TIER_CAP_LIMITS.internal);
  });

  it('BOUNDS the cache — a huge id set cannot grow the heap without limit', async () => {
    mockFindUnique.mockResolvedValue(row({ trustTier: 'verified' }));
    for (let i = 0; i < 2_100; i++) await resolveAppCapLimits(`apb_${i}`);
    const afterFill = mockFindUnique.mock.calls.length;
    expect(afterFill).toBe(2_100);

    // The OLDEST entries were evicted (so they re-query); a recent one is still warm.
    await resolveAppCapLimits('apb_0');
    expect(mockFindUnique.mock.calls.length).toBe(afterFill + 1);
    await resolveAppCapLimits('apb_2099');
    expect(mockFindUnique.mock.calls.length).toBe(afterFill + 1);
  });
});

describe('invalidateAppCapLimits', () => {
  it('drops the entry so the next resolve re-reads the row', async () => {
    mockFindUnique.mockResolvedValue(row({ trustTier: 'unverified' }));
    await expect(resolveAppCapLimits(APP)).resolves.toEqual(APP_TIER_CAP_LIMITS.unverified);

    mockFindUnique.mockResolvedValue(row({ trustTier: 'internal' }));
    invalidateAppCapLimits(APP);
    await expect(resolveAppCapLimits(APP)).resolves.toEqual(APP_TIER_CAP_LIMITS.internal);
    expect(mockFindUnique).toHaveBeenCalledTimes(2);
  });

  it('only invalidates the named app', async () => {
    mockFindUnique.mockResolvedValue(row({ trustTier: 'verified' }));
    await resolveAppCapLimits('apb_a');
    await resolveAppCapLimits('apb_b');
    expect(mockFindUnique).toHaveBeenCalledTimes(2);
    invalidateAppCapLimits('apb_a');
    await resolveAppCapLimits('apb_b');
    expect(mockFindUnique).toHaveBeenCalledTimes(2);
    await resolveAppCapLimits('apb_a');
    expect(mockFindUnique).toHaveBeenCalledTimes(3);
  });
});

describe('normalizeCapOverrideInput — the WRITE side matches the READ side', () => {
  it('leaves an OMITTED field out of the patch entirely (unchanged, not cleared)', () => {
    expect(normalizeCapOverrideInput({ spendCapBuzzPerDay: 5 })).toEqual({
      spendCapBuzzPerDay: 5,
    });
    expect(normalizeCapOverrideInput({})).toEqual({});
  });

  it('an explicit NULL clears the override', () => {
    expect(
      normalizeCapOverrideInput({ spendCapBuzzPerDay: null, spendVelocityMaxGens: null })
    ).toEqual({ spendCapBuzzPerDay: null, spendVelocityMaxGens: null });
  });

  it('CLAMPS + FLOORS exactly like the reader, so a stored value is never reinterpreted', () => {
    expect(
      normalizeCapOverrideInput({ spendCapBuzzPerDay: 9e15, spendVelocityMaxGens: 120.9 })
    ).toEqual({
      spendCapBuzzPerDay: APP_CAP_OVERRIDE_MAX_DAILY_BUZZ,
      spendVelocityMaxGens: 120,
    });
  });

  it('a value the READER would ignore is stored as NULL, not as a misleading number', () => {
    // Belt behind the zod `.min(1)`: whatever gets here, the stored state and the
    // enforced state agree.
    expect(
      normalizeCapOverrideInput({
        spendCapBuzzPerDay: 0 as number,
        spendVelocityMaxGens: -4 as number,
      })
    ).toEqual({ spendCapBuzzPerDay: null, spendVelocityMaxGens: null });
  });
});
