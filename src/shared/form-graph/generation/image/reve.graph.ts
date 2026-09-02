import { defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SEED, aspectRatioDef, img2imgImages } from '../defs';
import { familyScope, promptOnlyTextBlock, type FamilyExt } from '../shared';

/**
 * Reve 2.1, ported from `reve-graph.ts`. Locked single version; no LoRAs,
 * sampler, cfg, steps, or CLIP skip. txt2img picks an aspect ratio; edit takes
 * up to 4 reference frames (addressed as <frame>N</frame> in the prompt) and
 * derives the ratio from them.
 */

// ---- copied from reve-graph.ts, which dies with the data-graph engine -------

export const reveVersionId = 3133202;

/** Subset of ReveFalImageGenInput.aspectRatio; dims at native ~4K. */
const reveAspectRatios = [
  { label: '21:9', value: '21:9', width: 4096, height: 1755 },
  { label: '16:9', value: '16:9', width: 4096, height: 2304 },
  { label: '3:2', value: '3:2', width: 4096, height: 2731 },
  { label: '4:3', value: '4:3', width: 4096, height: 3072 },
  { label: '5:4', value: '5:4', width: 4096, height: 3277 },
  { label: '1:1', value: '1:1', width: 4096, height: 4096 },
  { label: '4:5', value: '4:5', width: 3277, height: 4096 },
  { label: '3:4', value: '3:4', width: 3072, height: 4096 },
  { label: '2:3', value: '2:3', width: 2731, height: 4096 },
  { label: '9:16', value: '9:16', width: 2304, height: 4096 },
];

const revePriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

// ---- end of reve-graph.ts copies --------------------------------------------

export const reve = defineGraph<FamilyExt>()
  .scope(familyScope)
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      modelLocked: true,
      defaultModelId: reveVersionId,
    })
  )
  .use(promptOnlyTextBlock)
  .field('aspectRatio', ({ _ext }) =>
    _ext.workflow.startsWith('txt')
      ? aspectRatioDef({
          options: reveAspectRatios,
          default: '1:1',
          priorityOptions: revePriorityRatios,
        })
      : null
  )
  .field('images', img2imgImages({ min: 1, max: 4 }))
  .field('seed', SEED);
