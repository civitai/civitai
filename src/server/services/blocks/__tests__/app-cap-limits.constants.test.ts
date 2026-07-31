import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PER-APP cap LIMITS — the pure tier table + fallback rules.
 *
 * The property every case here defends is the same one: there is NO input —
 * unknown tier, NULL tier, absent override, garbage override, hostile env — for
 * which this module yields an unbounded (or non-positive) ceiling. A cap that
 * silently resolves to "no cap" is worse than no cap at all, because nothing
 * downstream can tell the difference.
 */

import {
  APP_CAP_OVERRIDE_MAX_DAILY_BUZZ,
  APP_CAP_OVERRIDE_MAX_VELOCITY_GENS,
  APP_TIER_CAP_LIMITS,
  APP_TRUST_TIERS,
  BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY,
  BLOCK_APP_SPEND_VELOCITY_MAX_GENS,
  BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS,
  isAppTrustTier,
  limitsForTier,
  normalizeCapOverride,
  resolveLimitsFromRow,
  STRICTEST_APP_CAP_LIMITS,
  type AppCapLimits,
} from '../app-cap-limits.constants';

describe('trust tiers — the enumeration is REAL, not invented', () => {
  it('matches the canonical manifest schema `trustTier` enum exactly', () => {
    // DRIFT GUARD. The tier list is the input to the whole cap table, so it must
    // track the single-sourced manifest schema (public/schemas/app-block/v1.json)
    // rather than a hand-copied list that quietly goes stale when a tier is added.
    const schemaPath = join(process.cwd(), 'public/schemas/app-block/v1.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      properties: { trustTier: { enum: string[] } };
    };
    expect([...APP_TRUST_TIERS].sort()).toEqual([...schema.properties.trustTier.enum].sort());
  });

  it('every real tier has an entry in the limits table', () => {
    for (const tier of APP_TRUST_TIERS) {
      expect(APP_TIER_CAP_LIMITS[tier]).toBeDefined();
    }
    expect(Object.keys(APP_TIER_CAP_LIMITS).sort()).toEqual([...APP_TRUST_TIERS].sort());
  });

  it('isAppTrustTier accepts only the real tiers', () => {
    for (const tier of APP_TRUST_TIERS) expect(isAppTrustTier(tier)).toBe(true);
    for (const junk of ['trusted', 'Verified', '', 'INTERNAL', null, undefined, 7, {}, []]) {
      expect(isAppTrustTier(junk)).toBe(false);
    }
  });
});

describe('tier → limits table', () => {
  it('maps EVERY tier to the documented pair', () => {
    // The table the PR body publishes — pinned so a silent retune is a test diff.
    expect(APP_TIER_CAP_LIMITS.unverified).toEqual({
      dailyBuzz: 5_000_000,
      velocityMaxGens: 120,
    });
    expect(APP_TIER_CAP_LIMITS.verified).toEqual({
      dailyBuzz: 5_000_000,
      velocityMaxGens: 600,
    });
    expect(APP_TIER_CAP_LIMITS.internal).toEqual({
      dailyBuzz: 25_000_000,
      velocityMaxGens: 3_000,
    });
  });

  it('keeps `unverified` byte-identical to the PRE-CHANGE global ceilings', () => {
    // Every existing app row defaults to trust_tier='unverified', so this is the
    // "merging changes nothing for anyone live today" guarantee.
    expect(APP_TIER_CAP_LIMITS.unverified).toEqual({ dailyBuzz: 5_000_000, velocityMaxGens: 120 });
  });

  it('every tier limit is a POSITIVE INTEGER (no tier can express "uncapped")', () => {
    for (const tier of APP_TRUST_TIERS) {
      const l = APP_TIER_CAP_LIMITS[tier];
      expect(Number.isInteger(l.dailyBuzz)).toBe(true);
      expect(Number.isInteger(l.velocityMaxGens)).toBe(true);
      expect(l.dailyBuzz).toBeGreaterThan(0);
      expect(l.velocityMaxGens).toBeGreaterThan(0);
      expect(Number.isFinite(l.dailyBuzz)).toBe(true);
      expect(Number.isFinite(l.velocityMaxGens)).toBe(true);
    }
  });

  it('the raised velocity default is 600 (10/sec at the 60s window), not the old 120', () => {
    expect(BLOCK_APP_SPEND_VELOCITY_MAX_GENS).toBe(600);
    expect(BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS).toBe(60);
    expect(BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY).toBe(5_000_000);
  });
});

