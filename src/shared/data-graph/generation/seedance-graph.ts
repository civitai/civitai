/**
 * Seedance Family Graph
 *
 * Controls for Seedance video generation ecosystem (ByteDance).
 * Meta contains only dynamic props - static props defined in components.
 *
 * Models:
 * - v2: Standard quality video generation
 * - v2-fast: Faster generation with lower cost
 * - v2-mini: Smaller/cheaper variant (480p/720p only)
 * - v2.5: Latest generation, up to 30s clips
 *
 * Supports txt2vid and img2vid workflows.
 * Features: aspect ratio, duration, resolution (480p/720p/1080p),
 * generateAudio toggle, seed, and images (for I2V).
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  createCheckpointGraph,
  enumNode,
  imagesNode,
  promptGraph,
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

// =============================================================================
// Constants
// =============================================================================

/** Seedance version IDs */
export const seedanceVersionIds = {
  v2: 2864671,
  'v2-fast': 2868300,
  'v2-mini': 3069790,
  'v2.5': 3207504,
} as const;

/** Options for seedance version selector */
const seedanceVersionOptions = [
  { label: 'v2', value: seedanceVersionIds.v2 },
  { label: 'v2 fast', value: seedanceVersionIds['v2-fast'] },
  { label: 'v2 mini', value: seedanceVersionIds['v2-mini'] },
  { label: 'v2.5', value: seedanceVersionIds['v2.5'] },
];

// =============================================================================
// Aspect Ratios
// =============================================================================

const seedanceAspectRatioList: GenerationAspectRatio[] = [
  '21:9',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
];

// =============================================================================
// Resolution Options
// =============================================================================

const seedanceResolutions = [
  { label: '480p', value: '480p' },
  { label: '720p', value: '720p' },
] as const;

const seedanceResolutionsHd = [
  { label: '480p', value: '480p' },
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
] as const;

// =============================================================================
// Seedance Graph
// =============================================================================

/**
 * Seedance video generation controls.
 *
 * Workflow-specific behavior:
 * - txt2vid: Hides images node
 * - img2vid: Shows images input for source frames
 */
export const seedanceGraph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  // Images node - shown for img2vid, hidden for txt2vid
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ max: 1 }),
      when: isWorkflowOrVariant(ctx.workflow, 'img2vid'),
    }),
    ['workflow']
  )
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: seedanceVersionOptions },
        defaultModelId: seedanceVersionIds['v2-mini'],
      }),
    []
  )
  .node(
    'resolution',
    (ctx) => {
      const supports1080p =
        ctx.model?.id === seedanceVersionIds.v2 || ctx.model?.id === seedanceVersionIds['v2.5'];
      const options = supports1080p ? seedanceResolutionsHd : seedanceResolutions;
      return enumNode({ options, defaultValue: '720p' });
    },
    ['model']
  )
  // Aspect ratio dimensions are scaled to match the selected resolution
  .node(
    'aspectRatio',
    (ctx) =>
      aspectRatioNode({
        options: getAspectRatioOptions(ctx.resolution, seedanceAspectRatioList),
        defaultValue: '16:9',
      }),
    ['resolution']
  )
  .node(
    'duration',
    (ctx) =>
      sliderNode({
        min: 4,
        max: ctx.model?.id === seedanceVersionIds['v2.5'] ? 30 : 15,
        defaultValue: 5,
      }),
    ['model']
  )
  .node(
    'generateAudio',
    () => ({
      input: z.boolean().optional(),
      output: z.boolean(),
      defaultValue: false,
    }),
    []
  )
  .node('seed', seedNode())

  // Prompt + triggerWords (no negativePrompt for Seedance)
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph);
