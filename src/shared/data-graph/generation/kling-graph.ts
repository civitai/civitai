/**
 * Kling Graph
 *
 * Controls for Kling video generation ecosystem.
 * Supports txt2vid and img2vid workflows with multiple model versions.
 *
 * Model versions:
 * - V1_6: Original model, supports standard and professional modes
 * - V2: Professional mode only
 * - V2_5_TURBO: Professional mode only, faster generation
 *
 * Nodes:
 * - model: Model version selector (V1_6, V2, V2_5_TURBO)
 * - seed: Optional seed for reproducibility
 * - enablePromptEnhancer: Toggle for prompt enhancement
 * - negativePrompt: Negative prompt for generation
 * - aspectRatio: Output aspect ratio (txt2vid only)
 * - mode: Generation mode (standard/professional)
 * - duration: Video duration (5 or 10 seconds)
 * - cfgScale: CFG scale for generation control
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  seedNode,
  negativePromptNode,
  aspectRatioNode,
  cfgScaleNode,
  createCheckpointGraph,
} from './common';

// =============================================================================
// Constants
// =============================================================================

/** Kling model version IDs */
const klingVersionIds = {
  v1_6: 1, // Placeholder - actual version IDs from API
  v2: 2,
  v2_5_turbo: 3,
} as const;

/** Options for Kling model selector */
const klingVersionOptions = [
  { label: 'Kling V1.6', value: klingVersionIds.v1_6 },
  { label: 'Kling V2', value: klingVersionIds.v2 },
  { label: 'Kling V2.5 Turbo', value: klingVersionIds.v2_5_turbo },
];

/** Kling aspect ratio options */
const klingAspectRatios = [
  { label: '16:9', value: '16:9', width: 1280, height: 720 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '9:16', value: '9:16', width: 720, height: 1280 },
];

/** Kling mode options */
const klingModes = [
  { label: 'Standard', value: 'standard' },
  { label: 'Professional', value: 'professional' },
] as const;

/** Kling duration options */
const klingDurations = [
  { label: '5 seconds', value: '5' },
  { label: '10 seconds', value: '10' },
] as const;

// =============================================================================
// Kling Graph
// =============================================================================

/** Context shape for kling graph */
type KlingCtx = { baseModel: string; workflow: string };

/**
 * Kling video generation controls.
 *
 * Workflow-specific behavior:
 * - txt2vid: Shows aspect ratio selector
 * - img2vid: Aspect ratio derived from source image
 *
 * Mode is derived from model version:
 * - V1.6: Can use standard or professional
 * - V2/V2.5: Professional only
 */
export const klingGraph = new DataGraph<KlingCtx, GenerationCtx>()
  // Merge checkpoint graph with model versions
  .merge(
    createCheckpointGraph({
      versions: klingVersionOptions,
      defaultModelId: klingVersionIds.v1_6,
    })
  )

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
    (ctx) => {
      const isTxt2Vid = ctx.workflow === 'txt2vid';
      return {
        ...aspectRatioNode({ options: klingAspectRatios, defaultValue: '1:1' }),
        when: isTxt2Vid,
      };
    },
    ['workflow']
  )

  // Mode node - derives available options from model
  .node(
    'mode',
    (ctx) => {
      const model = ctx.model as { id?: number } | undefined;
      const isV1_6 = model?.id === klingVersionIds.v1_6;

      // Only V1.6 supports standard mode
      const options = isV1_6 ? klingModes : klingModes.filter((m) => m.value === 'professional');
      const defaultValue = isV1_6 ? 'standard' : 'professional';

      return {
        input: z.enum(['standard', 'professional']).optional(),
        output: z.enum(['standard', 'professional']),
        defaultValue: defaultValue as 'standard' | 'professional',
        meta: {
          options,
        },
      };
    },
    ['model']
  )

  // Duration node
  .node('duration', {
    input: z.enum(['5', '10']).optional(),
    output: z.enum(['5', '10']),
    defaultValue: '5' as const,
    meta: {
      options: klingDurations,
    },
  })

  // CFG scale node
  .node(
    'cfgScale',
    cfgScaleNode({
      min: 0.1,
      max: 1,
      step: 0.1,
      defaultValue: 0.5,
      presets: [
        { label: 'Low', value: 0.3 },
        { label: 'Medium', value: 0.5 },
        { label: 'High', value: 0.7 },
      ],
    })
  );

// Export constants for use in components
export { klingAspectRatios, klingModes, klingDurations, klingVersionOptions, klingVersionIds };
