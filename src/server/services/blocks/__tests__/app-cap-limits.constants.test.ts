import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PER-APP cap LIMITS — the pure tier table + fallback rules.
 *
 * Two properties every case here defends:
 *
 *  1. There is NO input — unknown tier, NULL tier, absent override, garbage
 *     override, hostile env — for which this module yields an unbounded (or
 *     non-positive) ceiling. A cap that silently resolves to "no cap" is worse
 *     than no cap at all, because nothing downstream can tell the difference.
 *
 *  2. SPEND IS ITS OWN AXIS. The ceilings derive from `spendTier` and never
 *     from `trustTier` (the iframe-sandbox / renderMode axis). Production
 *     already carries rows at `trust_tier='internal'` that were tiered for
 *     RENDERING, years of review-flow habit before a spend cap existed; reading
 *     them as spend grants would have handed them 5x the money ceiling on
 *     merge. The vocabularies are disjoint so the two can never be confused.
 */

import {
  APP_CAP_OVERRIDE_MAX_DAILY_BUZZ,
  APP_CAP_OVERRIDE_MAX_VELOCITY_GENS,
  APP_SPEND_TIER_CAP_LIMITS,
  APP_SPEND_TIERS,
  BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY,
  BLOCK_APP_SPEND_VELOCITY_MAX_GENS,
  BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS,
  DEFAULT_APP_SPEND_TIER,
  isAppSpendTier,
  limitsForSpendTier,
  normalizeCapOverride,
  resolveLimitsFromRow,
  SHIPPED_APP_DAILY_BUZZ_CEILING,
  SHIPPED_APP_VELOCITY_MAX_GENS,
  STRICTEST_APP_CAP_LIMITS,
  type AppCapLimits,
} from '../app-cap-limits.constants';

/** The `trustTier` enum, read from the canonical single-sourced manifest schema. */
function manifestTrustTiers(): string[] {
  const schemaPath = join(process.cwd(), 'public/schemas/app-block/v1.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
    properties: { trustTier: { enum: string[] } };
  };
  return schema.properties.trustTier.enum;
}

describe('spend tiers are DECOUPLED from trust tiers', () => {
  it('shares NO value with the manifest `trustTier` enum', () => {
    // 🔴 THE DECOUPLING GUARD. If the two vocabularies ever overlapped, a
    // `trustTier` value written into `spend_tier` (or vice versa) would resolve
    // to a plausible-looking wrong ceiling instead of failing closed. Disjoint
    // sets make that mistake loud: an unrecognised value → STRICTEST.
    const trust = new Set(manifestTrustTiers());
    for (const spendTier of APP_SPEND_TIERS) {
      expect(trust.has(spendTier)).toBe(false);
    }
  });

  it('resolves every REAL trustTier value to the STRICTEST limits, not to a tier', () => {
    // The scenario that made this PR wrong: three live rows already sat at
    // trust_tier='internal'. If `internal` leaked into the spend axis it must
    // NOT be read as a spend grant.
    for (const trustTier of manifestTrustTiers()) {
      expect(limitsForSpendTier(trustTier)).toEqual(STRICTEST_APP_CAP_LIMITS);
    }
    expect(limitsForSpendTier('internal')).toEqual(STRICTEST_APP_CAP_LIMITS);
  });

  it('the row shape the resolver reads carries NO trust tier at all', () => {
    // Compile-time guarantee expressed at runtime: a row carrying a trustTier
    // (and nothing else) resolves to the strictest limits, because the field is
    // simply not consulted. `internal` cannot buy headroom through this door.
    const rowWithOnlyTrustTier = {
      trustTier: 'internal',
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: null,
    } as unknown as Parameters<typeof resolveLimitsFromRow>[0];
    expect(resolveLimitsFromRow(rowWithOnlyTrustTier)).toEqual(STRICTEST_APP_CAP_LIMITS);
  });

  it("THE LIVE PRODUCTION CASE: trustTier='internal' + default spendTier gets TODAY'S ceilings", () => {
    // Verified against the civitai DB 2026-07-31: 3 rows internal, 18
    // unverified, 0 verified. After the migration every one of them carries
    // spend_tier='standard'. This is the "merging changes nothing" claim,
    // stated as an executable assertion rather than as prose.
    const liveInternalRow = {
      spendTier: DEFAULT_APP_SPEND_TIER,
      spendCapBuzzPerDay: null,
      spendVelocityMaxGens: null,
    };
    expect(resolveLimitsFromRow(liveInternalRow)).toEqual({
      dailyBuzz: 5_000_000,
      velocityMaxGens: 120,
    });
    // …and specifically NOT the elevated pair the coupled design would have given it.
    expect(resolveLimitsFromRow(liveInternalRow)).not.toEqual(APP_SPEND_TIER_CAP_LIMITS.platform);
  });

  it('moving one axis does not move the other — spendTier alone decides the ceiling', () => {
    const base = { spendCapBuzzPerDay: null, spendVelocityMaxGens: null };
    // Same spend tier, any imaginable trust tier → identical limits.
    const withTrust = manifestTrustTiers().map((trustTier) =>
      resolveLimitsFromRow({ ...base, spendTier: 'trusted', trustTier } as never)
    );
    for (const limits of withTrust) {
      expect(limits).toEqual(APP_SPEND_TIER_CAP_LIMITS.trusted);
    }
    // Different spend tiers → different limits, regardless of trust tier.
    expect(
      resolveLimitsFromRow({ ...base, spendTier: 'standard', trustTier: 'internal' } as never)
    ).toEqual(APP_SPEND_TIER_CAP_LIMITS.standard);
    expect(
      resolveLimitsFromRow({ ...base, spendTier: 'platform', trustTier: 'unverified' } as never)
    ).toEqual(APP_SPEND_TIER_CAP_LIMITS.platform);
  });
});

