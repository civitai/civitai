import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OBSERVABILITY of the per-app cap-limit DEGRADE path, and the ABSOLUTE-CEILING
 * env rename.
 *
 * ── Why the degrade signal exists ────────────────────────────────────────────
 * `resolveAppCapLimits` falls back to `STRICTEST_APP_CAP_LIMITS` on a DB error
 * or a missing `app_blocks` row. That behaviour is correct (never uncapped;
 * never a hard deny that would turn a DB blip into a generation outage) — but it
 * used to be SILENT, and an app pinned to the strictest ceiling is
 * indistinguishable from an app that is merely busy. The first symptom would be
 * that app's users hitting abuse rejections they did not earn.
 *
 * Three properties are load-bearing and pinned below:
 *   1. The signal FIRES on a degrade, and `db_error` (infra — every app degrades
 *      at once) is DISTINGUISHABLE from `missing_row` (one app; points at an
 *      id-minting bug, not the database).
 *   2. It does NOT fire on the happy path — an alert on it must mean something.
 *   3. 🔴 The signal is NOT a failure path. A throwing emitter must not break cap
 *      resolution: it stays total and still degrades to STRICTEST.
 *
 * ── Why the env rename ───────────────────────────────────────────────────────
 * `BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY` / `BLOCK_APP_SPEND_VELOCITY_MAX_GENS` used
 * to BE the ceilings. They are now ABSOLUTE bounds that clamp the tier table AND
 * any per-app override, so the old names mislead an operator mid-incident. The
 * legacy names keep working (silently ignoring a set spend-guardrail var is
 * unacceptable) — loudly, and only when the new name does not supply a value.
 */

const { mockFindUnique, mockRecordDegrade } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  mockRecordDegrade: vi.fn((_reason: string): void => undefined),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { appBlock: { findUnique: mockFindUnique } },
  dbWrite: { appBlock: { findUnique: mockFindUnique } },
}));

// The service dynamic-imports the metrics module, so this mock applies. Only the
// degrade emitter is stubbed; the real module is exercised separately in
// src/server/metrics/__tests__/app-block-cap-degrade.metrics.test.ts.
vi.mock('~/server/metrics/app-block-runtime.metrics', () => ({
  recordAppCapLimitsDegrade: mockRecordDegrade,
}));

import { STRICTEST_APP_CAP_LIMITS } from '../app-cap-limits.constants';
import { __resetAppCapLimitsCacheForTests, resolveAppCapLimits } from '../app-cap-limits.service';

const APP = 'apb_degrade_test';

function row(over: Record<string, unknown> = {}) {
  return {
    spendTier: 'standard',
    spendCapBuzzPerDay: null,
    spendVelocityMaxGens: null,
    ...over,
  };
}

/** Reasons passed to the degrade emitter, in call order. */
function reasons(): string[] {
  return mockRecordDegrade.mock.calls.map((c) => c[0] as string);
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetAppCapLimitsCacheForTests();
  mockFindUnique.mockReset();
  mockFindUnique.mockResolvedValue(row());
  mockRecordDegrade.mockReset();
  mockRecordDegrade.mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('cap-limit degrade signal — it fires, and the two causes are distinguishable', () => {
  it('a DB ERROR emits `db_error` (and still degrades to STRICTEST)', async () => {
    mockFindUnique.mockRejectedValue(new Error('connection terminated'));

    await expect(resolveAppCapLimits(APP)).resolves.toEqual(STRICTEST_APP_CAP_LIMITS);

    expect(reasons()).toEqual(['db_error']);
  });

  it('a MISSING ROW emits `missing_row` (and still degrades to STRICTEST)', async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(resolveAppCapLimits(APP)).resolves.toEqual(STRICTEST_APP_CAP_LIMITS);

    expect(reasons()).toEqual(['missing_row']);
  });

  it('🔴 the two reasons are DISTINCT — infra trouble never reads as a new app', async () => {
    // The discrimination is the whole point: `db_error` is fleet-wide and
    // page-worthy; `missing_row` is one app and points at an id-minting bug. A
    // single undifferentiated "degraded" counter could not tell an operator
    // which incident they are in.
    mockFindUnique.mockRejectedValue(new Error('db down'));
    await resolveAppCapLimits('apb_a');

    __resetAppCapLimitsCacheForTests();
    mockFindUnique.mockReset();
    mockFindUnique.mockResolvedValue(null);
    await resolveAppCapLimits('apb_b');

    expect(reasons()).toEqual(['db_error', 'missing_row']);
    expect(new Set(reasons()).size).toBe(2);
  });

  it('the LOG carries the specific appBlockId + reason (the metric deliberately does not)', async () => {
    // The prom counter has no `app_block_id` label — `missing_row` fires for ids
    // that are by construction NOT in the app catalog, which is exactly the
    // unbounded label population that grows prom-client's heap forever. So the
    // attribution an operator needs has to be in the log line.
    mockFindUnique.mockRejectedValue(new Error('pool exhausted'));
    await resolveAppCapLimits(APP);

    const line = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain(APP);
    expect(line).toContain('db_error');
    expect(line).toContain('pool exhausted');
  });

  it('a MISSING ROW is logged too — it used to degrade with no log at all', async () => {
    mockFindUnique.mockResolvedValue(null);
    await resolveAppCapLimits(APP);

    const line = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain(APP);
    expect(line).toContain('missing_row');
  });
});

