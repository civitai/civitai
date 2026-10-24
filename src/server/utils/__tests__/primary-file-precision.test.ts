import { describe, expect, it } from 'vitest';
import { defaultFilePreferences, getPrimaryFile } from '~/server/utils/model-helpers';

/**
 * These pin the serving order and, more importantly, pin that it only ever applies to a tie: a
 * reverted tie-break has to fail by naming a precision, not pass because the fixture happened to be
 * in the right order.
 */

const weights = (fp: ModelFileFp, name = fp) => ({
  name,
  type: 'Model' as const,
  metadata: { format: 'SafeTensor' as const, fp },
});

/** So no assertion can be satisfied by input order alone. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
  );
}

describe('getPrimaryFile settles a precision tie deliberately', () => {
  it('serves fp8 over the other precisions whatever order the rows arrive in', () => {
    const files = [weights('bf16'), weights('int8'), weights('fp8'), weights('int4')];
    const picked = permutations(files).map((order) => getPrimaryFile(order)?.name);
    expect(new Set(picked)).toEqual(new Set(['fp8']));
  });

  it('ranks the precisions in the agreed order', () => {
    // Pairwise rather than one sort, so a failure names the pair that moved.
    const order: ModelFileFp[] = [
      'fp8',
      'fp8_scaled',
      'fp8_mixed',
      'bf16',
      'fp16',
      'fp32',
      'int8',
      'mxfp8',
      'nvfp4',
      'nf4',
      'int4',
    ];
    // fp16 is the default preference, so pairs involving it are not ties — exclude it here and
    // cover it under an explicit preference below.
    const tieable = order.filter((fp) => fp !== 'fp16');
    for (let i = 0; i < tieable.length; i++) {
      for (let j = i + 1; j < tieable.length; j++) {
        const [better, worse] = [tieable[i], tieable[j]];
        expect(
          getPrimaryFile([weights(worse), weights(better)])?.name,
          `${better} should be served over ${worse}`
        ).toBe(better);
      }
    }
  });

  it('does not overturn a preference the caller actually stated', () => {
    const files = [weights('fp8'), weights('bf16')];
    expect(
      getPrimaryFile(files, { metadata: { ...defaultFilePreferences.metadata, fp: 'bf16' } })?.name
    ).toBe('bf16');
    expect(
      getPrimaryFile(files, { metadata: { ...defaultFilePreferences.metadata, fp: 'int8' } })?.name
    ).toBe('fp8');
  });

  it('does not overturn a higher-weighted dimension', () => {
    // A format difference makes the scores unequal, so the tie-break never runs.
    const safetensorBf16 = {
      name: 'safetensor',
      type: 'Model' as const,
      metadata: { format: 'SafeTensor' as const, fp: 'bf16' as const },
    };
    const pickleFp8 = {
      name: 'pickle',
      type: 'Model' as const,
      metadata: { format: 'PickleTensor' as const, fp: 'fp8' as const },
    };
    expect(getPrimaryFile([pickleFp8, safetensorBf16])?.name).toBe('safetensor');
  });

  it('keeps a weight file ahead of a non-weight file that carries a better precision', () => {
    const configFp8 = { name: 'config', type: 'Config' as const, metadata: { fp: 'fp8' as const } };
    const modelInt4 = weights('int4', 'model');
    expect(getPrimaryFile([configFp8, modelInt4])?.name).toBe('model');
  });

  it('is order-independent when one file states no precision at all', () => {
    // Characterization: a file with no `fp` key takes no penalty, so it outscores one whose
    // precision does not match the preference and never reaches the tie-break. Both orders, so the
    // win is attributable to the score rather than to input position.
    const unstated = {
      name: 'unstated',
      type: 'Model' as const,
      metadata: { format: 'SafeTensor' as const },
    };
    const int4 = weights('int4');
    expect(getPrimaryFile([unstated, int4])?.name).toBe('unstated');
    expect(getPrimaryFile([int4, unstated])?.name).toBe('unstated');
  });
});

/**
 * The cases the score cannot reach on its own. Each needs a `quantType` offset to make two files
 * tie while differing in a way `fpServingPreference` has to settle, so the comparator actually runs
 * — without them the guards below are dead weight that a revert leaves green.
 */
