import { describe, expect, it } from 'vitest';
import {
  baseModelByName,
  filterCompatibleResources,
  isBaseModelGenerationSupported,
} from '@civitai/shared/basemodel.constants';
import { ModelType } from '~/shared/utils/prisma/enums';

/**
 * "Does this ecosystem support this model TYPE for generation" is answered in two places, and
 * they disagreed. `isBaseModelGenerationSupported` reads the ecosystem's `modelTypes`, and it is
 * what `isGenerationEligible` — so `canGenerate`, so the picker — is built on.
 * `filterCompatibleResources` asks `getGenerationSupport`, which returns 'full' for ANY
 * same-ecosystem pair before it ever looks at `modelTypes`.
 *
 * Measured: Chroma's endpoint has no `embeddings` field, so TextualInversion came off its
 * `modelTypes`. `canGenerate` went false as intended, while the resource filter kept letting a
 * Chroma TI through — a selection the form refused on output and nothing could clear. The same
 * shape was already latent on Flux1, HiDream and PonyV7, which have listed `checkpointAndLora`
 * (no TI) for longer.
 *
 * So the filter now asks the eligibility derivation first. This pins that it keeps doing so, for
 * every ecosystem and every type, rather than for the one that was noticed.
 */
describe('the two generation type-support derivations agree', () => {
  const ADDON_TYPES = [
    ModelType.LORA,
    ModelType.DoRA,
    ModelType.LoCon,
    ModelType.VAE,
    ModelType.TextualInversion,
  ];

  it('a type the ecosystem does not support for generation is never kept by the resource filter', () => {
    const offenders: string[] = [];
    let ineligiblePairsSeen = 0;
    for (const [name, bm] of baseModelByName) {
      for (const type of ADDON_TYPES) {
        if (isBaseModelGenerationSupported(name, type)) continue;
        ineligiblePairsSeen++;
        const kept = filterCompatibleResources(bm.ecosystemId, [
          { id: 1, baseModel: name, model: { type } },
        ] as never);
        if (kept.length > 0) offenders.push(`${name}/${type}`);
      }
    }
    // The loop has to actually reach something, or this asserts nothing. A first draft
    // walked `baseModels` by `ecosystemId` and matched ZERO records, so it was green
    // against the very mutation it exists to catch.
    expect(ineligiblePairsSeen).toBeGreaterThan(0);
    expect(
      offenders,
      'these ecosystem/type pairs are ineligible for generation — canGenerate is false — yet the ' +
        'resource filter keeps them, which is the state that leaves an unclearable selection in the form'
    ).toEqual([]);
  });

  // The negative control: the guard above is worthless if nothing is ever ineligible.
  it('there is something for it to catch', () => {
    expect(isBaseModelGenerationSupported('Chroma', ModelType.TextualInversion)).toBe(false);
    expect(isBaseModelGenerationSupported('Chroma', ModelType.LORA)).toBe(true);
  });
});