describe('cap-limit degrade signal — it does NOT fire when nothing degraded', () => {
  it('a resolved row emits NOTHING (an alert on this must mean something)', async () => {
    mockFindUnique.mockResolvedValue(row({ spendTier: 'platform' }));

    await resolveAppCapLimits(APP);

    expect(mockRecordDegrade).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('an UNKNOWN TIER does not emit — the row resolved, the tier table just clamped it', async () => {
    // Deliberate: an unrecognised tier string still resolves to STRICTEST, but
    // it is NOT a lookup degradation — the read worked and the row exists. Only
    // "we could not learn this app's limits" is signalled, so the counter stays
    // a clean infra/id-minting signal rather than a mixed bag that also fires on
    // data the resolver read successfully.
    mockFindUnique.mockResolvedValue(row({ spendTier: 'platinum' }));

    await expect(resolveAppCapLimits(APP)).resolves.toEqual(STRICTEST_APP_CAP_LIMITS);

    expect(mockRecordDegrade).not.toHaveBeenCalled();
  });

  it('is bounded by the CACHE, not by submit rate — a burst emits ONCE', async () => {
    // The chattiness bound. A degrade is cached for the 5s fallback TTL and
    // concurrent misses single-flight, so the emit ceiling is
    // `active_apps / fallback_TTL` per pod regardless of traffic — NOT one per
    // submit. This is what makes a per-degrade signal affordable on a hot path.
    mockFindUnique.mockRejectedValue(new Error('db down'));

    await Promise.all(Array.from({ length: 40 }, () => resolveAppCapLimits(APP)));
    for (let i = 0; i < 40; i++) await resolveAppCapLimits(APP);

    expect(mockRecordDegrade).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('🔴 the signal is NOT a failure path', () => {
  it('a THROWING metric emitter does not break cap resolution (still STRICTEST, no throw)', async () => {
    mockRecordDegrade.mockImplementation(() => {
      throw new Error('prom registry exploded');
    });
    mockFindUnique.mockRejectedValue(new Error('db down'));

    await expect(resolveAppCapLimits(APP)).resolves.toEqual(STRICTEST_APP_CAP_LIMITS);
  });

  it('a throwing emitter does not suppress the LOG (the emitters are independently guarded)', async () => {
    mockRecordDegrade.mockImplementation(() => {
      throw new Error('prom registry exploded');
    });
    mockFindUnique.mockResolvedValue(null);

    await resolveAppCapLimits(APP);

    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('missing_row');
  });

  it('a throwing CONSOLE does not suppress the METRIC, nor break resolution', async () => {
    warnSpy.mockImplementation(() => {
      throw new Error('stdout gone');
    });
    mockFindUnique.mockRejectedValue(new Error('db down'));

    await expect(resolveAppCapLimits(APP)).resolves.toEqual(STRICTEST_APP_CAP_LIMITS);
    expect(reasons()).toEqual(['db_error']);
  });

  it('🔴 a throwing CONSOLE does not defeat the FALLBACK CACHE (no stampede on a sick DB)', async () => {
    // The subtle one, and the reason the log needs its own guard rather than
    // relying on `resolveAppCapLimits`'s outer `.catch` belt. If the log throws
    // unguarded, the rejection escapes `loadAppCapLimits`, the belt still
    // returns STRICTEST — so the RETURN VALUE looks perfect — but `setCacheEntry`
    // never ran. Every subsequent submit then re-queries, turning a DB outage
    // into a query stampede against the already-sick database: precisely what
    // CAP_LIMITS_FALLBACK_TTL_MS exists to prevent. The observable difference is
    // the QUERY COUNT, not the limits.
    warnSpy.mockImplementation(() => {
      throw new Error('stdout gone');
    });
    mockFindUnique.mockRejectedValue(new Error('db down'));

    for (let i = 0; i < 20; i++) {
      await expect(resolveAppCapLimits(APP)).resolves.toEqual(STRICTEST_APP_CAP_LIMITS);
    }

    expect(mockFindUnique).toHaveBeenCalledTimes(1);
  });

  it('a throwing emitter on the MISSING-ROW path also stays total', async () => {
    mockRecordDegrade.mockImplementation(() => {
      throw new Error('boom');
    });
    mockFindUnique.mockResolvedValue(null);

    const limits = await resolveAppCapLimits(APP);
    expect(limits).toEqual(STRICTEST_APP_CAP_LIMITS);
    expect(limits.dailyBuzz).toBeGreaterThan(0);
    expect(limits.velocityMaxGens).toBeGreaterThan(0);
  });
});

/**
 * The absolute-ceiling env rename. The constants are module-level, so each case
 * needs a fresh module registry — `vi.resetModules()` + a dynamic import.
 */
describe('env rename — BLOCK_APP_SPEND_ABSOLUTE_MAX_* (legacy names still honoured)', () => {
  const NEW_DAILY = 'BLOCK_APP_SPEND_ABSOLUTE_MAX_BUZZ_PER_DAY';
  const OLD_DAILY = 'BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY';
  const NEW_GENS = 'BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW';
  const OLD_GENS = 'BLOCK_APP_SPEND_VELOCITY_MAX_GENS';
  const ENV_KEYS = [NEW_DAILY, OLD_DAILY, NEW_GENS, OLD_GENS] as const;

  const HARD_DEFAULT_DAILY = 1_000_000_000;
  const HARD_DEFAULT_GENS = 100_000;

  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
  });

  async function loadConstants() {
    return import('../app-cap-limits.constants');
  }

  it('NEITHER set → the hard built-in default (no extra clamp, no warning)', async () => {
    const m = await loadConstants();
    expect(m.BLOCK_APP_SPEND_ABSOLUTE_MAX_BUZZ_PER_DAY).toBe(HARD_DEFAULT_DAILY);
    expect(m.BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW).toBe(HARD_DEFAULT_GENS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('the NEW name is honoured', async () => {
    process.env[NEW_DAILY] = '4200';
    process.env[NEW_GENS] = '77';
    const m = await loadConstants();
    expect(m.BLOCK_APP_SPEND_ABSOLUTE_MAX_BUZZ_PER_DAY).toBe(4_200);
    expect(m.BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW).toBe(77);
  });

  it('the new name alone emits NO deprecation warning', async () => {
    process.env[NEW_DAILY] = '4200';
    process.env[NEW_GENS] = '77';
    await loadConstants();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('🔴 the OLD name is still honoured — a set spend guardrail is never silently ignored', async () => {
    process.env[OLD_DAILY] = '1234';
    process.env[OLD_GENS] = '56';
    const m = await loadConstants();
    expect(m.BLOCK_APP_SPEND_ABSOLUTE_MAX_BUZZ_PER_DAY).toBe(1_234);
    expect(m.BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW).toBe(56);
  });

  it('using the OLD name logs a DEPRECATION notice naming both the old and new var', async () => {
    process.env[OLD_GENS] = '56';
    await loadConstants();
    const text = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('DEPRECATED');
    expect(text).toContain(OLD_GENS);
    expect(text).toContain(NEW_GENS);
  });

  it('the deprecation notice also states that the MEANING changed to an absolute ceiling', async () => {
    // The rename exists because the name misdescribes the semantics. A notice
    // that only said "renamed" would leave the operator with the wrong model.
    process.env[OLD_GENS] = '56';
    await loadConstants();
    const text = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('ABSOLUTE CEILING');
  });

  it('🔴 the NEW name WINS when both are set', async () => {
    process.env[NEW_DAILY] = '111';
    process.env[OLD_DAILY] = '999';
    process.env[NEW_GENS] = '11';
    process.env[OLD_GENS] = '99';
    const m = await loadConstants();
    expect(m.BLOCK_APP_SPEND_ABSOLUTE_MAX_BUZZ_PER_DAY).toBe(111);
    expect(m.BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW).toBe(11);
  });

  it('…and says so — an IGNORED guardrail var must not be silent either', async () => {
    process.env[NEW_GENS] = '11';
    process.env[OLD_GENS] = '99';
    await loadConstants();
    const text = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('IGNORED');
    expect(text).toContain(OLD_GENS);
  });

  it('an UNUSABLE new value falls through to a usable legacy value (intent beats a typo)', async () => {
    process.env[NEW_GENS] = 'not-a-number';
    process.env[OLD_GENS] = '42';
    const m = await loadConstants();
    expect(m.BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW).toBe(42);
  });

  it.each([
    ['UNPARSEABLE', 'not-a-number'],
    ['an empty string', ''],
    ['ZERO', '0'],
    ['NEGATIVE', '-500'],
    ['Infinity', 'Infinity'],
    ['whitespace', '   '],
  ])(
    '%s under EITHER name falls back to the hard default (a typo can never disable a cap)',
    async (_label, raw) => {
      process.env[NEW_DAILY] = raw;
      process.env[OLD_DAILY] = raw;
      process.env[NEW_GENS] = raw;
      process.env[OLD_GENS] = raw;
      const m = await loadConstants();
      expect(m.BLOCK_APP_SPEND_ABSOLUTE_MAX_BUZZ_PER_DAY).toBe(HARD_DEFAULT_DAILY);
      expect(m.BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW).toBe(HARD_DEFAULT_GENS);
    }
  );

  it('a legacy name set to an UNUSABLE value warns that no clamp is in force', async () => {
    // The silent-typo case: the operator believes they clamped, and nothing did.
    process.env[OLD_GENS] = 'oops';
    await loadConstants();
    const text = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('NO deploy-time clamp is in force');
  });

  it('a legacy value is FLOORED, exactly like the new name', async () => {
    process.env[OLD_GENS] = '250.7';
    const m = await loadConstants();
    expect(m.BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW).toBe(250);
  });

  it('the DEPRECATED export aliases still resolve to the new values', async () => {
    // Kept so pre-rename importers (and their tests) keep compiling.
    process.env[NEW_DAILY] = '4200';
    process.env[OLD_GENS] = '56';
    const m = await loadConstants();
    expect(m.BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY).toBe(m.BLOCK_APP_SPEND_ABSOLUTE_MAX_BUZZ_PER_DAY);
    expect(m.BLOCK_APP_SPEND_VELOCITY_MAX_GENS).toBe(
      m.BLOCK_APP_SPEND_ABSOLUTE_MAX_GENS_PER_WINDOW
    );
  });

  it('🔴 a legacy value still clamps EVERY tier — the compat path is a real ceiling', async () => {
    // The backcompat is worthless if the honoured value does not actually bind.
    process.env[OLD_GENS] = '50';
    const m = await loadConstants();
    for (const tier of m.APP_SPEND_TIERS) {
      expect(m.APP_SPEND_TIER_CAP_LIMITS[tier].velocityMaxGens).toBe(50);
    }
    expect(m.STRICTEST_APP_CAP_LIMITS.velocityMaxGens).toBe(50);
  });

  it('🔴 a legacy value also clamps a per-app OVERRIDE, not just the tier', async () => {
    process.env[OLD_GENS] = '50';
    process.env[OLD_DAILY] = '1000';
    const m = await loadConstants();
    expect(
      m.resolveLimitsFromRow({
        spendTier: 'platform',
        spendCapBuzzPerDay: 900_000_000,
        spendVelocityMaxGens: 90_000,
      })
    ).toEqual({ dailyBuzz: 1_000, velocityMaxGens: 50 });
  });

  it('a NEW-name value clamps every tier and every override identically', async () => {
    process.env[NEW_GENS] = '50';
    process.env[NEW_DAILY] = '1000';
    const m = await loadConstants();
    for (const tier of m.APP_SPEND_TIERS) {
      expect(m.APP_SPEND_TIER_CAP_LIMITS[tier].velocityMaxGens).toBe(50);
    }
    expect(
      m.resolveLimitsFromRow({
        spendTier: 'platform',
        spendCapBuzzPerDay: 900_000_000,
        spendVelocityMaxGens: 90_000,
      })
    ).toEqual({ dailyBuzz: 1_000, velocityMaxGens: 50 });
  });
});
