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
  BLOCK_AUTHOR_FEE_DEFAULT_FLAT_BUZZ,
  BLOCK_AUTHOR_FEE_DEFAULT_PCT_OF_BASE,
  BLOCK_AUTHOR_FEE_MAX_FLAT_BUZZ,
  BLOCK_AUTHOR_FEE_MAX_PCT_OF_BASE,
  BLOCK_AUTHOR_FEE_PLATFORM_CONFIG,
  clampBlockAuthorFeeParams,
  computeBlockAuthorFee,
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
    expect(generationTypeReads, 'probe wired to nothing — flag ON read nothing').toBe(1);
    expect(configReads, 'probe wired to nothing — flag ON read nothing').toBe(1);
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