describe('STRICTEST_APP_CAP_LIMITS — the fail-closed fallback', () => {
  it('is the per-field MINIMUM across the whole tier table', () => {
    const all = Object.values(APP_TIER_CAP_LIMITS);
    expect(STRICTEST_APP_CAP_LIMITS.dailyBuzz).toBe(Math.min(...all.map((l) => l.dailyBuzz)));
    expect(STRICTEST_APP_CAP_LIMITS.velocityMaxGens).toBe(
      Math.min(...all.map((l) => l.velocityMaxGens))
    );
  });

  it('is no looser than ANY tier in either dimension', () => {
    for (const tier of APP_TRUST_TIERS) {
      const l = APP_TIER_CAP_LIMITS[tier];
      expect(STRICTEST_APP_CAP_LIMITS.dailyBuzz).toBeLessThanOrEqual(l.dailyBuzz);
      expect(STRICTEST_APP_CAP_LIMITS.velocityMaxGens).toBeLessThanOrEqual(l.velocityMaxGens);
    }
  });

  it('is itself a positive, finite pair (a fallback is still a real cap)', () => {
    expect(STRICTEST_APP_CAP_LIMITS.dailyBuzz).toBeGreaterThan(0);
    expect(STRICTEST_APP_CAP_LIMITS.velocityMaxGens).toBeGreaterThan(0);
    expect(Number.isFinite(STRICTEST_APP_CAP_LIMITS.dailyBuzz)).toBe(true);
    expect(Number.isFinite(STRICTEST_APP_CAP_LIMITS.velocityMaxGens)).toBe(true);
  });
});

describe('limitsForTier', () => {
  it('returns the tier table entry for every REAL tier', () => {
    for (const tier of APP_TRUST_TIERS) {
      expect(limitsForTier(tier)).toEqual(APP_TIER_CAP_LIMITS[tier]);
    }
  });

  it.each([
    ['an unknown tier string', 'platinum'],
    ['a tier with wrong case', 'Verified'],
    ['an empty string', ''],
    ['NULL (a column that was never defaulted)', null],
    ['undefined (field absent from the select)', undefined],
    ['a number', 3],
    ['an object', { tier: 'internal' }],
    ['an array', ['internal']],
  ])('falls back to the STRICTEST limits for %s — never uncapped', (_label, value) => {
    expect(limitsForTier(value)).toEqual(STRICTEST_APP_CAP_LIMITS);
  });

  it('never resolves an unknown tier to the LOOSEST tier', () => {
    const loosest = APP_TIER_CAP_LIMITS.internal;
    const resolved = limitsForTier('definitely-not-a-tier');
    expect(resolved.dailyBuzz).toBeLessThan(loosest.dailyBuzz);
    expect(resolved.velocityMaxGens).toBeLessThan(loosest.velocityMaxGens);
  });
});

