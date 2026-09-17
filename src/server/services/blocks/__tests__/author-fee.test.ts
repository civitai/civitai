import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Blocks PER-GENERATION AUTHOR FEE — slice 1 (computation + config + dark gate).
 *
 *   fee = max(flatBuzz, pctOfBase × base_generation_buzz)
 *
 * WHAT THIS SUITE IS, STATED HONESTLY. `author-fee.ts` is a NEW module, so every
 * test below is NEW-FEATURE coverage, not regression coverage: none of them
 * could have been red at `origin/main` for any reason except the import failing.
 * The claim that these guards are real is carried by the MUTATION SWEEP recorded
 * in the PR body — each rule below was broken on purpose and the naming test is
 * the one that went red. Two guards here are labelled INVARIANT GUARD where they
 * pin a property the code has always had rather than one this change introduced.
 *
 * The one genuinely red-at-base guard for this change lives in
 * `author-fee.spend-seam.test.ts`, which pins the router call sites.
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

  it('ships NO per-type overrides — the per-type axis is an author setting (slice 3)', () => {
    expect(BLOCK_AUTHOR_FEE_PLATFORM_CONFIG.byType).toEqual([]);
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

// Imported after the mocks so the dynamic imports inside `observeBlockAuthorFee`
// resolve to them.
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
    // The observable consequence of the gate being FIRST: nothing is emitted at
    // all, not even the skip counter. A gate moved below the computation would
    // show up right here.
    expect(mockObserved).not.toHaveBeenCalled();
    expect(mockFeeBuzz).not.toHaveBeenCalled();
    expect(mockBaseBuzz).not.toHaveBeenCalled();
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
    expect(mockObserved).toHaveBeenCalledWith({
      coarse_type: 'unknown',
      outcome: 'base_unavailable',
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
