import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Blocks PER-GENERATION AUTHOR FEE — slice 1 (computation + config + dark gate).
 *
 *   fee = max(flatBuzz, pctOfBase × base_generation_buzz)
 *
 * WHAT THIS SUITE IS, STATED HONESTLY. `author-fee.ts` is a NEW module, so most
 * tests below are NEW-FEATURE coverage, not regression coverage: they could not
 * have been red at `origin/main` for any reason except the import failing. The
 * claim that these guards are real is carried by the MUTATION SWEEP recorded in
 * the PR body — each rule below was broken on purpose and the naming test is the
 * one that went red. Guards labelled INVARIANT GUARD pin a property the code has
 * always had rather than one this change introduced.
 *
 * THE EXCEPTION is `the PLATFORM table, as production resolves it`: those cases
 * pass NO `config` argument, so they exercise `BLOCK_AUTHOR_FEE_PLATFORM_CONFIG`
 * itself, and they were RED at the revision that shipped `byType: []` (the
 * chat-completion cases returned the 1 ⚡ / 5% default). They are regression
 * coverage for the seeded table, not fixture coverage.
 *
 * The other genuinely red-at-base guard for this change is
 * `src/server/services/__tests__/no-divergent-author-fee-base.test.ts`, which
 * pins the router call sites.
 *
 * Every expected value below is a LITERAL computed by hand from the rule, never
 * from the implementation. The fixtures deliberately avoid the module's own
 * constants (1, 5, 100, 10000) as ANSWERS wherever a mutant could hardcode one:
 * 137 ⚡ at 5% is 6, not any constant in the file.
 */

import {
  BLOCK_AUTHOR_FEE_BASIS_POINTS_SCALE,
  BLOCK_AUTHOR_FEE_DEFAULT_FLAT_BUZZ,
  BLOCK_AUTHOR_FEE_DEFAULT_PCT_OF_BASE,
  BLOCK_AUTHOR_FEE_MAX_FLAT_BUZZ,
  BLOCK_AUTHOR_FEE_MAX_PCT_BASIS_POINTS,
  BLOCK_AUTHOR_FEE_MAX_PCT_OF_BASE,
  BLOCK_AUTHOR_FEE_PLATFORM_CONFIG,
  blockAuthorFeeCeilingBasisPoints,
  clampBlockAuthorFeeParams,
  computeBlockAuthorFee,
  describeBlockAuthorFee,
  resolveBlockAuthorFeeParams,
  type BlockAuthorFeeConfig,
} from '../author-fee';

// A configuration whose numbers share no value with the platform defaults or the
// ceilings, so an assertion cannot pass by coincidence with a mutant that reaches
// for a constant instead of the configured value.
const DISTINCT: BlockAuthorFeeConfig = {
  default: { flatBuzz: 3, pctOfBase: 0.02 },
};

