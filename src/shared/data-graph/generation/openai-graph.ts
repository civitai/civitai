/**
 * OpenAI Family Graph V2
 *
 * Controls for OpenAI ecosystem (GPT Image generation).
 * Meta contains only dynamic props - static props defined in components.
 *
 * OpenAI models:
 * - gpt-image-1    (v1)
 * - gpt-image-1.5  (v1.5)
 * - gpt-image-2    (v2) — different API shape (width/height, no transparent/seed)
 *
 * GPT-1 / GPT-1.5 share a subgraph; GPT-2 has its own subgraph. Variant is
 * computed from the selected model id and fed into a discriminator, so the
 * form swaps controls when the user switches models.
 *
 * Note: No LoRA support, no negative prompts, samplers, steps, CFG scale, or CLIP skip.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import type { ResourceData } from './common';
import { aspectRatioNode, createCheckpointGraph, imagesNode, seedNode } from './common';

// =============================================================================
// OpenAI Model Constants
// =============================================================================

/** OpenAI model version IDs. Ordered oldest → latest; the last entry is the default. */
const openaiVersionIds = {
  v1: 1733399,
  'v1.5': 2512167,
  v2: 2880272,
} as const;

/** Options for OpenAI model mode selector (using version IDs as values) */
const openaiModeVersionOptions = [
  { label: 'v1', value: openaiVersionIds.v1 },
  { label: 'v1.5', value: openaiVersionIds['v1.5'] },
  { label: 'v2', value: openaiVersionIds.v2 },
];

/** Default to the newest version. Sourced from the last entry in `openaiVersionIds`. */
const defaultOpenaiVersionId = Object.values(openaiVersionIds).slice(-1)[0];

type OpenAIVariant = 'gpt1' | 'gpt2';

/** Map version ID to variant. v1 and v1.5 both map to gpt1 (shared subgraph). */
const versionIdToVariant = new Map<number, OpenAIVariant>([
  [openaiVersionIds.v1, 'gpt1'],
  [openaiVersionIds['v1.5'], 'gpt1'],
  [openaiVersionIds.v2, 'gpt2'],
]);

// =============================================================================
// Aspect Ratios
// =============================================================================

/**
 * Shared aspect ratios. Supported by both GPT-1/1.5 and GPT-2:
 * - GPT-1/1.5 `size` enum: 1024x1024 | 1536x1024 | 1024x1536
 * - GPT-2 accepts numeric width/height; same three resolutions are valid.
 */
const openaiAspectRatios = [
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1536, height: 1024 },
  { label: '2:3', value: '2:3', width: 1024, height: 1536 },
];

// =============================================================================
// Quality Options
// =============================================================================

/** Shared quality enum — matches GPT-2 exactly, subset of GPT-1/1.5's enum (no 'auto'). */
const qualityOptions = ['high', 'medium', 'low'] as const;
type OpenAIQuality = (typeof qualityOptions)[number];

// =============================================================================
// Variant Subgraphs
// =============================================================================

const qualityNode = {
  input: z.enum(qualityOptions).optional(),
  output: z.enum(qualityOptions),
  defaultValue: 'high' as OpenAIQuality,
  meta: {
    options: qualityOptions.map((q) => ({
      label: q.charAt(0).toUpperCase() + q.slice(1),
      value: q,
    })),
  },
};

/** GPT-1 / GPT-1.5: supports transparent background. */
const openaiGpt1Graph = new DataGraph<{ ecosystem: string }, GenerationCtx>()
  .node('transparent', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })
  .node('quality', qualityNode);

/** GPT-2: no transparent — quality is the only variant-specific control. */
const openaiGpt2Graph = new DataGraph<{ ecosystem: string }, GenerationCtx>().node(
  'quality',
  qualityNode
);

// =============================================================================
// OpenAI Graph V2
// =============================================================================

/**
 * OpenAI family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Note: OpenAI doesn't use LoRAs, negative prompts, samplers, steps, CFG scale, or CLIP skip.
 */
export const openaiGraph = new DataGraph<
  { ecosystem: string; workflow: string; model: ResourceData },
  GenerationCtx
>()
  // Images node - shown for img2img variants, hidden for txt2img
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ max: 7 }),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  // Merge checkpoint graph with version options
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: openaiModeVersionOptions },
        defaultModelId: defaultOpenaiVersionId,
      }),
    []
  )
  // Aspect ratio (shared across all OpenAI models)
  .node('aspectRatio', aspectRatioNode({ options: openaiAspectRatios, defaultValue: '1:1' }))
  // Seed lives at the top level so both variant subgraphs expose it. GPT-2
  // doesn't actually use it in the API, but keeping the node keeps the
  // ecosystem's Ctx union shape consistent with the rest of the generator.
  .node('seed', seedNode())
  // Compute variant from selected model, then branch into variant subgraph.
  .computed(
    'openaiVariant',
    (ctx) => (ctx.model?.id ? versionIdToVariant.get(ctx.model.id) : undefined) ?? 'gpt2',
    ['model']
  )
  .discriminator('openaiVariant', {
    gpt1: openaiGpt1Graph,
    gpt2: openaiGpt2Graph,
  });

// Export for use in components / handler
export { openaiModeVersionOptions, openaiVersionIds, qualityOptions };
