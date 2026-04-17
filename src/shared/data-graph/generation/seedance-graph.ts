/**
 * Seedance Family Graph
 *
 * Controls for Seedance video generation ecosystem (ByteDance).
 * Meta contains only dynamic props - static props defined in components.
 *
 * Two models:
 * - v2: Standard quality video generation
 * - v2-fast: Faster generation with lower cost
 *
 * Supports txt2vid and img2vid workflows.
 * Features: aspect ratio, duration (4-15s), resolution (480p/720p),
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
  seedNode,
  sliderNode,
} from './common';
import { isWorkflowOrVariant } from './config/workflows';

// =============================================================================
// Constants
// =============================================================================

/** Seedance version IDs */
export const seedanceVersionIds = {
  v2: 2864671,
} as const;

/** Options for seedance version selector */
const seedanceVersionOptions = [{ label: 'v2', value: seedanceVersionIds.v2 }];

// =============================================================================
// Aspect Ratios
// =============================================================================

/** Seedance aspect ratios */
const seedanceAspectRatios = [
  { label: '21:9', value: '21:9', width: 2016, height: 864 },
  { label: '16:9', value: '16:9', width: 1280, height: 720 },
  { label: '4:3', value: '4:3', width: 960, height: 720 },
  { label: '1:1', value: '1:1', width: 720, height: 720 },
  { label: '3:4', value: '3:4', width: 720, height: 960 },
  { label: '9:16', value: '9:16', width: 720, height: 1280 },
];

// =============================================================================
// Resolution Options
// =============================================================================

const seedanceResolutions = [
  { label: '480p', value: '480p' },
  { label: '720p', value: '720p' },
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
        defaultModelId: seedanceVersionIds.v2,
      }),
    []
  )
  .node('aspectRatio', aspectRatioNode({ options: seedanceAspectRatios, defaultValue: '16:9' }))
  .node(
    'resolution',
    enumNode({
      options: seedanceResolutions,
      defaultValue: '720p',
    })
  )
  .node('duration', sliderNode({ min: 4, max: 15, defaultValue: 5 }))
  .node(
    'generateAudio',
    () => ({
      input: z.boolean().optional(),
      output: z.boolean(),
      defaultValue: false,
    }),
    []
  )
  .node('seed', seedNode());
