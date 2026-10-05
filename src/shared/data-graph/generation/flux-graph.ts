/**
 * Flux Family Graph V2
 *
 * Controls for Flux.1 S, Flux.1 D, Flux.1 Krea, Flux.1 Kontext, Flux.2 D ecosystems.
 * Meta contains only dynamic props - static props defined in components.
 *
 * Note: Flux doesn't use negative prompts, samplers, or CLIP skip.
 *
 * Flux Modes (for Flux.1 Standard model - id 618692):
 * - draft: Fast generation, lower quality (version 699279)
 * - standard: Default Flux.1 generation (version 691639)
 * - pro: Pro 1.1 version (version 922358)
 * - krea: Experimental Krea variant (version 2068000)
 * - ultra: High-resolution generation (version 1088507)
 *
 * Uses discriminatedUnion on 'fluxMode' to conditionally render controls per mode.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  flux1ProAspectRatioNode,
  sdxlFullAspectRatioNode,
  controlNetsNode,
  CONTROLNET_LIMIT,
  createCheckpointGraph,
  createResourcesGraph,
  promptGraph,
  seedNode,
  sliderNode,
  snippetsGraph,
  triggerWordsGraph,
  type ResourceData,
} from './common';
import { fluxControlNetPreprocessors } from '~/shared/constants/controlnets.constants';
import { DRAFT_WORKFLOW } from '~/shared/constants/generation.constants';

// =============================================================================
// Flux Mode Constants
// =============================================================================

/** Flux mode type */
export type FluxMode = 'draft' | 'standard' | 'pro' | 'krea' | 'ultra';

/** Flux mode version IDs */
const fluxVersionIds = {
  draft: 699279,
  standard: 691639,
  pro: 922358,
  krea: 2068000,
  ultra: 1088507,
} as const;

/** Map from version ID to mode name */
const versionIdToMode = new Map<number, FluxMode>(
  Object.entries(fluxVersionIds).map(([mode, id]) => [id, mode as FluxMode])
);

/** Options for flux mode selector (using version IDs as values) */
const fluxModeVersionOptions = [
  { label: 'Draft', value: fluxVersionIds.draft },
  { label: 'Standard', value: fluxVersionIds.standard },
  { label: 'Krea', value: fluxVersionIds.krea },
  { label: 'Pro 1.1', value: fluxVersionIds.pro },
  { label: 'Ultra', value: fluxVersionIds.ultra },
];

// =============================================================================
// Aspect Ratios
// =============================================================================

/** Ultra mode aspect ratios (higher resolution) */
const fluxUltraAspectRatios = [
  { label: '21:9', value: '21:9', width: 3136, height: 1344 },
  { label: '16:9', value: '16:9', width: 2752, height: 1536 },
  { label: '4:3', value: '4:3', width: 2368, height: 1792 },
  { label: '1:1', value: '1:1', width: 2048, height: 2048 },
  { label: '3:4', value: '3:4', width: 1792, height: 2368 },
  { label: '9:16', value: '9:16', width: 1536, height: 2752 },
  { label: '9:21', value: '9:21', width: 1344, height: 3136 },
];

// =============================================================================
// Flux Guidance Presets
// =============================================================================

/** Flux guidance presets */
const fluxGuidancePresets = [
  { label: 'Low', value: 2 },
  { label: 'Balanced', value: 3.5 },
  { label: 'High', value: 7 },
];

// =============================================================================
// Shared Subgraphs
// =============================================================================

/** Context shape passed to flux mode subgraphs */
type FluxModeCtx = {
  ecosystem: string;
  workflow: string;
  model: ResourceData | undefined;
  fluxMode: FluxMode;
};

/**
 * Subgraph with common nodes for standard-like modes.
 * Contains: aspectRatio, cfgScale, steps, seed
 */
const standardModeBaseGraph = new DataGraph<FluxModeCtx, GenerationCtx>()
  .node('aspectRatio', sdxlFullAspectRatioNode())
  .node(
    'cfgScale',
    sliderNode({ min: 2, max: 20, defaultValue: 3.5, step: 0.5, presets: fluxGuidancePresets })
  )
  .node('steps', sliderNode({ min: 20, max: 50, defaultValue: 25 }))
  // ControlNets — only available for txt2img workflows.
  .node(
    'controlNets',
    (ctx) => ({
      ...controlNetsNode({ preprocessors: fluxControlNetPreprocessors, limit: CONTROLNET_LIMIT }),
      when: ctx.workflow === 'txt2img',
    }),
    ['workflow']
  )
  .node('seed', seedNode());

/**
 * Pro mode subgraph: aspectRatio, cfgScale, steps, seed (no resources)
 */
