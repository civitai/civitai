/**
 * Nano Banana Family Graph V2
 *
 * Controls for NanoBanana ecosystem (Gemini-based).
 * Meta contains only dynamic props - static props defined in components.
 *
 * Nano Banana has three modes:
 * - Standard (2.5-flash): Basic generation with minimal controls
 * - Pro: Adds negative prompt, aspect ratio, and resolution options
 * - V2 (nano-banana-2): Aspect ratio, resolution, web search toggle, and seed
 *
 * Note: No LoRA support, no samplers, CFG scale, steps, or CLIP skip.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  createCheckpointGraph,
  imagesNode,
  negativePromptGraph,
  promptGraph,
  seedNode,
  snippetsGraph,
  triggerWordsGraph,
  type AspectRatioOption,
  type ResourceData,
} from './common';
import { nanoBananaVersionIds } from './version-ids';

// =============================================================================
// Nano Banana Mode Constants
// =============================================================================

/** Nano Banana mode type */
export type NanoBananaMode = 'standard' | 'pro' | 'v2' | 'v2lite';

/** Map from version ID to mode name */
const versionIdToMode = new Map<number, NanoBananaMode>(
  Object.entries(nanoBananaVersionIds).map(([mode, id]) => [id, mode as NanoBananaMode])
);

/** Options for nano banana mode selector (using version IDs as values) */
const nanoBananaModeVersionOptions = [
  { label: 'Standard', value: nanoBananaVersionIds.standard },
  { label: 'Pro', value: nanoBananaVersionIds.pro },
  { label: 'V2', value: nanoBananaVersionIds.v2 },
  { label: 'V2 Lite', value: nanoBananaVersionIds.v2lite },
];

// =============================================================================
// Aspect Ratios & Resolutions
// =============================================================================

/**
 * Base aspect ratios at 1K resolution.
 * Full set supported by both `nano-banana-pro` and `nano-banana-2` per the
 * orchestrator client spec (`NanoBanana2ImageGenInput.aspectRatio`).
 */
const nanoBananaBaseAspectRatios: AspectRatioOption[] = [
  { label: '21:9', value: '21:9', width: 2520, height: 1080 },
  { label: '16:9', value: '16:9', width: 1920, height: 1080 },
  { label: '3:2', value: '3:2', width: 1620, height: 1080 },
  { label: '4:3', value: '4:3', width: 1440, height: 1080 },
  { label: '5:4', value: '5:4', width: 1350, height: 1080 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '4:5', value: '4:5', width: 1080, height: 1350 },
  { label: '3:4', value: '3:4', width: 1080, height: 1440 },
  { label: '2:3', value: '2:3', width: 1080, height: 1620 },
  { label: '9:16', value: '9:16', width: 1080, height: 1920 },
];

/** Preferred (always-visible) aspect ratios — the historical default set. */
const nanoBananaPriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

/** Resolution options for Nano Banana Pro */
const resolutionOptions = ['1K', '2K', '4K'] as const;

const resolutionMultiplier: Record<string, number> = {
  '1K': 1,
  '2K': 2,
  '4K': 4,
};

/** Get aspect ratio options scaled to the selected resolution */
function getNanoBananaAspectRatios(resolution: string): AspectRatioOption[] {
  const multiplier = resolutionMultiplier[resolution] ?? 1;
  return nanoBananaBaseAspectRatios.map((ar) => ({
    ...ar,
    width: ar.width * multiplier,
    height: ar.height * multiplier,
  }));
}

// =============================================================================
// Mode Subgraphs
// =============================================================================

/** Context shape passed to nano banana mode subgraphs */
type NanoBananaModeCtx = {
  ecosystem: string;
  workflow: string;
  model: ResourceData;
  nanoBananaMode: NanoBananaMode;
};

/** Standard mode subgraph: just seed */
const standardModeGraph = new DataGraph<NanoBananaModeCtx, GenerationCtx>().node(
  'seed',
  seedNode()
);