describe('spend tiers — the enumeration', () => {
  it('every tier has an entry in the limits table, and nothing else does', () => {
    for (const tier of APP_SPEND_TIERS) {
      expect(APP_SPEND_TIER_CAP_LIMITS[tier]).toBeDefined();
    }
    expect(Object.keys(APP_SPEND_TIER_CAP_LIMITS).sort()).toEqual([...APP_SPEND_TIERS].sort());
  });

  it('the DB default tier is a real tier', () => {
    expect(APP_SPEND_TIERS).toContain(DEFAULT_APP_SPEND_TIER);
    expect(DEFAULT_APP_SPEND_TIER).toBe('standard');
  });

  it('isAppSpendTier accepts only the real spend tiers', () => {
    for (const tier of APP_SPEND_TIERS) expect(isAppSpendTier(tier)).toBe(true);
    for (const junk of [
      'unverified',
      'verified',
      'internal',
      'Standard',
      'PLATFORM',
      '',
      null,
      undefined,
      7,
      {},
      [],
    ]) {
      expect(isAppSpendTier(junk)).toBe(false);
    }
  });
});

describe('tier → limits table', () => {
  it('maps EVERY tier to the documented pair', () => {
    // The table the PR body publishes — pinned so a silent retune is a test diff.
    expect(APP_SPEND_TIER_CAP_LIMITS.standard).toEqual({
      dailyBuzz: 5_000_000,
      velocityMaxGens: 120,
    });
    expect(APP_SPEND_TIER_CAP_LIMITS.trusted).toEqual({
      dailyBuzz: 5_000_000,
      velocityMaxGens: 600,
    });
    expect(APP_SPEND_TIER_CAP_LIMITS.platform).toEqual({
      dailyBuzz: 25_000_000,
      velocityMaxGens: 3_000,
    });
  });

  it('keeps `standard` byte-identical to the PRE-CHANGE global ceilings', () => {
    // Every existing app row defaults to spend_tier='standard', so this is the
    // "merging changes nothing for anyone live today" guarantee. The pinned
    // constants are the numbers that were in force in production (no
    // BLOCK_APP_SPEND_* env override is set on civitai-dp-prod).
    expect(SHIPPED_APP_DAILY_BUZZ_CEILING).toBe(5_000_000);
    expect(SHIPPED_APP_VELOCITY_MAX_GENS).toBe(120);
    expect(APP_SPEND_TIER_CAP_LIMITS[DEFAULT_APP_SPEND_TIER]).toEqual({
      dailyBuzz: SHIPPED_APP_DAILY_BUZZ_CEILING,
      velocityMaxGens: SHIPPED_APP_VELOCITY_MAX_GENS,
    });
  });

  it('every tier limit is a POSITIVE INTEGER (no tier can express "uncapped")', () => {
    for (const tier of APP_SPEND_TIERS) {
      const l = APP_SPEND_TIER_CAP_LIMITS[tier];
      expect(Number.isInteger(l.dailyBuzz)).toBe(true);
      expect(Number.isInteger(l.velocityMaxGens)).toBe(true);
      expect(l.dailyBuzz).toBeGreaterThan(0);
      expect(l.velocityMaxGens).toBeGreaterThan(0);
      expect(Number.isFinite(l.dailyBuzz)).toBe(true);
      expect(Number.isFinite(l.velocityMaxGens)).toBe(true);
    }
  });

  it('NO TIER EXCEEDS THE GLOBAL CEILING — including the loosest', () => {
    // 🔴 The global env knobs are CEILINGS, not bases to multiply from. An
    // earlier revision computed the top tier as `global x 5`, so an operator
    // clamping the global to 50 in an incident got a top tier of 250.
    for (const tier of APP_SPEND_TIERS) {
      const l = APP_SPEND_TIER_CAP_LIMITS[tier];
      expect(l.dailyBuzz).toBeLessThanOrEqual(BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY);
      expect(l.velocityMaxGens).toBeLessThanOrEqual(BLOCK_APP_SPEND_VELOCITY_MAX_GENS);
    }
  });

  it('the default globals are the ABSOLUTE ceilings — the hard bound, i.e. no extra clamp', () => {
    // Unset, the incident knob must not bind: a moderator override of N means N,
    // and the schema maximum and the enforced maximum agree. It only bites when
    // an operator reaches for it.
    expect(BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY).toBe(APP_CAP_OVERRIDE_MAX_DAILY_BUZZ);
    expect(BLOCK_APP_SPEND_VELOCITY_MAX_GENS).toBe(APP_CAP_OVERRIDE_MAX_VELOCITY_GENS);
    expect(BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS).toBe(60);
    // …and the loosest TIER still sits well below them (the tiers are absolute
    // targets, not a function of the ceiling).
    expect(APP_SPEND_TIER_CAP_LIMITS.platform.dailyBuzz).toBeLessThan(
      BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY
    );
    expect(APP_SPEND_TIER_CAP_LIMITS.platform.velocityMaxGens).toBeLessThan(
      BLOCK_APP_SPEND_VELOCITY_MAX_GENS
    );
  });
});

