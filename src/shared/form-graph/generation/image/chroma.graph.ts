import { defineGraph } from 'form-graph';
import { sdxlAspectRatioBuckets } from '~/shared/constants/generation.constants';
import { checkpointDef } from '../checkpoint';
import {
  SEED,
  aspectRatioDef,
  defaultSamplerPresets,
  resourcesDef,
  selectDef,
  sliderDef,
} from '../defs';
import { makeTextBlock, type FamilyExt } from '../shared';

/** Chroma, ported from `chroma-graph.ts`. No negative prompt, no CLIP skip. */

// Copied from chroma-graph.ts, which dies with the data-graph engine.
const chromaVersionId = 2164239;
const chromaGuidancePresets = [
  { label: 'Low', value: 2 },
  { label: 'Balanced', value: 3.5 },
  { label: 'High', value: 7 },
];
/** Flow-compatible samplers. */
const chromaSamplers = ['Euler', 'Euler a', 'DPM++ SDE', 'DPM++ 2M Karras', 'DPM++ SDE Karras'];

export const chroma = defineGraph<FamilyExt>()
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      defaultModelId: chromaVersionId,
    })
  )
  .field('resources', ({ _ext }) =>
    resourcesDef({ ecosystem: _ext.ecosystem, limit: _ext.limits.maxResources })
  )
  .use(makeTextBlock({ negativePrompt: false }))
  .field('aspectRatio', aspectRatioDef({ options: sdxlAspectRatioBuckets, default: '1:1' }))
  .field(
    'sampler',
    selectDef({ options: chromaSamplers, default: 'Euler', presets: defaultSamplerPresets })
  )
  .field(
    'cfgScale',
    sliderDef({ min: 1, max: 20, default: 3.5, step: 0.5, presets: chromaGuidancePresets })
  )
  .field('steps', sliderDef({ min: 4, max: 50, default: 25 }))
  .field('seed', SEED);
