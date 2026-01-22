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
  cfgScaleNode,
  createCheckpointGraph,
  enhancedCompatibilityNode,
  resourcesNode,
  seedNode,
  stepsNode,
} from './common';

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

/** Standard Flux aspect ratios (1024px based) */
const fluxAspectRatios = [
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
  // { label: '9:16', value: '9:16', width: 768, height: 1344 },
  // { label: '16:9', value: '16:9', width: 1344, height: 768 },
];

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

/** Type for model value from parent context */
type ModelValue = { id: number; baseModel: string; model: { id: number; type: string } } | undefined;

/** Context shape passed to flux mode subgraphs */
type FluxModeCtx = { baseModel: string; workflow: string; model: ModelValue; fluxMode: FluxMode };

/**
 * Subgraph with common nodes for standard-like modes.
 * Contains: aspectRatio, cfgScale, steps, seed, enhancedCompatibility
 */
const standardModeBaseGraph = new DataGraph<FluxModeCtx, GenerationCtx>()
  .node('aspectRatio', aspectRatioNode({ options: fluxAspectRatios, defaultValue: '1:1' }))
  .node(
    'cfgScale',
    cfgScaleNode({
      min: 2,
      max: 20,
      defaultValue: 3.5,
      presets: fluxGuidancePresets,
    })
  )
  .node('steps', stepsNode({ min: 20, max: 50 }))
  .node('seed', seedNode())
  .node('enhancedCompatibility', enhancedCompatibilityNode());

/**
 * Pro mode subgraph: aspectRatio, cfgScale, steps, seed, enhancedCompatibility (no resources)
 */
const proModeGraph = new DataGraph<FluxModeCtx, GenerationCtx>().merge(standardModeBaseGraph);

/**
 * Standard/Krea mode subgraph: resources + aspectRatio, cfgScale, steps, seed, enhancedCompatibility
 */
const standardModeWithResourcesGraph = new DataGraph<FluxModeCtx, GenerationCtx>()
  .merge(standardModeBaseGraph)
  .node(
    'resources',
    (ctx, ext) =>
      resourcesNode({
        baseModel: ctx.baseModel,
        resourceIds: ext.resources?.map((x) => x.id) ?? [],
        limit: ext.limits.maxResources,
      }),
    ['baseModel']
  );

/** Draft mode subgraph: aspectRatio, seed, enhancedCompatibility */
const draftModeGraph = new DataGraph<FluxModeCtx, GenerationCtx>()
  .node('aspectRatio', aspectRatioNode({ options: fluxAspectRatios, defaultValue: '1:1' }))
  .node('seed', seedNode())
  .node('enhancedCompatibility', enhancedCompatibilityNode());

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
 * - draft: aspectRatio, seed, enhancedCompatibility
 * - standard: resources, aspectRatio, cfgScale, steps, seed, enhancedCompatibility
 * - krea: resources, aspectRatio, cfgScale, steps, seed, enhancedCompatibility
 * - pro: aspectRatio, cfgScale, steps, seed, enhancedCompatibility (no resources)
 * - ultra: aspectRatio (different options), fluxUltraRaw, seed
 *
 * Draft workflow behavior:
 * - When workflow is 'txt2img:draft', model defaults to draft version and is locked
 * - If user changes model to a non-draft version, workflow switches to txt2img
 */

export const fluxGraph = new DataGraph<
  { baseModel: string; workflow: string; model: ModelValue },
  GenerationCtx
>()
  // Merge checkpoint graph with dynamic modelLocked based on workflow
  // When workflow is 'txt2img:draft', force the model to draft version (overrides any existing value)
  // Note: showVersionSelector computed in createCheckpointGraph handles visibility based on current model
  .merge(
    (ctx) =>
      createCheckpointGraph({
        versions: fluxModeVersionOptions,
        modelLocked: ctx.workflow === 'txt2img:draft',
        defaultModelId: fluxVersionIds.standard,
      }),
    ['workflow']
  )
  // Effect 1: When workflow changes, sync model to match
  // - If workflow changed to draft but model is not draft → set model to draft
  // - If workflow changed away from draft but model is draft → set model to standard
  .effect(
    (ctx, _ext, set) => {
      const isDraftModel = ctx.model?.id === fluxVersionIds.draft;
      const isDraftWorkflow = ctx.workflow === 'txt2img:draft';

      if (isDraftWorkflow && !isDraftModel) {
        set('model', { id: fluxVersionIds.draft } as ModelValue);
      } else if (!isDraftWorkflow && isDraftModel) {
        set('model', { id: fluxVersionIds.standard } as ModelValue);
      }
    },
    ['workflow']
  )
  // Effect 2: When model changes, sync workflow to match
  // - If model changed to draft and workflow is not draft → set workflow to draft
  // - If model changed away from draft and workflow is draft → set workflow to txt2img
  //
  // Note: This effect only handles user-initiated model changes.
  // When workflow changes trigger Effect 1 to set model, we don't want Effect 2
  // to set workflow back - that would cause an infinite loop.
  // The check for consistency prevents this: if workflow already matches what
  // the model implies, no action is taken.
  .effect(
    (ctx, _ext, set) => {
      const model = ctx.model as { id?: number } | undefined;
      if (!model?.id) return;

      const isDraftModel = model.id === fluxVersionIds.draft;
      const isDraftWorkflow = ctx.workflow === 'txt2img:draft';

      // Only sync if there's an actual mismatch that needs fixing
      // This prevents loops: if Effect 1 set model to standard because workflow
      // changed to txt2img, isDraftWorkflow is already false, so no action needed
      if (isDraftModel && !isDraftWorkflow) {
        set('workflow', 'txt2img:draft');
      } else if (!isDraftModel && isDraftWorkflow) {
        set('workflow', 'txt2img');
      }
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
  });

// Export flux mode options for use in components that need to render a mode selector
export { fluxModeVersionOptions, fluxVersionIds };
