import { defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SEED, aspectRatioDef } from '../defs';
import { familyScope, textBlock, type FamilyExt } from '../shared';

/**
 * Imagen 4 (Google), ported from `imagen4-graph.ts`. Locked single version; no
 * LoRAs, sampler, cfg, steps, or CLIP skip. Negative prompt supported.
 */

// ---- copied from imagen4-graph.ts, which dies with the data-graph engine ----

const imagen4VersionId = 1889632;

const imagen4AspectRatios = [
  { label: '16:9', value: '16:9', width: 1920, height: 1080 },
  { label: '4:3', value: '4:3', width: 1440, height: 1080 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:4', value: '3:4', width: 1080, height: 1440 },
  { label: '9:16', value: '9:16', width: 1080, height: 1920 },
];

// ---- end of imagen4-graph.ts copies -----------------------------------------

export const imagen4 = defineGraph<FamilyExt>()
  .scope(familyScope)
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      modelLocked: true,
      defaultModelId: imagen4VersionId,
    })
  )
  .use(textBlock)
  .field('aspectRatio', aspectRatioDef({ options: imagen4AspectRatios, default: '1:1' }))
  .field('seed', SEED);
