import { defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SEED, aspectRatioDef, img2imgImages } from '../defs';
import { familyScope, promptOnlyTextBlock, type FamilyExt } from '../shared';

/**
 * MAI-Image-2.5, ported from `mai-graph.ts`. Locked single version; no LoRAs,
 * sampler, cfg, steps, or CLIP skip. txt2img picks an aspect ratio; edit takes
 * one reference image cropped to a supported ratio.
 */

// ---- copied from mai-graph.ts, which dies with the data-graph engine --------

export const maiVersionId = 3002140;

/** Matches MaiImageCreateFalImageGenInput.aspectRatio. */
const maiAspectRatios = [
  { label: '21:9', value: '21:9', width: 2520, height: 1080 },
  { label: '16:9', value: '16:9', width: 1920, height: 1080 },
  { label: '3:2', value: '3:2', width: 1620, height: 1080 },
  { label: '4:3', value: '4:3', width: 1440, height: 1080 },
  { label: '5:4', value: '5:4', width: 1350, height: 1080 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '4:5', value: '4:5', width: 1080, height: 1350 },
  { label: '3:4', value: '3:4', width: 1080, height: 1440 },
  { label: '2:3', value: '2:3', width: 1080, height: 1620 },
  { label: '9:16', value: '9:16', width: 1080, height: 1920 },
];

const maiPriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

/** Edit uploads must crop to a supported output ratio. */
export const maiCropAspectRatios = maiAspectRatios.map((r) => r.value as `${number}:${number}`);

// ---- end of mai-graph.ts copies ---------------------------------------------

export const mai = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      modelLocked: true,
      defaultModelId: maiVersionId,
    })
  )
  .use(promptOnlyTextBlock)
  .field('aspectRatio', ({ _ext }) =>
    _ext.workflow.startsWith('txt')
      ? aspectRatioDef({
          options: maiAspectRatios,
          default: '1:1',
          priorityOptions: maiPriorityRatios,
        })
      : null
  )
  .field('images', img2imgImages({ max: 1, aspectRatios: maiCropAspectRatios }))
  .field('seed', SEED);
