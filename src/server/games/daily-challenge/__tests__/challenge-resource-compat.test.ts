import { describe, expect, it } from 'vitest';
import {
  findIncompatibleEntries,
  isFeaturedResourceCompatible,
  type EntryResourceRow,
} from '~/server/games/daily-challenge/challenge-resource-compat';
import {
  baseModelRecords,
  ecosystems,
  getEcosystemSupport,
  getGenerationSupport,
} from '~/shared/constants/basemodel.constants';
import type { ModelType } from '~/shared/utils/prisma/enums';

// A Daily Challenge entry qualifies only if the featured resource can run on the entry's checkpoint.

describe('isFeaturedResourceCompatible', () => {
  it.each([
    ['Krea 2 Turbo', false],
    ['Pony', true],
    ['SDXL 1.0', true],
    ['Illustrious', true],
  ])('a Pony LoRA on a %s checkpoint: %s', (checkpoint, expected) => {
    expect(isFeaturedResourceCompatible(checkpoint, 'Pony', 'LORA')).toBe(expected);
  });

  it('judges a type the rules do not list by model family alone', () => {
    expect(isFeaturedResourceCompatible('Pony', 'SDXL 1.0', 'Controlnet')).toBe(true);
    expect(isFeaturedResourceCompatible('Flux.1 D', 'SD 1.5', 'Hypernetwork')).toBe(false);
  });

  it('passes a base model the table does not know, or the catch-all Other', () => {
    expect(isFeaturedResourceCompatible('Not A Base Model', 'Pony', 'LORA')).toBe(true);
    expect(isFeaturedResourceCompatible('Krea 2 Turbo', 'Not A Base Model', 'LORA')).toBe(true);
    expect(isFeaturedResourceCompatible('Other', 'Pony', 'LORA')).toBe(true);
  });

  // For the types the cross-ecosystem rules list, the helper re-states getGenerationSupport's
  // same-ecosystem + crossEcosystemRules lookup without its on-site gates. Wherever on-site
  // generation IS enabled, the two must agree, so a new rule cannot reach one and not the other.
  // Other types (ControlNet…) deliberately differ; keep them out of this loop. If this fails after a
  // basemodel.constants change, fix the helper, not this test.
  it('agrees with getGenerationSupport wherever on-site generation is enabled', () => {
    const sampleBaseModel = new Map<number, string>();
    for (const record of baseModelRecords) {
      if (!sampleBaseModel.has(record.ecosystemId))
        sampleBaseModel.set(record.ecosystemId, record.name);
    }
    const types: ModelType[] = ['LORA', 'LoCon', 'DoRA', 'TextualInversion', 'VAE', 'Checkpoint'];
    let compared = 0;
    for (const checkpointEco of ecosystems) {
      const support = getEcosystemSupport(checkpointEco.id, 'generation');
      if (!support || support.disabled || checkpointEco.key === 'Other') continue;
      const checkpointBaseModel = sampleBaseModel.get(checkpointEco.id);
      if (!checkpointBaseModel) continue;
      for (const resourceEco of ecosystems) {
        const resourceBaseModel = sampleBaseModel.get(resourceEco.id);
        if (!resourceBaseModel || resourceEco.key === 'Other') continue;
        for (const type of types) {
          // Same ecosystem but a type the site does not generate with: getGenerationSupport says
          // no for an on-site reason, which is exactly the gate the helper leaves out.
          if (resourceEco.id === checkpointEco.id && !support.modelTypes.includes(type)) continue;
          const expected = getGenerationSupport(checkpointEco.id, resourceEco.id, type) !== null;
          const actual = isFeaturedResourceCompatible(checkpointBaseModel, resourceBaseModel, type);
          expect({ checkpointBaseModel, resourceBaseModel, type, actual }).toEqual({
            checkpointBaseModel,
            resourceBaseModel,
            type,
            actual: expected,
          });
          compared++;
        }
      }
    }
    // A loop that compares nothing passes. Floor set well below the current count.
    expect(compared).toBeGreaterThan(1000);
  });
});

describe('findIncompatibleEntries', () => {
  const lora = (imageId: number): EntryResourceRow => ({
    imageId,
    baseModel: 'Pony',
    type: 'LORA',
    isFeatured: true,
  });
  const checkpoint = (imageId: number, baseModel: string): EntryResourceRow => ({
    imageId,
    baseModel,
    type: 'Checkpoint',
    isFeatured: false,
  });

  it('flags only the image whose checkpoint cannot run the featured resource', () => {
    const rows = [lora(1), checkpoint(1, 'Krea 2 Turbo'), lora(2), checkpoint(2, 'SDXL 1.0')];
    expect([...findIncompatibleEntries(rows)]).toEqual([1]);
  });

  it('passes when any one of several checkpoints is compatible', () => {
    const rows = [lora(1), checkpoint(1, 'Krea 2 Turbo'), checkpoint(1, 'Pony')];
    expect(findIncompatibleEntries(rows).size).toBe(0);
  });

  it('passes when any one of several featured versions is compatible', () => {
    const rows = [
      lora(1),
      { imageId: 1, baseModel: 'Krea 2', type: 'LORA' as const, isFeatured: true },
      checkpoint(1, 'Krea 2 Turbo'),
    ];
    expect(findIncompatibleEntries(rows).size).toBe(0);
  });

  it('passes an image with no detected checkpoint', () => {
    expect(findIncompatibleEntries([lora(1)]).size).toBe(0);
  });

  it('passes when the featured resource is itself the checkpoint', () => {
    const rows = [
      { imageId: 1, baseModel: 'Pony', type: 'Checkpoint' as const, isFeatured: true },
      checkpoint(1, 'Krea 2 Turbo'),
    ];
    expect(findIncompatibleEntries(rows).size).toBe(0);
  });
});
