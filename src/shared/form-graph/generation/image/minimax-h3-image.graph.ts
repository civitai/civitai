import { z } from 'zod';
import { defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { optionFallback, aspectRatioDef, boolDef, img2imgImages } from '../defs';
import { familyScope, promptOnlyTextBlock, type FamilyExt } from '../shared';

/** MiniMax H3 Image, through MiniMax's own API. No LoRAs, seed, steps or negative prompt. */

// PENDING: the Draft model version does not exist yet. 0 matches no version.
export const minimaxH3ImageVersionId = 0;

export const MINIMAX_H3_IMAGE_IMAGES_LIMIT = 16;
export const MINIMAX_H3_IMAGE_MAX_QUANTITY = 10;

/** Ratios within the API's 1:3 to 3:1 range. Dims at 1K. */
const minimaxH3ImageAspectRatios = [
  { label: '3:1', value: '3:1', width: 1776, height: 592 },
  { label: '21:9', value: '21:9', width: 1568, height: 672 },
  { label: '16:9', value: '16:9', width: 1368, height: 768 },
  { label: '3:2', value: '3:2', width: 1256, height: 840 },
  { label: '4:3', value: '4:3', width: 1184, height: 888 },
  { label: '5:4', value: '5:4', width: 1144, height: 912 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '4:5', value: '4:5', width: 912, height: 1144 },
  { label: '3:4', value: '3:4', width: 888, height: 1184 },
  { label: '2:3', value: '2:3', width: 840, height: 1256 },
  { label: '9:16', value: '9:16', width: 768, height: 1368 },
  { label: '9:21', value: '9:21', width: 672, height: 1568 },
  { label: '1:3', value: '1:3', width: 592, height: 1776 },
];

const minimaxH3ImagePriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

const minimaxH3ImageResolutionOptions = ['1K', '2K', '4K'] as const;
type MinimaxH3ImageResolution = (typeof minimaxH3ImageResolutionOptions)[number];

export const minimaxH3Image = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      modelLocked: true,
      defaultModelId: minimaxH3ImageVersionId,
    })
  )
  .use(promptOnlyTextBlock)
  .field('resolution', {
    input: z.enum(minimaxH3ImageResolutionOptions).optional(),
    output: z.enum(minimaxH3ImageResolutionOptions),
    default: '1K' as MinimaxH3ImageResolution,
    correct: optionFallback(minimaxH3ImageResolutionOptions, '1K' as MinimaxH3ImageResolution),
    meta: {
      options: minimaxH3ImageResolutionOptions.map((value) => ({ label: value, value })),
    },
  })
  // Edit sends `auto`, so the output follows the references.
  .field('aspectRatio', ({ _ext }) =>
    _ext.workflow.startsWith('txt')
      ? aspectRatioDef({
          options: minimaxH3ImageAspectRatios,
          default: '1:1',
          priorityOptions: minimaxH3ImagePriorityRatios,
        })
      : null
  )
  .field('images', img2imgImages({ min: 1, max: MINIMAX_H3_IMAGE_IMAGES_LIMIT }))
  // MiniMax always enhances an edit prompt, so the switch exists for text-to-image only.
  .field('enablePromptExpansion', ({ _ext }) =>
    _ext.workflow.startsWith('txt') ? boolDef(true) : null
  );