describe('getPrimaryFile settles the precisions the score cannot separate', () => {
  /** −0.5 for a non-matching quantType against +0.5 for the preferred one, offsetting `fp`'s ∓1. */
  const noFp = {
    name: 'no-fp',
    type: 'Model' as const,
    metadata: { format: 'SafeTensor' as const, quantType: 'Q8_0' as const },
  };
  const hasFp = {
    name: 'has-fp',
    type: 'Model' as const,
    metadata: { format: 'SafeTensor' as const, fp: 'fp8' as const, quantType: 'Q4_K_M' as const },
  };

  it('prefers a stated precision over none when the scores actually tie', () => {
    // Reaches the `!fpA` / `!fpB` guards. Without them the subtraction is NaN and the engine
    // decides; flipping their sign serves `no-fp` instead.
    expect(getPrimaryFile([noFp, hasFp])?.name).toBe('has-fp');
    expect(getPrimaryFile([hasFp, noFp])?.name).toBe('has-fp');
  });

  it('sorts a precision this build does not know about last', () => {
    // Precision options are mod-managed, so a stored `fp` can be outside `ModelFileFp`. Unranked
    // must lose to a ranked one rather than produce NaN.
    const unknown = {
      ...hasFp,
      name: 'unknown',
      metadata: { ...hasFp.metadata, fp: 'mxfp6' as ModelFileFp },
    };
    const int4 = { ...hasFp, name: 'int4', metadata: { ...hasFp.metadata, fp: 'int4' as const } };
    expect(getPrimaryFile([unknown, int4])?.name).toBe('int4');
    expect(getPrimaryFile([int4, unknown])?.name).toBe('int4');
  });

  it('ranks fp16 where the order says, under a preference that is not fp16', () => {
    // fp16 matches `defaultFilePreferences`, so it only ever reaches the tie-break when the caller
    // asked for something else — which is why the pairwise sweep above excludes it.
    const prefs = { metadata: { ...defaultFilePreferences.metadata, fp: 'int8' as const } };
    expect(getPrimaryFile([weights('fp16'), weights('fp32')], prefs)?.name).toBe('fp16');
    expect(getPrimaryFile([weights('bf16'), weights('fp16')], prefs)?.name).toBe('bf16');
  });
});

/**
 * The AIR guard. `Model`, `Pruned Model`, `Diffusion Model` and `UNet` all score +1000, so a tie can
 * span them, and `fileTypeUrnMap` gives them different AIR type segments — choosing across them
 * would move the AIR string the orchestrator caches by. A revert shows up here as a `Diffusion Model`
 * losing to a `Model`, which is an AIR change, not a byte change.
 */
describe('the precision tie-break never crosses a file type', () => {
  const denoiser = {
    name: 'denoiser',
    type: 'Diffusion Model' as const,
    metadata: { format: 'SafeTensor' as const, fp: 'bf16' as const },
  };
  const checkpoint = {
    name: 'checkpoint',
    type: 'Model' as const,
    metadata: { format: 'SafeTensor' as const, fp: 'fp8' as const },
  };

  it('keeps the incumbent when the better precision is a different type', () => {
    // fp8 outranks bf16, but taking it here would flip the AIR from diffusionmodel to checkpoint.
    expect(getPrimaryFile([denoiser, checkpoint])?.name).toBe('denoiser');
    expect(getPrimaryFile([checkpoint, denoiser])?.name).toBe('checkpoint');
  });

  it('still orders by precision within one type', () => {
    const worse = {
      ...denoiser,
      name: 'int4',
      metadata: { ...denoiser.metadata, fp: 'int4' as const },
    };
    const better = {
      ...denoiser,
      name: 'fp8',
      metadata: { ...denoiser.metadata, fp: 'fp8' as const },
    };
    expect(getPrimaryFile([worse, better])?.name).toBe('fp8');
    expect(getPrimaryFile([better, worse])?.name).toBe('fp8');
  });
});
