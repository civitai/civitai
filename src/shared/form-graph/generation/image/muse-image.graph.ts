import { defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { aspectRatioDef, img2imgImages } from '../defs';
import { familyScope, promptOnlyTextBlock, type FamilyExt } from '../shared';

/**
 * Muse Image (Meta, fal engine). Locked
 * single version; no LoRAs, negative prompt, cfg, steps, or seed — the
 * orchestrator input type accepts none of them. txt2img picks an aspect
 * ratio; edit takes up to 4 reference images and derives the ratio from them.
 */

export const museImageVersionId = 3291238;

/**
 * MuseImageFalImageGenInput.aspectRatio minus 'auto' (the handler reserves it
 * for editing). Long edge fixed at 2048 to match fal's documented 16:9 output.
 */
const museImageAspectRatios = [
  { label: '21:9', value: '21:9', width: 2048, height: 878 },
  { label: '16:9', value: '16:9', width: 2048, height: 1152 },
  { label: '3:2', value: '3:2', width: 2048, height: 1365 },
  { label: '4:3', value: '4:3', width: 2048, height: 1536 },
  { label: '1:1', value: '1:1', width: 2048, height: 2048 },
  { label: '3:4', value: '3:4', width: 1536, height: 2048 },
  { label: '2:3', value: '2:3', width: 1365, height: 2048 },
  { label: '9:16', value: '9:16', width: 1152, height: 2048 },
  { label: '9:21', value: '9:21', width: 878, height: 2048 },
];

const museImagePriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

export const museImage = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      modelLocked: true,
      defaultModelId: museImageVersionId,
    })
  )
  .use(promptOnlyTextBlock)
  .field('aspectRatio', ({ _ext }) =>
    _ext.workflow.startsWith('txt')
      ? aspectRatioDef({
          options: museImageAspectRatios,
          default: '1:1',
          priorityOptions: museImagePriorityRatios,
        })
      : null
  )
  .field('images', img2imgImages({ min: 1, max: 4 }));