describe('normalizeCapOverride', () => {
  it('accepts a positive integer unchanged', () => {
    expect(normalizeCapOverride(4_242, APP_CAP_OVERRIDE_MAX_DAILY_BUZZ)).toBe(4_242);
  });

  it('FLOORS a fractional value (a ceiling is a whole count)', () => {
    expect(normalizeCapOverride(120.9, APP_CAP_OVERRIDE_MAX_VELOCITY_GENS)).toBe(120);
  });

  it('CLAMPS above the hard bound instead of ignoring it', () => {
    // A fat-fingered giant number degrades to the bound — it must NOT silently
    // revert to the tier (which could be looser than the operator intended) and
    // must NOT be honoured as-is (which is "uncapped" by another name).
    expect(normalizeCapOverride(9e18, APP_CAP_OVERRIDE_MAX_DAILY_BUZZ)).toBe(
      APP_CAP_OVERRIDE_MAX_DAILY_BUZZ
    );
    expect(normalizeCapOverride(10_000_000, APP_CAP_OVERRIDE_MAX_VELOCITY_GENS)).toBe(
      APP_CAP_OVERRIDE_MAX_VELOCITY_GENS
    );
  });

  it.each([
    ['null (no override set — the normal case)', null],
    ['undefined (column absent)', undefined],
    ['zero (a disable decision, not a cap decision)', 0],
    ['a negative value', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a numeric STRING (Prisma would never, a hand-written row might)', '500'],
    ['an object', {}],
    ['a boolean', true],
  ])('rejects %s → undefined (fall back to the tier)', (_label, value) => {
    expect(normalizeCapOverride(value, APP_CAP_OVERRIDE_MAX_DAILY_BUZZ)).toBeUndefined();
  });

  it('never returns a non-positive or non-finite value for ANY input', () => {
    const inputs: unknown[] = [
      0,
      -5,
      -0.4,
      0.4,
      1,
      1.9,
      1e12,
      9e99,
      Number.NaN,
      Infinity,
      -Infinity,
      null,
      undefined,
      '10',
      {},
      [],
      true,
    ];
    for (const v of inputs) {
      const out = normalizeCapOverride(v, APP_CAP_OVERRIDE_MAX_DAILY_BUZZ);
      if (out !== undefined) {
        expect(Number.isInteger(out)).toBe(true);
        expect(out).toBeGreaterThan(0);
        expect(out).toBeLessThanOrEqual(APP_CAP_OVERRIDE_MAX_DAILY_BUZZ);
      }
    }
  });
});

describe('resolveLimitsFromRow — override precedence', () => {
  it('with NO override, falls back to the tier', () => {
    expect(
      resolveLimitsFromRow({
        trustTier: 'verified',
        spendCapBuzzPerDay: null,
        spendVelocityMaxGens: null,
      })
    ).toEqual(APP_TIER_CAP_LIMITS.verified);
  });

  it('an override TAKES PRECEDENCE over the tier', () => {
    expect(
      resolveLimitsFromRow({
        trustTier: 'unverified',
        spendCapBuzzPerDay: 9_000_000,
        spendVelocityMaxGens: 2_000,
      })
    ).toEqual({ dailyBuzz: 9_000_000, velocityMaxGens: 2_000 });
  });

  it('the two override fields are INDEPENDENT (one set, one falls back)', () => {
    expect(
      resolveLimitsFromRow({
        trustTier: 'internal',
        spendCapBuzzPerDay: null,
        spendVelocityMaxGens: 42,
      })
    ).toEqual({ dailyBuzz: APP_TIER_CAP_LIMITS.internal.dailyBuzz, velocityMaxGens: 42 });

    expect(
      resolveLimitsFromRow({
        trustTier: 'internal',
        spendCapBuzzPerDay: 7,
        spendVelocityMaxGens: null,
      })
    ).toEqual({ dailyBuzz: 7, velocityMaxGens: APP_TIER_CAP_LIMITS.internal.velocityMaxGens });
  });

  it('an override may TIGHTEN, not just loosen (clamp one abusive app in place)', () => {
    const out = resolveLimitsFromRow({
      trustTier: 'internal',
      spendCapBuzzPerDay: 1_000,
      spendVelocityMaxGens: 2,
    });
    expect(out.dailyBuzz).toBeLessThan(APP_TIER_CAP_LIMITS.internal.dailyBuzz);
    expect(out.velocityMaxGens).toBeLessThan(APP_TIER_CAP_LIMITS.internal.velocityMaxGens);
  });

  it('an UNKNOWN tier with no override → strictest (never uncapped)', () => {
    expect(
      resolveLimitsFromRow({
        trustTier: 'platinum-elite',
        spendCapBuzzPerDay: null,
        spendVelocityMaxGens: null,
      })
    ).toEqual(STRICTEST_APP_CAP_LIMITS);
  });

  it('an UNKNOWN tier WITH a partial override uses the override for that field and strictest for the other', () => {
    expect(
      resolveLimitsFromRow({
        trustTier: null,
        spendCapBuzzPerDay: null,
        spendVelocityMaxGens: 900,
      })
    ).toEqual({ dailyBuzz: STRICTEST_APP_CAP_LIMITS.dailyBuzz, velocityMaxGens: 900 });
  });

  it('a GARBAGE override value is ignored → the tier still applies (not uncapped, not zero)', () => {
    const out = resolveLimitsFromRow({
      trustTier: 'verified',
      // A hand-written/legacy row could hold these despite the CHECK constraints.
      spendCapBuzzPerDay: 0,
      spendVelocityMaxGens: -17,
    } as never);
    expect(out).toEqual(APP_TIER_CAP_LIMITS.verified);
  });

  it('always yields a positive, finite pair for arbitrary junk rows', () => {
    const junkRows = [
      { trustTier: null, spendCapBuzzPerDay: null, spendVelocityMaxGens: null },
      { trustTier: '', spendCapBuzzPerDay: Number.NaN, spendVelocityMaxGens: Infinity },
      { trustTier: 42, spendCapBuzzPerDay: '900', spendVelocityMaxGens: {} },
      { trustTier: 'internal', spendCapBuzzPerDay: -1, spendVelocityMaxGens: 0 },
    ] as unknown as Parameters<typeof resolveLimitsFromRow>[0][];
    for (const row of junkRows) {
      const out: AppCapLimits = resolveLimitsFromRow(row);
      expect(out.dailyBuzz).toBeGreaterThan(0);
      expect(out.velocityMaxGens).toBeGreaterThan(0);
      expect(Number.isFinite(out.dailyBuzz)).toBe(true);
      expect(Number.isFinite(out.velocityMaxGens)).toBe(true);
    }
  });
});

/**
 * Env-override parsing. The constants are module-level, so each case needs a
 * fresh module registry — `vi.resetModules()` + a dynamic import.
 */
describe('env overrides — fail-safe parsing', () => {
  const ENV_KEYS = [
    'BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY',
    'BLOCK_APP_SPEND_VELOCITY_MAX_GENS',
    'BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
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

  it('a VALID override is honoured across the whole tier table', async () => {
    process.env.BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY = '1000000';
    process.env.BLOCK_APP_SPEND_VELOCITY_MAX_GENS = '900';
    process.env.BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS = '30';
    const m = await loadConstants();
    expect(m.BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY).toBe(1_000_000);
    expect(m.BLOCK_APP_SPEND_VELOCITY_MAX_GENS).toBe(900);
    expect(m.BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS).toBe(30);
    // One knob moves the whole table coherently.
    expect(m.APP_TIER_CAP_LIMITS.verified).toEqual({ dailyBuzz: 1_000_000, velocityMaxGens: 900 });
    expect(m.APP_TIER_CAP_LIMITS.internal).toEqual({
      dailyBuzz: 5_000_000,
      velocityMaxGens: 4_500,
    });
  });

  it('UNSET falls back to the built-in defaults', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const m = await loadConstants();
    expect(m.BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY).toBe(5_000_000);
    expect(m.BLOCK_APP_SPEND_VELOCITY_MAX_GENS).toBe(600);
    expect(m.BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS).toBe(60);
  });

  it.each([
    ['UNPARSEABLE', 'not-a-number'],
    ['an empty string', ''],
    ['ZERO', '0'],
    ['NEGATIVE', '-500'],
    ['Infinity', 'Infinity'],
    ['whitespace', '   '],
  ])('%s falls back to the default (a typo can never disable a cap)', async (_label, raw) => {
    process.env.BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY = raw;
    process.env.BLOCK_APP_SPEND_VELOCITY_MAX_GENS = raw;
    process.env.BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS = raw;
    const m = await loadConstants();
    expect(m.BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY).toBe(5_000_000);
    expect(m.BLOCK_APP_SPEND_VELOCITY_MAX_GENS).toBe(600);
    expect(m.BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS).toBe(60);
  });

  it('a FRACTIONAL override is floored to an integer', async () => {
    process.env.BLOCK_APP_SPEND_VELOCITY_MAX_GENS = '250.7';
    const m = await loadConstants();
    expect(m.BLOCK_APP_SPEND_VELOCITY_MAX_GENS).toBe(250);
  });

  it('TIGHTENING the global below 120 also tightens `unverified` (it is never looser than the global)', async () => {
    process.env.BLOCK_APP_SPEND_VELOCITY_MAX_GENS = '50';
    const m = await loadConstants();
    expect(m.APP_TIER_CAP_LIMITS.unverified.velocityMaxGens).toBe(50);
    expect(m.APP_TIER_CAP_LIMITS.verified.velocityMaxGens).toBe(50);
    // …and the strictest fallback tracks it down.
    expect(m.STRICTEST_APP_CAP_LIMITS.velocityMaxGens).toBe(50);
  });

  it('the strictest fallback stays the per-field minimum under ANY env setting', async () => {
    process.env.BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY = '7';
    process.env.BLOCK_APP_SPEND_VELOCITY_MAX_GENS = '3';
    const m = await loadConstants();
    const all = Object.values(m.APP_TIER_CAP_LIMITS);
    expect(m.STRICTEST_APP_CAP_LIMITS.dailyBuzz).toBe(Math.min(...all.map((l) => l.dailyBuzz)));
    expect(m.STRICTEST_APP_CAP_LIMITS.velocityMaxGens).toBe(
      Math.min(...all.map((l) => l.velocityMaxGens))
    );
    expect(m.STRICTEST_APP_CAP_LIMITS.dailyBuzz).toBeGreaterThan(0);
  });
});
