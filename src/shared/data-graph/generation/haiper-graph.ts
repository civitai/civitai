/**
 * Haiper Graph
 *
 * Controls for Haiper video generation ecosystem.
 * Supports txt2vid and img2vid workflows.
 *
 * Nodes:
 * - seed: Optional seed for reproducibility
 * - enablePromptEnhancer: Toggle for prompt enhancement
 * - negativePrompt: Negative prompt for generation
 * - aspectRatio: Output aspect ratio (txt2vid only)
 * - duration: Video duration (2, 4, or 8 seconds)
 * - resolution: Output resolution (720, 1080, or 2160)
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { seedNode, negativePromptNode, aspectRatioNode } from './common';

// =============================================================================
// Constants
// =============================================================================

/** Haiper aspect ratio options */
const haiperAspectRatios = [
  { label: '16:9', value: '16:9', width: 1280, height: 720 },
  { label: '4:3', value: '4:3', width: 960, height: 720 },
  { label: '1:1', value: '1:1', width: 720, height: 720 },
  { label: '3:4', value: '3:4', width: 720, height: 960 },
  { label: '9:16', value: '9:16', width: 720, height: 1280 },
];

/** Haiper duration options */
const haiperDurations = [
  { label: '2 seconds', value: 2 },
  { label: '4 seconds', value: 4 },
  { label: '8 seconds', value: 8 },
];

/** Haiper resolution options */
const haiperResolutions = [
  { label: '720p', value: 720 },
  { label: '1080p', value: 1080 },
  { label: '4K', value: 2160 },
];

// =============================================================================
// Haiper Graph
// =============================================================================

/** Context shape for haiper graph */
type HaiperCtx = { baseModel: string; workflow: string };

/**
 * Haiper video generation controls.
 *
 * Workflow-specific behavior:
 * - txt2vid: Shows aspect ratio selector
 * - img2vid: Aspect ratio derived from source image
 */
export const haiperGraph = new DataGraph<HaiperCtx, GenerationCtx>()
  // Seed node
  .node('seed', seedNode())

  // Prompt enhancer toggle
  .node('enablePromptEnhancer', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: true,
  })

  // Negative prompt node
  .node('negativePrompt', negativePromptNode())

  // Aspect ratio node - only for txt2vid workflow
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: haiperAspectRatios, defaultValue: '1:1' }),
      when: ctx.workflow === 'txt2vid',
    }),
    ['workflow']
  )

  // Duration node
  .node('duration', {
    input: z.coerce.number().optional(),
    output: z.number(),
    defaultValue: 4,
    meta: { options: haiperDurations },
  })

  // Resolution node
  .node('resolution', {
    input: z.coerce.number().optional(),
    output: z.number(),
    defaultValue: 720,
    meta: { options: haiperResolutions },
  });

// Export constants for use in components
export { haiperAspectRatios, haiperDurations, haiperResolutions };