describe('author fee — the platform defaults and ceilings', () => {
  it('defaults to 1 flat / 5% of base', () => {
    expect(BLOCK_AUTHOR_FEE_DEFAULT_FLAT_BUZZ).toBe(1);
    expect(BLOCK_AUTHOR_FEE_DEFAULT_PCT_OF_BASE).toBe(0.05);
    expect(BLOCK_AUTHOR_FEE_PLATFORM_CONFIG.default).toEqual({ flatBuzz: 1, pctOfBase: 0.05 });
  });

  it('caps flat at 100 and percent at 100%, and imposes NO minimum on either', () => {
    expect(BLOCK_AUTHOR_FEE_MAX_FLAT_BUZZ).toBe(100);
    expect(BLOCK_AUTHOR_FEE_MAX_PCT_OF_BASE).toBe(1);
    // 0 survives the clamp on both legs — a floor would show up here.
    expect(clampBlockAuthorFeeParams({ flatBuzz: 0, pctOfBase: 0 })).toEqual({
      flatBuzz: 0,
      pctBasisPoints: 0,
      clamped: false,
    });
  });

  it('the ENFORCED percentage ceiling IS the DECLARED one — one spelling, not two', () => {
    // 🔴 DIVERGENCE GUARD. `BLOCK_AUTHOR_FEE_MAX_PCT_OF_BASE` is the policy
    // number; slice 3's author-input validation reads it. Until the clamp bound
    // was derived from it, the clamp capped at `BLOCK_AUTHOR_FEE_BASIS_POINTS_SCALE`
    // instead — a SECOND, independent spelling of "100%" that agreed with this
    // one only by coincidence, with no implementation reading this constant at
    // all. Moving the declared ceiling and deleting its `toBe(1)` line left
    // every test green (measured at 92646e0: 84/84, mutant SURVIVED).
    //
    // Both halves are needed and neither alone suffices:
    //  (a) the RELATIONSHIP — the clamp must land at exactly the declared
    //      fraction of the base, so a bound that stops tracking the constant
    //      fails here;
    //  (b) the LITERAL — pinned so the pair cannot simply drift together.
    const base = 640;
    const overCeiling = computeBlockAuthorFee({
      baseGenerationBuzz: base,
      generationType: 'textToImage',
      // 900% — far above any plausible ceiling, so this exercises the bound
      // itself rather than the identity case.
      config: { default: { flatBuzz: 0, pctOfBase: 9 } },
    });
    expect(
      overCeiling.pctLegBuzz,
      'the ENFORCED percentage ceiling has diverged from BLOCK_AUTHOR_FEE_MAX_PCT_OF_BASE'
    ).toBe(Math.floor(BLOCK_AUTHOR_FEE_MAX_PCT_OF_BASE * base)); // (a)
    expect(BLOCK_AUTHOR_FEE_MAX_PCT_OF_BASE).toBe(1); // (b)
    expect(overCeiling.pctLegBuzz).toBe(640); // (b), behaviourally
    expect(overCeiling.clamped).toBe(true);
  });

  it('the ceiling is quantized DOWN — the enforced bound never sits ABOVE the declared policy', () => {
    // 🔴 DIRECTION GUARD, and it needs a ceiling the shipped policy constant
    // cannot express. `BLOCK_AUTHOR_FEE_MAX_PCT_OF_BASE` is 1, where flooring
    // and rounding are both 10000 — so NOTHING asserted about the shipped
    // constant can tell the two apart, and the derivation shipped with
    // `Math.round` for exactly that reason. Calling the derivation at a ceiling
    // finer than a basis point is what makes the direction observable.
    //
    // `toBasisPoints` floors because the module promises "a stated 5% never
    // charges more than 5%". Rounding the CEILING the other way enforces a bound
    // ABOVE the declared policy: 12.3456% would derive to 1235 bp = 12.35%.
    expect(
      blockAuthorFeeCeilingBasisPoints(0.123456),
      'the ceiling derivation ROUNDS — it must floor, like the quantization it governs'
    ).toBe(1234);
    // The mutant's answer, pinned so the two are visibly different numbers and
    // this case cannot quietly stop discriminating.
    expect(Math.round(0.123456 * BLOCK_AUTHOR_FEE_BASIS_POINTS_SCALE)).toBe(1235);

    // The property, at four ceilings that each round UP: the enforced bound is
    // never above the declared fraction expressed in basis points.
    for (const pct of [0.123456, 0.049999, 0.00005, 0.9999999]) {
      expect(
        blockAuthorFeeCeilingBasisPoints(pct),
        `a declared ceiling of ${pct} derived to an enforced bound ABOVE it`
      ).toBeLessThanOrEqual(pct * BLOCK_AUTHOR_FEE_BASIS_POINTS_SCALE);
    }

    // …and the shipped constant IS that derivation applied to the shipped
    // policy, so the guard above is about the constant and not about a helper
    // nothing uses.
    expect(BLOCK_AUTHOR_FEE_MAX_PCT_BASIS_POINTS).toBe(
      blockAuthorFeeCeilingBasisPoints(BLOCK_AUTHOR_FEE_MAX_PCT_OF_BASE)
    );
    expect(BLOCK_AUTHOR_FEE_MAX_PCT_BASIS_POINTS).toBe(10_000);
  });

  it('the constant is initialised BY THE NAMED FUNCTION, not by an inlined expression', () => {
    // 🔴 SOURCE-TEXT GUARD, and it exists because the behavioural pins above
    // CANNOT see the defect it covers. Re-inlining the derivation as
    // `Math.round(BLOCK_AUTHOR_FEE_MAX_PCT_OF_BASE * SCALE)` leaves
    // `blockAuthorFeeCeilingBasisPoints` in the file, still floors when called
    // directly, and still yields 10000 at the shipped policy of 1 — so the
    // direction cases, the property loop and the linking assertion are all
    // green while the SHIPPED CONSTANT is once again rounded. Measured: that
    // exact mutant SURVIVED the whole suite. The `⚠️ DO NOT INLINE IT BACK`
    // comment on the function was the only thing guarding it, and prose is not
    // a guard.
    //
    // Same technique, same reason, as the router seam guard in
    // `src/server/services/__tests__/no-divergent-author-fee-base.test.ts`: the
    // property is about which EXPRESSION ships, which no runtime value can
    // distinguish while floor and round agree.
    const source = readFileSync(
      path.join(process.cwd(), 'src/server/services/blocks/author-fee.ts'),
      'utf8'
    );

    // Positive control: without this, a bad path or a renamed constant would
    // make every assertion below vacuously true over an empty match set.
    const initialiser = source.match(
      /export const BLOCK_AUTHOR_FEE_MAX_PCT_BASIS_POINTS[^=]*=([\s\S]*?);/
    );
    expect(
      initialiser,
      'the ceiling constant was not found in author-fee.ts — guard is scanning the wrong source'
    ).not.toBeNull();

    expect(
      initialiser?.[1],
      'BLOCK_AUTHOR_FEE_MAX_PCT_BASIS_POINTS is no longer initialised by blockAuthorFeeCeilingBasisPoints — the derivation has been INLINED BACK, which makes its rounding direction unreachable from a test'
    ).toContain('blockAuthorFeeCeilingBasisPoints(');
    expect(
      initialiser?.[1],
      'the ceiling constant’s initialiser performs its own arithmetic — it must delegate to blockAuthorFeeCeilingBasisPoints, whose flooring is what the direction guard above pins'
    ).not.toMatch(/Math\.\w+|\*|\//);
  });

  it('seeds exactly ONE per-type override: chat-completion pays nothing', () => {
    expect(BLOCK_AUTHOR_FEE_PLATFORM_CONFIG.byType).toEqual([
      ['chat-completion', { flatBuzz: 0, pctOfBase: 0 }],
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SEEDED PLATFORM TABLE IS PRODUCTION BEHAVIOUR, not a fixture. Every test
// in this block calls `computeBlockAuthorFee` with NO `config` argument, so it
// exercises `BLOCK_AUTHOR_FEE_PLATFORM_CONFIG` — the object the one production
// caller actually uses. RED at the previous revision, whose `byType` was `[]`.
// ─────────────────────────────────────────────────────────────────────────────
describe('author fee — the PLATFORM table, as production resolves it', () => {
  // 640 ⚡ is none of the module's constants and its 5% (32) is not either, so a
  // mutant reaching for a constant instead of the configured value cannot pass.
  const BASE = 640;

  it('a chat-completion charges NOTHING — the seeded override, no config argument', () => {
    const r = computeBlockAuthorFee({
      baseGenerationBuzz: BASE,
      generationType: 'chat-completion',
    });
    expect(r.feeBuzz).toBe(0);
    expect(r.flatLegBuzz).toBe(0);
    expect(r.pctLegBuzz).toBe(0);
    expect(r.governingLeg).toBe('none');
    expect(r.source).toBe('type');
    expect(r.coarseType).toBe('chat-completion');
  });

  it('…while a SAME-BASE generation of another type pays the default 5%', () => {
    // 5% of 640 = 32. Same base, different type, different answer — which is the
    // whole point of the per-type axis being live.
    const r = computeBlockAuthorFee({ baseGenerationBuzz: BASE, generationType: 'convert-image' });
    expect(r.feeBuzz).toBe(32);
    expect(r.pctLegBuzz).toBe(32);
    expect(r.flatLegBuzz).toBe(1);
    expect(r.governingLeg).toBe('pct');
    expect(r.source).toBe('default');
  });

  it('…and an image generation at the same base pays the same default 32 ⚡', () => {
    const r = computeBlockAuthorFee({
      baseGenerationBuzz: BASE,
      generationType: 'textToImage:img2img',
    });
    expect(r.feeBuzz).toBe(32);
    expect(r.source).toBe('default');
  });

  it('the chat-completion zero is the OVERRIDE, not a zero base — a cheap image still pays', () => {
    // 7 ⚡ base: the flat leg governs everywhere the override does not apply.
    expect(
      computeBlockAuthorFee({ baseGenerationBuzz: 7, generationType: 'chat-completion' }).feeBuzz
    ).toBe(0);
    expect(
      computeBlockAuthorFee({ baseGenerationBuzz: 7, generationType: 'textToImage' }).feeBuzz
    ).toBe(1);
  });

  it('`source` is genuinely VARIABLE in production — both arms are reachable', () => {
    // The property item 4's log-field decision rests on: with an empty `byType`
    // this was a compile-time constant 'default'.
    const sources = new Set(
      (['chat-completion', 'convert-image', 'textToImage:txt2img', null] as const).map(
        (t) => computeBlockAuthorFee({ baseGenerationBuzz: BASE, generationType: t }).source
      )
    );
    expect([...sources].sort()).toEqual(['default', 'type']);
  });

  it('`clamped` is NOT variable in production — every platform leg is inside the ceiling', () => {
    // INVARIANT GUARD, and the evidence for DROPPING `authorFeeParamsClamped`
    // from the Axiom line: no input to the production config can set it.
    for (const t of ['chat-completion', 'convert-image', 'textToImage:img2img', null]) {
      for (const base of [0, 7, 20, BASE, 4000]) {
        expect(computeBlockAuthorFee({ baseGenerationBuzz: base, generationType: t }).clamped).toBe(
          false
        );
      }
    }
  });
});

describe('author fee — which leg governs', () => {
  it('FLAT governs when the percentage leg rounds below it', () => {
    // 5% of 7 = 0.35 -> floors to 0; flat 1 wins.
    const r = computeBlockAuthorFee({
      baseGenerationBuzz: 7,
      generationType: 'textToImage:txt2img',
    });
    expect(r.pctLegBuzz).toBe(0);
    expect(r.flatLegBuzz).toBe(1);
    expect(r.feeBuzz).toBe(1);
    expect(r.governingLeg).toBe('flat');
  });

  it('FLAT governs at a configured value that is none of the module constants', () => {
    // 2% of 7 = 0.14 -> 0; flat 3 wins.
    const r = computeBlockAuthorFee({
      baseGenerationBuzz: 7,
      generationType: 'textToImage:txt2img',
      config: DISTINCT,
    });
    expect(r.feeBuzz).toBe(3);
    expect(r.governingLeg).toBe('flat');
  });

  it('PERCENT governs once 5% of base clears the flat leg', () => {
    // 5% of 137 = 6.85 -> floors to 6; flat 1 loses.
    const r = computeBlockAuthorFee({
      baseGenerationBuzz: 137,
      generationType: 'textToImage:img2img',
    });
    expect(r.pctLegBuzz).toBe(6);
    expect(r.flatLegBuzz).toBe(1);
    expect(r.feeBuzz).toBe(6);
    expect(r.governingLeg).toBe('pct');
  });

  it('the percentage leg FLOORS — it never rounds up onto the viewer', () => {
    // 5% of 139 = 6.95. A ceil/round would give 7.
    expect(
      computeBlockAuthorFee({ baseGenerationBuzz: 139, generationType: 'textToImage' }).feeBuzz
    ).toBe(6);
  });

  it('CROSSOVER: 5% × 20 ⚡ is exactly 1 ⚡, and the tie is broken toward flat', () => {
    const r = computeBlockAuthorFee({ baseGenerationBuzz: 20, generationType: 'textToImage' });
    expect(r.pctLegBuzz).toBe(1);
    expect(r.flatLegBuzz).toBe(1);
    expect(r.feeBuzz).toBe(1);
    expect(r.governingLeg).toBe('flat');
  });

  it('one ⚡ below the crossover the flat leg is still what pays', () => {
    // 5% of 19 = 0.95 -> 0.
    const r = computeBlockAuthorFee({ baseGenerationBuzz: 19, generationType: 'textToImage' });
    expect(r.pctLegBuzz).toBe(0);
    expect(r.feeBuzz).toBe(1);
  });

  it('feeBuzz is always max(flatLeg, pctLeg) — on every branch', () => {
    // INVARIANT GUARD: pins the shape of the result object, not a behaviour this
    // change introduced. It exists so the zero-base branch cannot quietly report
    // a flat leg it did not charge.
    for (const base of [0, 1, 19, 20, 137, 4000]) {
      const r = computeBlockAuthorFee({ baseGenerationBuzz: base, generationType: 'textToImage' });
      expect(r.feeBuzz).toBe(Math.max(r.flatLegBuzz, r.pctLegBuzz));
    }
  });
});

describe('author fee — zero base mints nothing', () => {
  it('a ZERO base produces a ZERO fee, even though the flat leg is 1', () => {
    // max(1, 5% × 0) would be 1. It must not be.
    const r = computeBlockAuthorFee({ baseGenerationBuzz: 0, generationType: 'textToImage' });
    expect(r.feeBuzz).toBe(0);
    expect(r.flatLegBuzz).toBe(0);
    expect(r.pctLegBuzz).toBe(0);
    expect(r.governingLeg).toBe('none');
    expect(r.baseGenerationBuzz).toBe(0);
  });

  it('a zero base beats even a large configured flat leg', () => {
    expect(
      computeBlockAuthorFee({
        baseGenerationBuzz: 0,
        generationType: 'chat-completion',
        config: { default: { flatBuzz: 64, pctOfBase: 0.25 } },
      }).feeBuzz
    ).toBe(0);
  });

  it('a negative, NaN, or non-numeric base is treated as a zero base', () => {
    for (const base of [-42, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, '20']) {
      expect(
        computeBlockAuthorFee({ baseGenerationBuzz: base, generationType: 'textToImage' })
      ).toMatchObject({ feeBuzz: 0, governingLeg: 'none' });
    }
  });

  it('a fractional base floors before the percentage is taken', () => {
    // floor(20.9) = 20 -> 5% = 1 exactly, not floor(5% of 20.9) = 1 by luck.
    const r = computeBlockAuthorFee({ baseGenerationBuzz: 20.9, generationType: 'textToImage' });
    expect(r.baseGenerationBuzz).toBe(20);
    expect(r.pctLegBuzz).toBe(1);
  });
});

describe('author fee — both legs at 0', () => {
  it('a 0/0 configuration charges nothing on a large base', () => {
    const r = computeBlockAuthorFee({
      baseGenerationBuzz: 4000,
      generationType: 'textToImage',
      config: { default: { flatBuzz: 0, pctOfBase: 0 } },
    });
    expect(r.feeBuzz).toBe(0);
    expect(r.governingLeg).toBe('none');
    expect(r.clamped).toBe(false);
  });
});

describe('author fee — the platform ceiling', () => {
  it('clamps the FLAT leg to 100 ⚡ and reports the clamp', () => {
    const r = computeBlockAuthorFee({
      baseGenerationBuzz: 7,
      generationType: 'textToImage',
      config: { default: { flatBuzz: 250, pctOfBase: 0.05 } },
    });
    expect(r.flatLegBuzz).toBe(100);
    expect(r.feeBuzz).toBe(100);
    expect(r.clamped).toBe(true);
  });

  it('clamps the PERCENT leg to 100% of base and reports the clamp', () => {
    // 350% of 640 would be 2240. Clamped to 100% it is exactly the base.
    const r = computeBlockAuthorFee({
      baseGenerationBuzz: 640,
      generationType: 'textToImage',
      config: { default: { flatBuzz: 0, pctOfBase: 3.5 } },
    });
    expect(r.pctLegBuzz).toBe(640);
    expect(r.feeBuzz).toBe(640);
    expect(r.clamped).toBe(true);
  });

  it('a negative leg collapses to 0 and counts as clamped', () => {
    expect(clampBlockAuthorFeeParams({ flatBuzz: -9, pctOfBase: -0.3 })).toEqual({
      flatBuzz: 0,
      pctBasisPoints: 0,
      clamped: true,
    });
  });

  it('a non-finite leg collapses to 0 and counts as clamped', () => {
    expect(clampBlockAuthorFeeParams({ flatBuzz: Number.NaN, pctOfBase: 0.05 }).flatBuzz).toBe(0);
    expect(clampBlockAuthorFeeParams({ flatBuzz: Number.NaN, pctOfBase: 0.05 }).clamped).toBe(true);
  });

  it('a value AT the ceiling is not reported as clamped', () => {
    expect(clampBlockAuthorFeeParams({ flatBuzz: 100, pctOfBase: 1 })).toEqual({
      flatBuzz: 100,
      pctBasisPoints: 10_000,
      clamped: false,
    });
  });

  it('quantizes the percentage to basis points without calling that a clamp', () => {
    expect(clampBlockAuthorFeeParams({ flatBuzz: 1, pctOfBase: 0.050004 })).toEqual({
      flatBuzz: 1,
      pctBasisPoints: 500,
      clamped: false,
    });
  });

  it('QUANTIZATION FLOORS — a stated 4.9999% never becomes a charged 5%', () => {
    // `Math.round` gave 500 bp here, i.e. a full 5%, contradicting the module's
    // own "a stated 5% never charges more than 5%". 499 bp is the exact answer.
    expect(clampBlockAuthorFeeParams({ flatBuzz: 0, pctOfBase: 0.049999 }).pctBasisPoints).toBe(
      499
    );
    // …and it reaches the fee: 499 bp of 10,000 ⚡ is 499, not 500.
    expect(
      computeBlockAuthorFee({
        baseGenerationBuzz: 10_000,
        generationType: 'textToImage',
        config: { default: { flatBuzz: 0, pctOfBase: 0.049999 } },
      }).feeBuzz
    ).toBe(499);
  });

  it('flooring does NOT cost a basis point on an exactly-stated percentage', () => {
    // The trap a naive `Math.floor(pct * 10_000)` walks into: 0.0029 is not
    // exactly representable, so the product lands just below 29 and floors to 28.
    // An author typing 0.29% must be charged 0.29%, not 0.28%.
    expect(clampBlockAuthorFeeParams({ flatBuzz: 0, pctOfBase: 0.0029 }).pctBasisPoints).toBe(29);
    expect(clampBlockAuthorFeeParams({ flatBuzz: 0, pctOfBase: 0.0093 }).pctBasisPoints).toBe(93);
    expect(clampBlockAuthorFeeParams({ flatBuzz: 0, pctOfBase: 0.0113 }).pctBasisPoints).toBe(113);
    // Exhaustive over every exact basis point in range — the measurement the
    // `toBasisPoints` docblock quotes (573 of 10,001 wrong under a naive floor).
    for (let bp = 0; bp <= 10_000; bp++) {
      expect(clampBlockAuthorFeeParams({ flatBuzz: 0, pctOfBase: bp / 10_000 })).toEqual({
        flatBuzz: 0,
        pctBasisPoints: bp,
        clamped: false,
      });
    }
  });
});

describe('author fee — per-generation-type lookup', () => {
  const CONFIG: BlockAuthorFeeConfig = {
    default: { flatBuzz: 1, pctOfBase: 0.05 },
    byType: [
      ['chat-completion', { flatBuzz: 0, pctOfBase: 0 }],
      ['textToImage', { flatBuzz: 2, pctOfBase: 0.1 }],
      ['textToImage:img2img', { flatBuzz: 7, pctOfBase: 0.2 }],
    ],
  };

  it("an override to 0 on one type charges nothing there — Justin's chat-completions case", () => {
    const r = computeBlockAuthorFee({
      baseGenerationBuzz: 800,
      generationType: 'chat-completion',
      config: CONFIG,
    });
    expect(r.feeBuzz).toBe(0);
    expect(r.governingLeg).toBe('none');
  });

  it('…while every other type still pays the default', () => {
    // 5% of 800 = 40.
    const r = computeBlockAuthorFee({
      baseGenerationBuzz: 800,
      generationType: 'convert-image',
      config: CONFIG,
    });
    expect(r.feeBuzz).toBe(40);
    expect(r.source).toBe('default');
  });

  it('the FULL type beats the COARSE key when both are configured', () => {
    // 20% of 800 = 160, from the textToImage:img2img entry — not 10% (coarse) = 80.
    const r = computeBlockAuthorFee({
      baseGenerationBuzz: 800,
      generationType: 'textToImage:img2img',
      config: CONFIG,
    });
    expect(r.feeBuzz).toBe(160);
    expect(r.source).toBe('type');
    expect(r.coarseType).toBe('textToImage');
  });

  it('a sibling subtype with no full-type entry falls back to the COARSE key', () => {
    // 10% of 800 = 80, from the bare textToImage entry.
    const r = computeBlockAuthorFee({
      baseGenerationBuzz: 800,
      generationType: 'textToImage:txt2img',
      config: CONFIG,
    });
    expect(r.feeBuzz).toBe(80);
    expect(r.source).toBe('coarse');
    expect(r.coarseType).toBe('textToImage');
  });

  it('a bare coarse value matches its own entry and reports it as a full-type hit', () => {
    const r = resolveBlockAuthorFeeParams(CONFIG, 'textToImage');
    expect(r.params).toEqual({ flatBuzz: 2, pctOfBase: 0.1 });
    expect(r.source).toBe('type');
  });

  it('a coarse key with no entry at all falls through to the default', () => {
    const r = resolveBlockAuthorFeeParams(CONFIG, 'customComfy:inline');
    expect(r.source).toBe('default');
    expect(r.coarseType).toBe('customComfy');
  });
});

describe('author fee — an unresolvable generation type', () => {
  const CONFIG: BlockAuthorFeeConfig = {
    default: { flatBuzz: 1, pctOfBase: 0.05 },
    byType: [['textToImage', { flatBuzz: 2, pctOfBase: 0.1 }]],
  };

  it('NULL resolves to the default parameters, and to a null coarse key', () => {
    // 5% of 800 = 40 (the default), not 80 (the textToImage override).
    const r = computeBlockAuthorFee({
      baseGenerationBuzz: 800,
      generationType: null,
      config: CONFIG,
    });
    expect(r.feeBuzz).toBe(40);
    expect(r.source).toBe('default');
    expect(r.coarseType).toBeNull();
  });

  it('a string that is not a generation type resolves to the default, never to an override', () => {
    for (const bogus of ['videoToVideo', 'textToImage:nope', 'textToImage:', 'TEXTTOIMAGE', '']) {
      const r = resolveBlockAuthorFeeParams(CONFIG, bogus);
      expect(r.source).toBe('default');
      expect(r.coarseType).toBeNull();
    }
  });

  it('a prototype key cannot reach an override — the key is bounded before lookup', () => {
    // INVARIANT GUARD. `isBlockGenerationType` already refuses these, so this can
    // never have failed; it is written to record WHY no prototype-key guard is
    // coded in the resolver (an unreachable guard would read as coverage while
    // providing none), not to claim coverage of its own.
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(resolveBlockAuthorFeeParams(CONFIG, key).source).toBe('default');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The DARK GATE. `observeBlockAuthorFee` is the only production entry point, and
// with the flag off the computation must be unreachable and emit NOTHING.
// ─────────────────────────────────────────────────────────────────────────────

const { mockIsFlipt, mockObserved, mockFeeBuzz, mockBaseBuzz } = vi.hoisted(() => ({
  mockIsFlipt: vi.fn(),
  mockObserved: vi.fn(),
  mockFeeBuzz: vi.fn(),
  mockBaseBuzz: vi.fn(),
}));

vi.mock('~/server/flipt/client', () => ({ isFlipt: mockIsFlipt }));
vi.mock('~/server/prom/client', () => ({
  blockAuthorFeeObservedCounter: { inc: mockObserved },
  blockAuthorFeeBuzzCounter: { inc: mockFeeBuzz },
  blockAuthorFeeBaseBuzzCounter: { inc: mockBaseBuzz },
}));

// `observeBlockAuthorFee`'s dependencies are ordinary STATIC imports; what makes
// the mocks above take effect is `vi.mock` hoisting, not this import's position.
// (An earlier revision of this comment said "the dynamic imports inside
// `observeBlockAuthorFee` resolve to them" — there are none; the same claim was
// already deleted from the module's own docblock.)
import { observeBlockAuthorFee } from '../author-fee';
import { APP_BLOCKS_AUTHOR_FEE_FLAG } from '~/server/services/app-blocks-flag';

beforeEach(() => {
  mockIsFlipt.mockReset();
  mockObserved.mockReset();
  mockFeeBuzz.mockReset();
  mockBaseBuzz.mockReset();
});

describe('observeBlockAuthorFee — fail-closed dark gate', () => {
  it('reads the dedicated author-fee flag key, globally', async () => {
    expect(APP_BLOCKS_AUTHOR_FEE_FLAG).toBe('app-blocks-author-fee-enabled');
    mockIsFlipt.mockResolvedValue(true);
    await observeBlockAuthorFee({ baseGenerationBuzz: 137, generationType: 'textToImage' });
    expect(mockIsFlipt).toHaveBeenCalledWith('app-blocks-author-fee-enabled');
    expect(mockIsFlipt).toHaveBeenCalledTimes(1);
  });

  it('with the flag OFF: no computation reaches any signal, and the skip is named', async () => {
    mockIsFlipt.mockResolvedValue(false);
    const r = await observeBlockAuthorFee({
      baseGenerationBuzz: 137,
      generationType: 'textToImage',
    });
    expect(r).toEqual({ observed: false, reason: 'flag-disabled' });
    // ⚠️ WHAT THIS PINS, EXACTLY: that NOTHING IS EMITTED on the disabled path —
    // not even the skip counter. It does NOT pin the gate's POSITION. An earlier
    // revision of this comment claimed "a gate moved below the computation would
    // show up right here", and that was false: `computeBlockAuthorFee` is pure,
    // so a copy of it hoisted above the flag read emits nothing either and every
    // assertion below stays green (measured at 92646e0: this file +
    // spend-attribution.service.test.ts, 84/84, mutant SURVIVED).
    // The ordering guard is the next test.
    expect(mockObserved).not.toHaveBeenCalled();
    expect(mockFeeBuzz).not.toHaveBeenCalled();
    expect(mockBaseBuzz).not.toHaveBeenCalled();
  });

  it('with the flag OFF it does not touch its own ARGUMENTS — the gate really is first', async () => {
    // 🔴 THE ORDERING GUARD. The emptiness of the counters cannot see a hoisted
    // PURE computation, so observe the one thing any invocation of
    // `computeBlockAuthorFee` must do regardless of purity: READ ITS INPUTS.
    // `generationType` and `config` are read nowhere in `observeBlockAuthorFee`
    // except inside the `computeBlockAuthorFee(...)` call, so a read with the
    // flag off means the computation ran before the gate.
    //
    // Slice 1's computation is pure, so this is cheap insurance; slice 2 replaces
    // it with code that moves money, and then this is the guard that matters.
    let generationTypeReads = 0;
    let configReads = 0;
    const probe = {
      baseGenerationBuzz: 137,
      get generationType() {
        generationTypeReads++;
        return 'textToImage';
      },
      get config() {
        configReads++;
        return undefined;
      },
    };

    mockIsFlipt.mockResolvedValue(false);
    await observeBlockAuthorFee(probe);
    expect(
      generationTypeReads,
      'flag OFF: `generationType` was read, so the fee computation ran BEFORE the gate'
    ).toBe(0);
    expect(
      configReads,
      'flag OFF: `config` was read, so the fee computation ran BEFORE the gate'
    ).toBe(0);

    // POSITIVE CONTROL, in the same test: the probe CAN observe the reads, so the
    // two zeros above are a fact about the gate and not about a getter wired to
    // nothing.
    mockIsFlipt.mockResolvedValue(true);
    await observeBlockAuthorFee(probe);
    // The control proper is the ZERO case — it says only that the getters CAN
    // fire, which is what licenses reading the two zeros above as a fact about
    // the gate. It is asserted separately from exactness on purpose: this
    // message used to sit on a `toBe(1)`, so an over-read (2) failed with
    // "probe wired to nothing — flag ON read nothing: expected 2 to be 1",
    // naming the one cause the number rules out and sending the reader into the
    // probe when the change is downstream of the gate.
    expect(generationTypeReads, 'probe wired to nothing — flag ON read nothing').toBeGreaterThan(0);
    expect(configReads, 'probe wired to nothing — flag ON read nothing').toBeGreaterThan(0);

    // Exactness is its own claim, with its own cause: each argument is read
    // exactly once past the gate. A second read is not a probe failure.
    expect(
      generationTypeReads,
      '`generationType` was read more than once past the gate — a change downstream of the flag, not a broken probe'
    ).toBe(1);
    expect(
      configReads,
      '`config` was read more than once past the gate — a change downstream of the flag, not a broken probe'
    ).toBe(1);
  });

  it('a flag read that REJECTS is treated as off, never as on', async () => {
    mockIsFlipt.mockRejectedValue(new Error('flipt unreachable'));
    await expect(
      observeBlockAuthorFee({ baseGenerationBuzz: 137, generationType: 'textToImage' })
    ).resolves.toEqual({ observed: false, reason: 'flag-disabled' });
    expect(mockFeeBuzz).not.toHaveBeenCalled();
  });

  it('with the flag ON: computes, and reports fee + base to the counters', async () => {
    mockIsFlipt.mockResolvedValue(true);
    const r = await observeBlockAuthorFee({
      baseGenerationBuzz: 137,
      generationType: 'textToImage:img2img',
    });
    expect(r).toMatchObject({ observed: true });
    if (!r.observed) throw new Error('unreachable');
    expect(r.computation.feeBuzz).toBe(6);
    expect(mockObserved).toHaveBeenCalledWith({ coarse_type: 'textToImage', outcome: 'pct' });
    expect(mockFeeBuzz).toHaveBeenCalledWith({ coarse_type: 'textToImage' }, 6);
    expect(mockBaseBuzz).toHaveBeenCalledWith({ coarse_type: 'textToImage' }, 137);
  });

  it('labels an unresolvable generation type `unknown` rather than dropping the sample', async () => {
    mockIsFlipt.mockResolvedValue(true);
    await observeBlockAuthorFee({ baseGenerationBuzz: 137, generationType: null });
    expect(mockObserved).toHaveBeenCalledWith({ coarse_type: 'unknown', outcome: 'pct' });
    expect(mockFeeBuzz).toHaveBeenCalledWith({ coarse_type: 'unknown' }, 6);
  });

  it('an ABSENT base is its own counted skip — never folded into the zero-base bucket', async () => {
    mockIsFlipt.mockResolvedValue(true);
    const r = await observeBlockAuthorFee({
      baseGenerationBuzz: null,
      generationType: 'textToImage',
    });
    expect(r).toEqual({ observed: false, reason: 'base-unavailable' });
    // ONE SPELLING across both instruments: the counter's `outcome` label is the
    // same string as the log line's `authorFeeSkipped`, so a sizing read can join
    // them. It used to be `base_unavailable` here and `base-unavailable` there.
    expect(mockObserved).toHaveBeenCalledWith({
      coarse_type: 'unknown',
      outcome: 'base-unavailable',
    });
    // The money counters must stay untouched, or the sizing read gains a
    // phantom zero-fee sample for a generation the fee never saw.
    expect(mockFeeBuzz).not.toHaveBeenCalled();
    expect(mockBaseBuzz).not.toHaveBeenCalled();
  });

  it('a CAP price charges NOTHING — its own named skip, on a base that WOULD have paid', async () => {
    // 🔴 THE CAP GUARD, ON AN INPUT NO EARLIER CHECK REJECTS. Flag ON (past the
    // dark gate), base 640 — the SAME base the `convert-image` case two tests
    // down pays 32 ⚡ on. So the only thing standing between this generation and
    // a 32 ⚡ fee is the cap branch; delete that branch and this is a 32 ⚡
    // observation, not a skip, and this assertion is what says so.
    //
    // WHY NO FEE: `WorkflowCost.variable` means the quoted price is a ceiling
    // that settles lower — the viewer is charged the maximum up front and
    // refunded the difference. A percentage of that is a fee on money they did
    // not ultimately spend.
    mockIsFlipt.mockResolvedValue(true);
    const r = await observeBlockAuthorFee({
      baseGenerationBuzz: 640,
      priceIsCap: true,
      generationType: 'convert-image',
    });
    expect(
      r,
      'a CAP-priced generation must record NO fee — a percentage of a cap charges the viewer for money that gets refunded'
    ).toEqual({ observed: false, reason: 'price-is-cap' });
    // Counted, not silent: how much traffic is cap-priced is a number slice 2
    // needs in order to decide what a cap-priced path should charge.
    expect(mockObserved).toHaveBeenCalledWith({
      coarse_type: 'unknown',
      outcome: 'price-is-cap',
    });
    // 🔴 And NOT in the `base-unavailable` bucket, which is one of the two
    // denominators the slice-2 sizing read divides by. Folding a different cause
    // into it is how that denominator acquires a silent bias.
    expect(mockObserved).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'base-unavailable' })
    );
    // The money counters must stay untouched — a cap-priced generation is not a
    // zero-fee sample, it is a generation the fee declined to price.
    expect(mockFeeBuzz).not.toHaveBeenCalled();
    expect(mockBaseBuzz).not.toHaveBeenCalled();
  });

  it('a cap-priced generation with NO base is `price-is-cap`, not `base-unavailable`', async () => {
    // The ORDER of the two checks, pinned. `base-unavailable` is the RECOVERABLE
    // blind spot — "the fee would have fired if the orchestrator had given us a
    // number" — and a cap-priced job would not have fired either way. Counting
    // it there would overstate exactly the population slice 2 sizes its recovery
    // work against.
    mockIsFlipt.mockResolvedValue(true);
    const r = await observeBlockAuthorFee({
      baseGenerationBuzz: null,
      priceIsCap: true,
      generationType: 'convert-image',
    });
    expect(r).toEqual({ observed: false, reason: 'price-is-cap' });
    expect(mockObserved).toHaveBeenCalledWith({
      coarse_type: 'unknown',
      outcome: 'price-is-cap',
    });
    expect(mockObserved).toHaveBeenCalledTimes(1);
  });

  it('the CAP branch is FAIL-CLOSED-to-charging only on an explicit `true`', async () => {
    // The negative arm — without it, a mutant widening the test to any truthy
    // value (or to `!== false`) would survive, and every ordinary generation
    // would silently stop being priced. `undefined`/`null`/`false` all mean "the
    // price is final", which is the majority of traffic.
    mockIsFlipt.mockResolvedValue(true);
    for (const priceIsCap of [undefined, null, false] as const) {
      mockObserved.mockClear();
      const r = await observeBlockAuthorFee({
        baseGenerationBuzz: 640,
        priceIsCap,
        generationType: 'convert-image',
      });
      expect(r, `priceIsCap=${String(priceIsCap)} must still be priced`).toMatchObject({
        observed: true,
      });
      if (!r.observed) throw new Error('unreachable');
      expect(r.computation.feeBuzz).toBe(32);
      expect(mockObserved).toHaveBeenCalledWith({ coarse_type: 'convert-image', outcome: 'pct' });
    }
  });

  it('the CAP skip is still behind the dark gate — flag OFF emits nothing at all', async () => {
    // Ordering: the flag is read FIRST. A cap-priced generation with the flag off
    // is a `flag-disabled` skip and emits no counter, exactly like every other.
    mockIsFlipt.mockResolvedValue(false);
    const r = await observeBlockAuthorFee({
      baseGenerationBuzz: 640,
      priceIsCap: true,
      generationType: 'convert-image',
    });
    expect(r).toEqual({ observed: false, reason: 'flag-disabled' });
    expect(mockObserved).not.toHaveBeenCalled();
  });

  it('a genuine ZERO base IS observed, and lands in the `none` bucket', async () => {
    mockIsFlipt.mockResolvedValue(true);
    const r = await observeBlockAuthorFee({ baseGenerationBuzz: 0, generationType: 'textToImage' });
    expect(r).toMatchObject({ observed: true });
    expect(mockObserved).toHaveBeenCalledWith({ coarse_type: 'textToImage', outcome: 'none' });
    expect(mockFeeBuzz).toHaveBeenCalledWith({ coarse_type: 'textToImage' }, 0);
  });

  it('a chat-completion reaches the counters as an OBSERVED zero, not as a skip', async () => {
    // End-to-end through the production entry point with NO config override: the
    // seeded platform table must be what answers. A zero-fee generation is still
    // a generation the fee SAW — it lands in the `none` bucket and contributes a
    // base to the denominator, which is how the sizing read can tell "charged
    // nothing" apart from "never looked".
    mockIsFlipt.mockResolvedValue(true);
    const r = await observeBlockAuthorFee({
      baseGenerationBuzz: 640,
      generationType: 'chat-completion',
    });
    expect(r).toMatchObject({ observed: true });
    if (!r.observed) throw new Error('unreachable');
    expect(r.computation.feeBuzz).toBe(0);
    expect(r.computation.source).toBe('type');
    expect(mockObserved).toHaveBeenCalledWith({
      coarse_type: 'chat-completion',
      outcome: 'none',
    });
    expect(mockFeeBuzz).toHaveBeenCalledWith({ coarse_type: 'chat-completion' }, 0);
    expect(mockBaseBuzz).toHaveBeenCalledWith({ coarse_type: 'chat-completion' }, 640);
  });

  it('a same-base convert-image reaches the counters with the default 32 ⚡', async () => {
    mockIsFlipt.mockResolvedValue(true);
    const r = await observeBlockAuthorFee({
      baseGenerationBuzz: 640,
      generationType: 'convert-image',
    });
    expect(r).toMatchObject({ observed: true });
    if (!r.observed) throw new Error('unreachable');
    expect(r.computation.feeBuzz).toBe(32);
    expect(r.computation.source).toBe('default');
    expect(mockFeeBuzz).toHaveBeenCalledWith({ coarse_type: 'convert-image' }, 32);
  });

  it('a throwing counter never propagates to the caller', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockObserved.mockImplementation(() => {
      throw new Error('registry exploded');
    });
    await expect(
      observeBlockAuthorFee({ baseGenerationBuzz: 137, generationType: 'textToImage' })
    ).resolves.toMatchObject({ observed: true });
  });
});

/**
 * `describeBlockAuthorFee` — what a VIEWER-FACING surface may say about the
 * configuration.
 *
 * NEW-FEATURE coverage, stated honestly: this function did not exist at
 * `origin/main`, so nothing here was red there except the import. What these
 * pin is the PROJECTION property — the disclosure must be derived from the same
 * constant the charge is computed from, and must refuse to be described by one
 * figure in exactly the cases where one figure would be false. The red-at-base
 * regression for this change lives in
 * `src/server/routers/__tests__/blocks.router.workflow.test.ts`.
 */
describe('describeBlockAuthorFee', () => {
  it('reports the platform default pair as production resolves it', () => {
    // No `config` argument — this reads BLOCK_AUTHOR_FEE_PLATFORM_CONFIG itself,
    // so it is a claim about what ships, not about a fixture.
    const fee = describeBlockAuthorFee();
    expect(fee.flatBuzz).toBe(BLOCK_AUTHOR_FEE_DEFAULT_FLAT_BUZZ);
    expect(fee.pctBasisPoints).toBe(BLOCK_AUTHOR_FEE_DEFAULT_PCT_OF_BASE * 10_000);
    expect(fee.chargesAnything).toBe(true);
  });

  it('🔴 the shipped config is describable by ONE figure', () => {
    // The live posture the consent screen depends on: every override is
    // fee-FREE, so "at most flat or pct%" genuinely bounds every generation
    // type. The day an override charges above the default this goes red, which
    // is the point — the screen must switch to the figure-free wording rather
    // than keep rendering a number that has stopped being true.
    const fee = describeBlockAuthorFee();
    expect(fee.chargingOverrideTypes).toEqual([]);
    expect(fee.feeFreeTypes).toEqual(['chat-completion']);
  });

  it('classifies an override that prices ABOVE the default as CHARGING', () => {
    const fee = describeBlockAuthorFee({
      default: { flatBuzz: 1, pctOfBase: 0.05 },
      byType: [
        ['chat-completion', { flatBuzz: 0, pctOfBase: 0 }],
        ['customComfy', { flatBuzz: 9, pctOfBase: 0.2 }],
      ],
    });
    expect(fee.feeFreeTypes).toEqual(['chat-completion']);
    expect(fee.chargingOverrideTypes).toEqual(['customComfy']);
  });

  it('an override with ONE non-zero leg is charging, not fee-free', () => {
    // 🔴 THE `&&` THIS KILLS. A classifier written with `||` would file a
    // `{ flat: 0, pct: 0.2 }` override as fee-FREE and then let the screen claim
    // the default bounds it. The two fixtures differ in WHICH leg is set so a
    // mutant that only inspects one of them survives neither.
    const flatOnly = describeBlockAuthorFee({
      default: { flatBuzz: 1, pctOfBase: 0.05 },
      byType: [['customComfy', { flatBuzz: 3, pctOfBase: 0 }]],
    });
    const pctOnly = describeBlockAuthorFee({
      default: { flatBuzz: 1, pctOfBase: 0.05 },
      byType: [['customComfy', { flatBuzz: 0, pctOfBase: 0.2 }]],
    });
    expect(flatOnly.chargingOverrideTypes).toEqual(['customComfy']);
    expect(pctOnly.chargingOverrideTypes).toEqual(['customComfy']);
  });

  it('a config that charges NOTHING anywhere reports `chargesAnything: false`', () => {
    // The suppression case: a screen must not say "this app charges a fee" when
    // no configured type can produce one.
    const fee = describeBlockAuthorFee({
      default: { flatBuzz: 0, pctOfBase: 0 },
      byType: [['chat-completion', { flatBuzz: 0, pctOfBase: 0 }]],
    });
    expect(fee.chargesAnything).toBe(false);
  });

  it('a zero DEFAULT still charges when an override does', () => {
    // `chargesAnything` is the union over the whole config, not a property of
    // `default` alone — a mutant reading only the default answers `false` here
    // and suppresses a disclosure for an app that really does charge.
    const fee = describeBlockAuthorFee({
      default: { flatBuzz: 0, pctOfBase: 0 },
      byType: [['customComfy', { flatBuzz: 4, pctOfBase: 0 }]],
    });
    expect(fee.chargesAnything).toBe(true);
  });

  it('CLAMPS before classifying, so an unusable leg is fee-free not charging', () => {
    // `computeBlockAuthorFee` clamps first and a non-finite leg collapses to 0
    // there, so such an override charges nothing. A classifier that read the raw
    // params would call `NaN > 0` false for the flat leg but would file a
    // negative percentage as charging — either way the disclosure and the
    // computation would disagree about what "prices nothing" means.
    const fee = describeBlockAuthorFee({
      default: { flatBuzz: 1, pctOfBase: 0.05 },
      byType: [['customComfy', { flatBuzz: Number.NaN, pctOfBase: -3 }]],
    });
    expect(fee.chargingOverrideTypes).toEqual([]);
    expect(fee.feeFreeTypes).toEqual(['customComfy']);
  });

  it('CLAMPS the reported default to the platform ceilings', () => {
    // A future per-app config is author input; the figure a consent screen
    // renders must be the one the platform will actually honour, not the one an
    // author asked for.
    const fee = describeBlockAuthorFee({
      default: { flatBuzz: 10_000, pctOfBase: 5 },
      byType: [],
    });
    expect(fee.flatBuzz).toBe(BLOCK_AUTHOR_FEE_MAX_FLAT_BUZZ);
    expect(fee.pctBasisPoints).toBe(BLOCK_AUTHOR_FEE_MAX_PCT_BASIS_POINTS);
  });

  it('is IDEMPOTENT across calls', () => {
    // ⚠️ RETITLED, BECAUSE THE OLD NAME ("is PURE — it reads no flag") CLAIMED
    // COVERAGE IT DID NOT PROVIDE. Nothing here manipulates a flag or varies an
    // argument, and a mutation making the function genuinely impure (a
    // module-level counter changing its answer) left THIS test green while five
    // others killed it. There is no mutation it uniquely catches.
    //
    // The purity property is real and is enforced STRUCTURALLY instead: this
    // function is SYNC and `isAppBlocksAuthorFeeEnabled` is ASYNC, so a flag read
    // cannot compile into it. That is a stronger guarantee than a test, and it is
    // why no test is written for it.
    const before = describeBlockAuthorFee();
    expect(describeBlockAuthorFee()).toEqual(before);
  });
});
