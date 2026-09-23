import { defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SDXL_SQUARE_AR, SEED, guidancePresetsLowBalHigh, sliderDef } from '../defs';
import { familyResources, familyScope, promptOnlyTextBlock, type FamilyExt } from '../shared';

/**
 * Pony V7 (AuraFlow architecture), ported from `pony-v7-graph.ts`. LoRAs
 * supported; no negative prompt, sampler, or CLIP skip. Works best at 40+
 * steps, hence the default.
 */

const ponyV7VersionId = 2152373;

export const ponyV7 = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      defaultModelId: ponyV7VersionId,
    })
  )
  .field('resources', familyResources)
  .use(promptOnlyTextBlock)
  .field('aspectRatio', SDXL_SQUARE_AR)
  .field(
    'cfgScale',
    sliderDef({ min: 2, max: 20, default: 3.5, step: 0.5, presets: guidancePresetsLowBalHigh })
  )
  .field('steps', sliderDef({ min: 20, max: 50, default: 40 }))
  .field('seed', SEED);
