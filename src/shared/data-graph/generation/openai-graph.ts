/**
 * OpenAI Family Graph V2
 *
 * Controls for OpenAI ecosystem (GPT Image generation).
 * Meta contains only dynamic props - static props defined in components.
 *
 * OpenAI models:
 * - gpt-image-1 (v1)
 * - gpt-image-1.5 (v1.5)
 *
 * Note: No LoRA support, no negative prompts, samplers, steps, CFG scale, or CLIP skip.
 * Supports transparent background toggle and quality selection.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { aspectRatioNode, createCheckpointGraph, imagesNode, seedNode } from './common';

// =============================================================================
// OpenAI Model Constants
// =============================================================================

/** OpenAI model version IDs */
const openaiVersionIds = {
  v1: 1733399,
  'v1.5': 2512167,
} as const;

/** Options for OpenAI model mode selector (using version IDs as values) */
const openaiModeVersionOptions = [
  { label: 'v1', value: openaiVersionIds.v1 },
  { label: 'v1.5', value: openaiVersionIds['v1.5'] },
];

// =============================================================================
// Aspect Ratios
// =============================================================================

/** OpenAI aspect ratios (based on supported sizes) */
const openaiAspectRatios = [
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1536, height: 1024 },
  { label: '2:3', value: '2:3', width: 1024, height: 1536 },
];

// =============================================================================
// Quality Options
// =============================================================================

/** OpenAI quality options */
const qualityOptions = ['high', 'medium', 'low'] as const;
type OpenAIQuality = (typeof qualityOptions)[number];

// =============================================================================
// OpenAI Graph V2
// =============================================================================

/**
 * OpenAI family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Note: OpenAI doesn't use LoRAs, negative prompts, samplers, steps, CFG scale, or CLIP skip.
 */
export const openaiGraph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  // Images node - shown for img2img variants, hidden for txt2img
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ max: 7, min: ctx.workflow === 'img2img:edit' ? 1 : 0 }),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  // Merge checkpoint graph with version options
  .merge(
    () =>
      createCheckpointGraph({
        versions: openaiModeVersionOptions,
        defaultModelId: openaiVersionIds['v1.5'],
      }),
    []
  )
  // Aspect ratio
  .node('aspectRatio', aspectRatioNode({ options: openaiAspectRatios, defaultValue: '1:1' }))
  // Transparent background toggle
  .node('transparent', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })
  // Quality selector
  .node('quality', {
    input: z.enum(qualityOptions).optional(),
    output: z.enum(qualityOptions),
    defaultValue: 'high' as OpenAIQuality,
    meta: {
      options: qualityOptions.map((q) => ({
        label: q.charAt(0).toUpperCase() + q.slice(1),
        value: q,
      })),
    },
  })
  .node('seed', seedNode());

// Export for use in components
export { openaiModeVersionOptions, openaiVersionIds, qualityOptions };
