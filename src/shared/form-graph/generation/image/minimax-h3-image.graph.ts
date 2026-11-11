import { z } from 'zod';
import { defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { optionFallback, aspectRatioDef, img2imgImages, SEED } from '../defs';
import { familyScope, promptOnlyTextBlock, type FamilyExt } from '../shared';

/**
 * MiniMax H3 Image on our own comfy workers. The engine takes width and height (multiples of
 * 32, 4 to 20 MP), so resolution and aspect ratio pick a size from the table below. No negative
 * prompt and no prompt expansion; LoRAs and checkpoint overrides are not offered yet.
 */

export const minimaxH3ImageVersionId = 3463368;

export const MINIMAX_H3_IMAGE_IMAGES_LIMIT = 16;
export const MINIMAX_H3_IMAGE_MAX_QUANTITY = 4;

/**
 * Dims at 2K: the smallest multiples of 32 at each ratio that clear the engine's 4 MP floor.
 * 4K doubles both sides, which stays under its 20 MP ceiling (3:1 at 4K is 7104x2368).
 */
const minimaxH3ImageAspectRatios = [
  { label: '3:1', value: '3:1', width: 3552, height: 1184 },
  { label: '21:9', value: '21:9', width: 3136, height: 1344 },
  { label: '16:9', value: '16:9', width: 2784, height: 1568 },
  { label: '3:2', value: '3:2', width: 2560, height: 1696 },
  { label: '4:3', value: '4:3', width: 2400, height: 1792 },
  { label: '5:4', value: '5:4', width: 2304, height: 1856 },
  { label: '1:1', value: '1:1', width: 2048, height: 2048 },
  { label: '4:5', value: '4:5', width: 1856, height: 2304 },
  { label: '3:4', value: '3:4', width: 1792, height: 2400 },
  { label: '2:3', value: '2:3', width: 1696, height: 2560 },
  { label: '9:16', value: '9:16', width: 1568, height: 2784 },
  { label: '9:21', value: '9:21', width: 1344, height: 3136 },
  { label: '1:3', value: '1:3', width: 1184, height: 3552 },
];

const minimaxH3ImagePriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

export const minimaxH3ImageResolutionOptions = ['2K', '4K'] as const;
type MinimaxH3ImageResolution = (typeof minimaxH3ImageResolutionOptions)[number];

/** Side multiplier over the 2K table. */
export const minimaxH3ImageResolutionScale: Record<MinimaxH3ImageResolution, number> = {
  '2K': 1,
  '4K': 2,
};

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
    default: '2K' as MinimaxH3ImageResolution,
    correct: optionFallback(minimaxH3ImageResolutionOptions, '2K' as MinimaxH3ImageResolution),
    meta: {
      options: minimaxH3ImageResolutionOptions.map((value) => ({ label: value, value })),
    },
  })
  // The engine has no "follow the references" size, so edit picks a ratio too.
  .field(
    'aspectRatio',
    aspectRatioDef({
      options: minimaxH3ImageAspectRatios,
      default: '1:1',
      priorityOptions: minimaxH3ImagePriorityRatios,
    })
  )
  .field('images', img2imgImages({ min: 1, max: MINIMAX_H3_IMAGE_IMAGES_LIMIT }))
  .field('seed', SEED);