const proModeGraph = new DataGraph<FluxModeCtx, GenerationCtx>()
  .node('aspectRatio', flux1ProAspectRatioNode())
  .node(
    'cfgScale',
    sliderNode({ min: 2, max: 20, defaultValue: 3.5, step: 0.5, presets: fluxGuidancePresets })
  )
  .node('steps', sliderNode({ min: 20, max: 50, defaultValue: 25 }))
  .node('seed', seedNode());

/**
 * Standard/Krea mode subgraph: resources + aspectRatio, cfgScale, steps, seed
 */
const standardModeWithResourcesGraph = new DataGraph<FluxModeCtx, GenerationCtx>()
  .merge(standardModeBaseGraph)
  .merge(createResourcesGraph());

/** Draft mode subgraph: aspectRatio, seed */
const draftModeGraph = new DataGraph<FluxModeCtx, GenerationCtx>()
  .node('aspectRatio', sdxlFullAspectRatioNode())
  .node('seed', seedNode());

/** Ultra mode subgraph: aspectRatio (different options), fluxUltraRaw, seed */
const ultraModeGraph = new DataGraph<FluxModeCtx, GenerationCtx>()
  .node('aspectRatio', aspectRatioNode({ options: fluxUltraAspectRatios, defaultValue: '1:1' }))
  .node('fluxUltraRaw', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })
  .node('seed', seedNode());

// =============================================================================
// Flux Graph V2
// =============================================================================

/**
 * Flux family controls.
 * Used for Flux.1 S, Flux.1 D, Flux.1 Krea, Flux.1 Kontext, Flux.2 D.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Note: Flux doesn't use negative prompts, samplers, or CLIP skip.
 *
 * Uses discriminatedUnion on 'fluxMode' computed from model.id:
 * - draft: aspectRatio, seed
 * - standard: resources, aspectRatio, cfgScale, steps, seed
 * - krea: resources, aspectRatio, cfgScale, steps, seed
 * - pro: aspectRatio, cfgScale, steps, seed (no resources)
 * - ultra: aspectRatio (different options), fluxUltraRaw, seed
 */

export const fluxGraph = new DataGraph<
  { ecosystem: string; workflow: string; model: ResourceData | undefined },
  GenerationCtx
>()
  .merge(
    (ctx) =>
      createCheckpointGraph({
        versions: { options: fluxModeVersionOptions },
        modelLocked: ctx.workflow === DRAFT_WORKFLOW,
      }),
    ['workflow']
  )
  // The draft build and the draft workflow move together. Order matters: on init every dep counts
  // as changed, so the draft build pulling the workflow INTO draft must run before the workflow
  // effect could swap the build out — otherwise a non-interactive submit naming the draft build
  // on txt2img is silently billed for standard.
  .effect(
    (ctx, _ext, set) => {
      if (ctx.model?.id === fluxVersionIds.draft && ctx.workflow !== DRAFT_WORKFLOW)
        set('workflow', DRAFT_WORKFLOW);
    },
    ['model']
  )
  .effect(
    (ctx, _ext, set) => {
      const isDraftModel = ctx.model?.id === fluxVersionIds.draft;
      const isDraftWorkflow = ctx.workflow === DRAFT_WORKFLOW;
      if (isDraftWorkflow && !isDraftModel)
        set('model', { id: fluxVersionIds.draft } as ResourceData);
      else if (!isDraftWorkflow && isDraftModel)
        set('model', { id: fluxVersionIds.standard } as ResourceData);
    },
    ['workflow']
  )
  .effect(
    (ctx, _ext, set) => {
      const id = ctx.model?.id;
      if (id && id !== fluxVersionIds.draft && ctx.workflow === DRAFT_WORKFLOW)
        set('workflow', 'txt2img');
    },
    ['model']
  )
  // Computed: derive flux mode from model.id (version ID)
  .computed(
    'fluxMode',
    (ctx): FluxMode => {
      const modelId = ctx.model?.id;
      if (modelId) {
        const mode = versionIdToMode.get(modelId);
        if (mode) return mode;
      }
      return 'standard'; // Default to standard if unknown
    },
    ['model']
  )
  // Discriminated union based on fluxMode
  .discriminator('fluxMode', {
    draft: draftModeGraph,
    standard: standardModeWithResourcesGraph,
    krea: standardModeWithResourcesGraph,
    pro: proModeGraph,
    ultra: ultraModeGraph,
  })
  // Prompt + triggerWords are common to all flux modes.
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph);

// Export flux mode options for use in components that need to render a mode selector
export { fluxModeVersionOptions, fluxVersionIds };
