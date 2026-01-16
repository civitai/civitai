/**
 * Lightricks Graph
 *
 * Controls for Lightricks video generation ecosystem.
 * Supports txt2vid and img2vid workflows.
 *
 * Nodes:
 * - seed: Optional seed for reproducibility
 * - negativePrompt: Negative prompt for generation
 * - aspectRatio: Output aspect ratio (16:9 or 9:16)
 * - duration: Video duration (5 seconds fixed)
 * - cfgScale: CFG scale for generation control
 * - steps: Number of inference steps
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { seedNode, negativePromptNode, aspectRatioNode, cfgScaleNode, stepsNode } from './common';

// =============================================================================
// Constants
// =============================================================================

/** Lightricks aspect ratio options (limited to widescreen) */
const lightricksAspectRatios = [
  { label: '16:9', value: '16:9', width: 1280, height: 720 },
  { label: '9:16', value: '9:16', width: 720, height: 1280 },
];

// =============================================================================
// Lightricks Graph
// =============================================================================

/** Context shape for lightricks graph */
type LightricksCtx = { baseModel: string; workflow: string };

/**
 * Lightricks video generation controls.
 *
 * Workflow-specific behavior:
 * - txt2vid: Shows aspect ratio selector
 * - img2vid: Aspect ratio derived from source image
 */
export const lightricksGraph = new DataGraph<LightricksCtx, GenerationCtx>()
  // Seed node
  .node('seed', seedNode())

  // Negative prompt node
  .node('negativePrompt', negativePromptNode())

  // Aspect ratio node - only for txt2vid workflow
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: lightricksAspectRatios, defaultValue: '16:9' }),
      when: ctx.workflow === 'txt2vid',
    }),
    ['workflow']
  )

  // Duration is fixed at 5 seconds for Lightricks
  .node('duration', {
    input: z.literal(5).optional(),
    output: z.literal(5),
    defaultValue: 5 as const,
    meta: { fixed: true },
  })

  // CFG scale node (narrow range: 3-3.5)
  .node(
    'cfgScale',
    cfgScaleNode({
      min: 3,
      max: 3.5,
      step: 0.1,
      defaultValue: 3,
    })
  )

  // Steps node
  .node(
    'steps',
    stepsNode({
      min: 20,
      max: 30,
      step: 1,
      defaultValue: 25,
      presets: [
        { label: 'Fast', value: 20 },
        { label: 'Balanced', value: 25 },
        { label: 'Quality', value: 30 },
      ],
    })
  );

// Export constants for use in components
export { lightricksAspectRatios };
