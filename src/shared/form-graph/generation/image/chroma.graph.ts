import { defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import {
  SDXL_SQUARE_AR,
  SEED,
  defaultSamplerPresets,
  guidancePresetsLowBalHigh,
  selectDef,
  sliderDef,
} from '../defs';
import { familyResources, familyScope, promptOnlyTextBlock, type FamilyExt } from '../shared';

/** Chroma, ported from `chroma-graph.ts`. No negative prompt, no CLIP skip. */

// Copied from chroma-graph.ts, which dies with the data-graph engine.
const chromaVersionId = 2164239;
/** Flow-compatible samplers. */
const chromaSamplers = ['Euler', 'Euler a', 'DPM++ SDE', 'DPM++ 2M Karras', 'DPM++ SDE Karras'];

export const chroma = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      defaultModelId: chromaVersionId,
    })
  )
  .field('resources', familyResources)
  .use(promptOnlyTextBlock)
  .field('aspectRatio', SDXL_SQUARE_AR)
  .field(
    'sampler',
    selectDef({ options: chromaSamplers, default: 'Euler', presets: defaultSamplerPresets })
  )
  .field(
    'cfgScale',
    sliderDef({ min: 1, max: 20, default: 3.5, step: 0.5, presets: guidancePresetsLowBalHigh })
  )
  .field('steps', sliderDef({ min: 4, max: 50, default: 25 }))
  .field('seed', SEED);
