import { describe, expect, it } from 'vitest';
import { ROLE_MODEL_TYPES } from '~/server/schema/resource-intent.schema';
import {
  RESOURCE_INTENT_COOC_SPEC,
  RESOURCE_INTENT_COOC_SPEC_HASH,
} from '~/server/services/resource-intent-cooc/spec';

describe('RESOURCE_INTENT_COOC_SPEC', () => {
  it('is the configuration the screen chose and drew with', () => {
    const { addonTypes, ...rest } = RESOURCE_INTENT_COOC_SPEC;
    expect(rest).toEqual({
      trainDays: 120,
      gapDays: 1,
      targetRows: 200_000,
      idBatch: 20_000,
      maxBatches: 200,
      defaultSeed: 20261008,
      minSup: 2,
      dfMax: 0.05,
      beta: 10,
      topK: 300,
    });
    // The screen's literal ADDON list, which it asserted against ROLE_MODEL_TYPES.
    expect([...addonTypes]).toEqual(
      [
        'LORA',
        'TextualInversion',
        'LoCon',
        'DoRA',
        'AestheticGradient',
        'Hypernetwork',
        'Poses',
        'Upscaler',
        'Controlnet',
        'Detection',
        'CLIPVision',
      ].sort()
    );
    const union = new Set(Object.values(ROLE_MODEL_TYPES).flatMap((t) => t ?? []));
    expect([...addonTypes].sort()).toEqual([...union].sort());
  });

  it('the spec hash is pinned: a change to tokens, counts, scoring or constants must update this literal', () => {
    // Deliberately a literal: snapshots record the hash they were built under, so change it only
    // on purpose.
    expect(RESOURCE_INTENT_COOC_SPEC_HASH).toBe(
      '8a3f0edb99ea5ad81656dfa6b7a20c2d6b7afa89afb69621e1f9d808b2ed8d49'
    );
  });
});
