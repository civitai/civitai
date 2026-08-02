/**
 * MiniMax (Hailuo) Graph
 *
 * Controls for the MiniMax H3 video ecosystem (engine: `minimax-h3`).
 * Output is always native 2K, so there is no resolution control.
 *
 * Workflows:
 * - txt2vid: Text to video
 * - img2vid / img2vid:first-last: First + last frame slots
 * - img2vid:ref2vid: Reference images
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  createCheckpointGraph,
  imagesNode,
  promptGraph,
  sliderNode,
  snippetsGraph,
  triggerWordsGraph,
} from './common';
import { isWorkflowOrVariant } from './config/workflows';
import {
  getAspectRatioOptions,
  type GenerationAspectRatio,
} from '~/shared/constants/generation.constants';

export const minimaxVersionIds = {
  'v1.0': 3183239,
} as const;

const minimaxAspectRatioList: GenerationAspectRatio[] = [
  '21:9',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
];

const minimaxAspectRatios = getAspectRatioOptions('2K', minimaxAspectRatioList);

/** Reference images map to `referenceImages` on the H3 input. */
const MAX_REFERENCE_IMAGES = 9;

export const minimaxGraph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  .node(
    'images',
    (ctx) => {
      if (isWorkflowOrVariant(ctx.workflow, 'img2vid')) {
        return {
          ...imagesNode({
            slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame (optional)' }],
            warnOnMissingAiMetadata: true,
          }),
          when: true,
        };
      }
      if (ctx.workflow === 'img2vid:ref2vid') {
        return {
          ...imagesNode({ max: MAX_REFERENCE_IMAGES, warnOnMissingAiMetadata: true }),
          when: true,
        };
      }
      // txt2vid — hide images
      return { ...imagesNode(), when: false };
    },
    ['workflow']
  )
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: [{ label: 'v1.0', value: minimaxVersionIds['v1.0'] }] },
        defaultModelId: minimaxVersionIds['v1.0'],
      }),
    []
  )
  // Aspect ratio - for text-to-video and reference-to-video; frame workflows
  // derive it from the source image via H3's 'adaptive' value
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: minimaxAspectRatios, defaultValue: '16:9' }),
      when: ctx.workflow === 'txt2vid' || ctx.workflow === 'img2vid:ref2vid',
    }),
    ['workflow']
  )
  .node('duration', sliderNode({ min: 4, max: 15, defaultValue: 6 }))

  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph);

export { minimaxAspectRatios };
