/**
 * MiniMax (Hailuo) Graph
 *
 * Controls for the MiniMax H3 video ecosystem. Two variants, discriminated by
 * the selected model version:
 * - api (`minimax-h3`): MiniMax-hosted, native 2K, no resolution control
 * - comfy (`minimax-h3-comfy`): local FL2VA/REF2VA weights at 720p, with LoRAs,
 *   seed, a step count, and the turbo LoRA toggle
 *
 * Workflows:
 * - txt2vid: Text to video
 * - img2vid / img2vid:first-last: First + last frame slots
 * - img2vid:ref2vid: Reference images
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import type { ResourceData } from './common';
import {
  aspectRatioNode,
  createCheckpointGraph,
  createResourcesGraph,
  createTextEditorGraph,
  imagesNode,
  seedNode,
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
  comfy: 3216500,
} as const;

export type MinimaxVariant = 'api' | 'comfy';

const versionIdToVariant = new Map<number, MinimaxVariant>([[minimaxVersionIds.comfy, 'comfy']]);

const minimaxAspectRatioList: GenerationAspectRatio[] = [
  '21:9',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
];

const minimaxAspectRatios = getAspectRatioOptions('2K', minimaxAspectRatioList);

/**
 * The comfy backend rejects dimensions that aren't multiples of 32, and the
 * shared 720p table isn't (720 itself is 22.5 × 32). Snapping here rather than
 * in the handler keeps the value the picker shows equal to the value sent.
 */
const COMFY_DIMENSION_MULTIPLE = 32;
const snapDown = (n: number) =>
  Math.max(
    COMFY_DIMENSION_MULTIPLE,
    Math.floor(n / COMFY_DIMENSION_MULTIPLE) * COMFY_DIMENSION_MULTIPLE
  );

const minimaxComfyAspectRatios = getAspectRatioOptions('720p', minimaxAspectRatioList).map(
  (option) => ({ ...option, width: snapDown(option.width), height: snapDown(option.height) })
);

/** Reference images map to `referenceImages` on the H3 input. */
const MAX_REFERENCE_IMAGES = 9;

/** MiniMax hosts the API variant; nothing beyond the shared controls to add. */
const apiGraph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>();

const comfyGraph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  .merge(createResourcesGraph())
  .node('seed', seedNode())
  .node(
    'turbo',
    () => ({
      input: z.boolean().optional(),
      output: z.boolean(),
      defaultValue: false,
    }),
    []
  )
  // The turbo LoRA converges in far fewer steps, so the range follows the toggle.
  .node(
    'steps',
    (ctx) =>
      'turbo' in ctx && ctx.turbo === true
        ? sliderNode({ min: 1, max: 20, defaultValue: 8 })
        : sliderNode({ min: 10, max: 60, defaultValue: 30 }),
    ['turbo']
  );

export const minimaxGraph = new DataGraph<
  { ecosystem: string; workflow: string; model: ResourceData },
  GenerationCtx
>()
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
        versions: {
          options: [
            { label: 'H3 (Comfy)', value: minimaxVersionIds.comfy },
            { label: 'H3 (API)', value: minimaxVersionIds['v1.0'] },
          ],
        },
        defaultModelId: minimaxVersionIds.comfy,
      }),
    []
  )
  // Aspect ratio - for text-to-video and reference-to-video; frame workflows
  // derive it from the source image (H3's 'adaptive' value, or the comfy
  // variant taking its dimensions from the frame).
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({
        options:
          ctx.model?.id === minimaxVersionIds.comfy
            ? minimaxComfyAspectRatios
            : minimaxAspectRatios,
        defaultValue: '16:9',
      }),
      when: ctx.workflow === 'txt2vid' || ctx.workflow === 'img2vid:ref2vid',
    }),
    ['workflow', 'model']
  )
  .node('duration', sliderNode({ min: 4, max: 15, defaultValue: 6 }))
  .computed(
    'minimaxVariant',
    (ctx) => (ctx.model?.id ? versionIdToVariant.get(ctx.model.id) : undefined) ?? 'api',
    ['model']
  )
  .discriminator('minimaxVariant', {
    api: apiGraph,
    comfy: comfyGraph,
  })

  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  // Unlike the shared promptGraph, an attached image does not excuse the prompt:
  // H3 rejects a text-less request outright (`content[0].text is empty`, 2013).
  .merge(createTextEditorGraph({ name: 'prompt', required: true }));

export { minimaxAspectRatios };