/** Pro mode subgraph: negativePrompt, aspectRatio, resolution, seed */
const proModeGraph = new DataGraph<NanoBananaModeCtx, GenerationCtx>()
  .merge(negativePromptGraph)
  .node('resolution', {
    input: z.enum(resolutionOptions).optional(),
    output: z.enum(resolutionOptions),
    defaultValue: '1K',
    meta: {
      options: resolutionOptions.map((r) => ({ label: r, value: r })),
    },
  })
  .node(
    'aspectRatio',
    (ctx) => {
      const resolution = (ctx as { resolution?: string }).resolution ?? '1K';
      return aspectRatioNode({
        options: getNanoBananaAspectRatios(resolution),
        defaultValue: '1:1',
        priorityOptions: nanoBananaPriorityRatios,
      });
    },
    ['resolution']
  )
  .node('seed', seedNode());

/** V2 mode subgraph: aspectRatio, resolution, enableWebSearch, seed */
const v2ModeGraph = new DataGraph<NanoBananaModeCtx, GenerationCtx>()
  .node('resolution', {
    input: z.enum(resolutionOptions).optional(),
    output: z.enum(resolutionOptions),
    defaultValue: '1K',
    meta: {
      options: resolutionOptions.map((r) => ({ label: r, value: r })),
    },
  })
  .node(
    'aspectRatio',
    (ctx) => {
      const resolution = (ctx as { resolution?: string }).resolution ?? '1K';
      return aspectRatioNode({
        options: getNanoBananaAspectRatios(resolution),
        defaultValue: '1:1',
        priorityOptions: nanoBananaPriorityRatios,
      });
    },
    ['resolution']
  )
  .node('enableWebSearch', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })
  .node('seed', seedNode());

/**
 * V2 Lite mode subgraph: aspectRatio, seed.
 * `nano-banana-2-lite` has no resolution or web-search controls, so the
 * aspect ratios stay at their 1K dimensions.
 */
const v2liteModeGraph = new DataGraph<NanoBananaModeCtx, GenerationCtx>()
  .node(
    'aspectRatio',
    aspectRatioNode({
      options: nanoBananaBaseAspectRatios,
      defaultValue: '1:1',
      priorityOptions: nanoBananaPriorityRatios,
    })
  )
  .node('seed', seedNode());

// =============================================================================
// Nano Banana Graph V2
// =============================================================================

/**
 * Nano Banana family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Uses discriminatedUnion on 'nanoBananaMode' computed from model.id:
 * - standard: seed only
 * - pro: negativePrompt, aspectRatio, resolution, seed
 * - v2: aspectRatio, resolution, enableWebSearch, seed
 */
export const nanoBananaGraph = new DataGraph<
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
        versions: { options: nanoBananaModeVersionOptions },
        defaultModelId: nanoBananaVersionIds.standard,
      }),
    []
  )
  // Computed: derive nano banana mode from model.id (version ID)
  .computed(
    'nanoBananaMode',
    (ctx): NanoBananaMode => {
      const modelId = ctx.model?.id;
      if (modelId) {
        const mode = versionIdToMode.get(modelId);
        if (mode) return mode;
      }
      return 'standard'; // Default to standard if unknown
    },
    ['model']
  )
  // Discriminated union based on nanoBananaMode
  .discriminator('nanoBananaMode', {
    standard: standardModeGraph,
    pro: proModeGraph,
    v2: v2ModeGraph,
    v2lite: v2liteModeGraph,
  })
  // Prompt + triggerWords are common to all variants. Placed at the parent
  // (after the discriminator) so model from the active branch is in ctx.
  // negativePrompt is only present in pro mode; its `createTextEditorGraph`
  // factory self-registers as a snippets target via its own effect when
  // that branch is active.
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph);

// Export mode options for use in components
export { nanoBananaModeVersionOptions, nanoBananaVersionIds };