describe('STRICTEST_APP_CAP_LIMITS — the fail-closed fallback', () => {
  it('is the per-field MINIMUM across the whole tier table', () => {
    const all = Object.values(APP_SPEND_TIER_CAP_LIMITS);
    expect(STRICTEST_APP_CAP_LIMITS.dailyBuzz).toBe(Math.min(...all.map((l) => l.dailyBuzz)));
    expect(STRICTEST_APP_CAP_LIMITS.velocityMaxGens).toBe(
      Math.min(...all.map((l) => l.velocityMaxGens))
    );
  });

  it('is no looser than ANY tier in either dimension', () => {
    for (const tier of APP_SPEND_TIERS) {
      const l = APP_SPEND_TIER_CAP_LIMITS[tier];
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

describe('limitsForSpendTier', () => {
  it('returns the tier table entry for every REAL tier', () => {
    for (const tier of APP_SPEND_TIERS) {
      expect(limitsForSpendTier(tier)).toEqual(APP_SPEND_TIER_CAP_LIMITS[tier]);
    }
  });

  it.each([
    ['an unknown tier string', 'platinum'],
    ['a trustTier value (the decoupling case)', 'internal'],
    ['a tier with wrong case', 'Trusted'],
    ['an empty string', ''],
    ['NULL (a column that was never defaulted)', null],
    ['undefined (field absent from the select)', undefined],
    ['a number', 3],
    ['an object', { tier: 'platform' }],
    ['an array', ['platform']],
  ])('falls back to the STRICTEST limits for %s — never uncapped', (_label, value) => {
    expect(limitsForSpendTier(value)).toEqual(STRICTEST_APP_CAP_LIMITS);
  });

  it('never resolves an unknown tier to the LOOSEST tier', () => {
    const loosest = APP_SPEND_TIER_CAP_LIMITS.platform;
    const resolved = limitsForSpendTier('definitely-not-a-tier');
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
    // must NOT be honoured as-is (which is "uncapped" by another name). With the
    // migration's CHECK constraints applied such a value cannot reach the column
    // at all; this clamp is what still holds where the constraint is missing.
    expect(normalizeCapOverride(9e18, APP_CAP_OVERRIDE_MAX_DAILY_BUZZ)).toBe(
      APP_CAP_OVERRIDE_MAX_DAILY_BUZZ
    );
    expect(normalizeCapOverride(2_000_000_000, APP_CAP_OVERRIDE_MAX_DAILY_BUZZ)).toBe(
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

/**
 * 🔴 THE DB CONSTRAINTS AND THE CODE BOUNDS ARE THE SAME NUMBERS.
 *
 * An INTEGER column accepts 2,147,483,647. The earlier `> 0` CHECK let a
 * hand-written 2000000000 in; enforcement then clamped it to 1e9 while the mod
 * read surface reported the raw value — one value, three different numbers.
 * These cases read the migration SQL and assert it agrees with the constants,
 * so the two can never drift.
 */
describe('CHECK constraints match the code bounds exactly', () => {
  const migrationSql = readFileSync(
    join(
      process.cwd(),
      'packages/civitai-db-schema/prisma/migrations',
      '20260731120000_app_block_spend_tier_and_cap_override',
      'migration.sql'
    ),
    'utf8'
  );

  it('bounds the daily-Buzz override at APP_CAP_OVERRIDE_MAX_DAILY_BUZZ, not just > 0', () => {
    expect(migrationSql).toContain(
      `"spend_cap_buzz_per_day" >= 1 AND "spend_cap_buzz_per_day" <= ${APP_CAP_OVERRIDE_MAX_DAILY_BUZZ}`
    );
  });

  it('bounds the velocity override at APP_CAP_OVERRIDE_MAX_VELOCITY_GENS', () => {
    expect(migrationSql).toContain(
      `"spend_velocity_max_gens" >= 1 AND "spend_velocity_max_gens" <= ${APP_CAP_OVERRIDE_MAX_VELOCITY_GENS}`
    );
  });

  it('does NOT ship a bare positivity check (the bound is the whole point)', () => {
    expect(migrationSql).not.toContain('"spend_cap_buzz_per_day" > 0');
    expect(migrationSql).not.toContain('"spend_velocity_max_gens" > 0');
  });

  it('restricts spend_tier to exactly the tiers this module knows', () => {
    const rendered = APP_SPEND_TIERS.map((t) => `'${t}'`).join(', ');
    expect(migrationSql).toContain(`CHECK ("spend_tier" IN (${rendered}))`);
  });

  it('defaults spend_tier to the tier whose limits are the pre-change ceilings', () => {
    expect(migrationSql).toContain(
      `ADD COLUMN IF NOT EXISTS "spend_tier" TEXT NOT NULL DEFAULT '${DEFAULT_APP_SPEND_TIER}'`
    );
  });

  it('a value above the code bound would be REJECTED by the DB, not silently clamped', () => {
    // The value that motivated this: 2e9 fits in INTEGER and passes `> 0`.
    const handWritten = 2_000_000_000;
    expect(handWritten).toBeLessThan(2_147_483_647); // fits the column type
    expect(handWritten).toBeGreaterThan(APP_CAP_OVERRIDE_MAX_DAILY_BUZZ); // exceeds the code bound
    // The reader would have clamped it (silently) …
    expect(normalizeCapOverride(handWritten, APP_CAP_OVERRIDE_MAX_DAILY_BUZZ)).toBe(
      APP_CAP_OVERRIDE_MAX_DAILY_BUZZ
    );
    // … so the CHECK must refuse it at write time instead.
    expect(migrationSql).toContain(`<= ${APP_CAP_OVERRIDE_MAX_DAILY_BUZZ}`);
  });
});

describe('resolveLimitsFromRow — override precedence', () => {
  it('with NO override, falls back to the tier', () => {
    expect(
      resolveLimitsFromRow({
        spendTier: 'trusted',
        spendCapBuzzPerDay: null,
        spendVelocityMaxGens: null,
      })
    ).toEqual(APP_SPEND_TIER_CAP_LIMITS.trusted);
  });

  it('an override TAKES PRECEDENCE over the tier', () => {
    expect(
      resolveLimitsFromRow({
        spendTier: 'standard',
        spendCapBuzzPerDay: 9_000_000,
        spendVelocityMaxGens: 2_000,
      })
    ).toEqual({ dailyBuzz: 9_000_000, velocityMaxGens: 2_000 });
  });

  it('the two override fields are INDEPENDENT (one set, one falls back)', () => {
    expect(
      resolveLimitsFromRow({
        spendTier: 'platform',
        spendCapBuzzPerDay: null,
        spendVelocityMaxGens: 42,
      })
    ).toEqual({ dailyBuzz: APP_SPEND_TIER_CAP_LIMITS.platform.dailyBuzz, velocityMaxGens: 42 });

    expect(
      resolveLimitsFromRow({
        spendTier: 'platform',
        spendCapBuzzPerDay: 7,
        spendVelocityMaxGens: null,
      })
    ).toEqual({
      dailyBuzz: 7,
      velocityMaxGens: APP_SPEND_TIER_CAP_LIMITS.platform.velocityMaxGens,
    });
  });

  it('an override may TIGHTEN, not just loosen (clamp one abusive app in place)', () => {
    const out = resolveLimitsFromRow({
      spendTier: 'platform',
      spendCapBuzzPerDay: 1_000,
      spendVelocityMaxGens: 2,
    });
    expect(out.dailyBuzz).toBeLessThan(APP_SPEND_TIER_CAP_LIMITS.platform.dailyBuzz);
    expect(out.velocityMaxGens).toBeLessThan(APP_SPEND_TIER_CAP_LIMITS.platform.velocityMaxGens);
  });

  it('an override at the schema maximum is honoured EXACTLY when no clamp is set', () => {
    // With the global unset (its default IS the hard bound) a moderator's number
    // is not silently reinterpreted. The clamped case is covered in the env
    // suite below, where an operator has actually reached for the knob.
    const out = resolveLimitsFromRow({
      spendTier: 'standard',
      spendCapBuzzPerDay: APP_CAP_OVERRIDE_MAX_DAILY_BUZZ,
      spendVelocityMaxGens: APP_CAP_OVERRIDE_MAX_VELOCITY_GENS,
    });
    expect(out).toEqual({
      dailyBuzz: APP_CAP_OVERRIDE_MAX_DAILY_BUZZ,
      velocityMaxGens: APP_CAP_OVERRIDE_MAX_VELOCITY_GENS,
    });
  });

  it('an UNKNOWN tier with no override → strictest (never uncapped)', () => {
    expect(
      resolveLimitsFromRow({
        spendTier: 'platinum-elite',
        spendCapBuzzPerDay: null,
        spendVelocityMaxGens: null,
      })
    ).toEqual(STRICTEST_APP_CAP_LIMITS);
  });

  it('an UNKNOWN tier WITH a partial override uses the override for that field and strictest for the other', () => {
    expect(
      resolveLimitsFromRow({
        spendTier: null,
        spendCapBuzzPerDay: null,
        spendVelocityMaxGens: 900,
      })
    ).toEqual({ dailyBuzz: STRICTEST_APP_CAP_LIMITS.dailyBuzz, velocityMaxGens: 900 });
  });

  it('a GARBAGE override value is ignored → the tier still applies (not uncapped, not zero)', () => {
    const out = resolveLimitsFromRow({
      spendTier: 'trusted',
      // A hand-written/legacy row could hold these despite the CHECK constraints.
      spendCapBuzzPerDay: 0,
      spendVelocityMaxGens: -17,
    } as never);
    expect(out).toEqual(APP_SPEND_TIER_CAP_LIMITS.trusted);
  });

  it('always yields a positive, finite pair for arbitrary junk rows', () => {
    const junkRows = [
      { spendTier: null, spendCapBuzzPerDay: null, spendVelocityMaxGens: null },
      { spendTier: '', spendCapBuzzPerDay: Number.NaN, spendVelocityMaxGens: Infinity },
      { spendTier: 42, spendCapBuzzPerDay: '900', spendVelocityMaxGens: {} },
      { spendTier: 'platform', spendCapBuzzPerDay: -1, spendVelocityMaxGens: 0 },
      { spendTier: 'internal', spendCapBuzzPerDay: undefined, spendVelocityMaxGens: undefined },
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
describe('env overrides — fail-safe parsing, and the global is a real CEILING', () => {
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

  it('UNSET falls back to the built-in defaults', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const m = await loadConstants();
    expect(m.BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY).toBe(1_000_000_000);
    expect(m.BLOCK_APP_SPEND_VELOCITY_MAX_GENS).toBe(100_000);
    expect(m.BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS).toBe(60);
    // …and the DEFAULT tier is still exactly the pre-change shipped ceilings.
    expect(m.APP_SPEND_TIER_CAP_LIMITS.standard).toEqual({
      dailyBuzz: 5_000_000,
      velocityMaxGens: 120,
    });
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
    expect(m.BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY).toBe(1_000_000_000);
    expect(m.BLOCK_APP_SPEND_VELOCITY_MAX_GENS).toBe(100_000);
    expect(m.BLOCK_APP_SPEND_VELOCITY_WINDOW_SECONDS).toBe(60);
  });

  it('a FRACTIONAL override is floored to an integer', async () => {
    process.env.BLOCK_APP_SPEND_VELOCITY_MAX_GENS = '250.7';
    const m = await loadConstants();
    expect(m.BLOCK_APP_SPEND_VELOCITY_MAX_GENS).toBe(250);
  });

  it('🔴 CLAMPING THE GLOBAL TO 50 CLAMPS EVERY TIER TO 50 — including the loosest', async () => {
    // The incident scenario. Under the earlier `internal = global x 5` shape
    // this produced a top tier of 250 — 5x LOOSER than the clamp just applied.
    process.env.BLOCK_APP_SPEND_VELOCITY_MAX_GENS = '50';
    const m = await loadConstants();
    for (const tier of m.APP_SPEND_TIERS) {
      expect(m.APP_SPEND_TIER_CAP_LIMITS[tier].velocityMaxGens).toBe(50);
    }
    expect(m.STRICTEST_APP_CAP_LIMITS.velocityMaxGens).toBe(50);
  });

  it('🔴 the global also clamps a per-app OVERRIDE, not just the tier', async () => {
    process.env.BLOCK_APP_SPEND_VELOCITY_MAX_GENS = '50';
    process.env.BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY = '1000';
    const m = await loadConstants();
    expect(
      m.resolveLimitsFromRow({
        spendTier: 'platform',
        spendCapBuzzPerDay: 900_000_000,
        spendVelocityMaxGens: 90_000,
      })
    ).toEqual({ dailyBuzz: 1_000, velocityMaxGens: 50 });
  });

  it('RAISING the global does NOT loosen any tier past its target', async () => {
    // The knob only tightens. Loosening an app is a moderator decision (its
    // spendTier), never a deploy-env side effect.
    process.env.BLOCK_APP_SPEND_VELOCITY_MAX_GENS = '999999';
    process.env.BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY = '999999999';
    const m = await loadConstants();
    expect(m.APP_SPEND_TIER_CAP_LIMITS.standard).toEqual({
      dailyBuzz: 5_000_000,
      velocityMaxGens: 120,
    });
    expect(m.APP_SPEND_TIER_CAP_LIMITS.platform).toEqual({
      dailyBuzz: 25_000_000,
      velocityMaxGens: 3_000,
    });
  });

  it('no tier exceeds the global under ANY env setting', async () => {
    for (const raw of ['1', '7', '119', '600', '3000', '10000000']) {
      vi.resetModules();
      process.env.BLOCK_APP_SPEND_VELOCITY_MAX_GENS = raw;
      process.env.BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY = raw;
      const m = await loadConstants();
      for (const tier of m.APP_SPEND_TIERS) {
        const l = m.APP_SPEND_TIER_CAP_LIMITS[tier];
        expect(l.velocityMaxGens).toBeLessThanOrEqual(m.BLOCK_APP_SPEND_VELOCITY_MAX_GENS);
        expect(l.dailyBuzz).toBeLessThanOrEqual(m.BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY);
        expect(l.velocityMaxGens).toBeGreaterThan(0);
        expect(l.dailyBuzz).toBeGreaterThan(0);
      }
    }
  });

  it('the strictest fallback stays the per-field minimum under ANY env setting', async () => {
    process.env.BLOCK_APP_SPEND_CAP_BUZZ_PER_DAY = '7';
    process.env.BLOCK_APP_SPEND_VELOCITY_MAX_GENS = '3';
    const m = await loadConstants();
    const all = Object.values(m.APP_SPEND_TIER_CAP_LIMITS);
    expect(m.STRICTEST_APP_CAP_LIMITS.dailyBuzz).toBe(Math.min(...all.map((l) => l.dailyBuzz)));
    expect(m.STRICTEST_APP_CAP_LIMITS.velocityMaxGens).toBe(
      Math.min(...all.map((l) => l.velocityMaxGens))
    );
    expect(m.STRICTEST_APP_CAP_LIMITS.dailyBuzz).toBeGreaterThan(0);
  });
});
