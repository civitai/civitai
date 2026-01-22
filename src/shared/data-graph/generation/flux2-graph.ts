/**
 * Flux.2 Family Graph V2
 *
 * Controls for Flux2 ecosystem.
 * Meta contains only dynamic props - static props defined in components.
 *
 * Flux.2 modes:
 * - dev: Full features with LoRA support
 * - flex: Similar to dev
 * - pro: No LoRA support
 * - max: Premium mode with best quality
 *
 * Note: Flux.2 doesn't use negative prompts, samplers, or CLIP skip.
 */

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
// Flux.2 Mode Constants
// =============================================================================

/** Flux.2 mode type */
export type Flux2Mode = 'dev' | 'flex' | 'pro' | 'max';

/** Flux.2 mode version IDs */
const flux2VersionIds = {
  dev: 2439067,
  flex: 2439047,
  pro: 2439442,
  max: 2547175,
} as const;

/** Map from version ID to mode name */
const versionIdToMode = new Map<number, Flux2Mode>(
  Object.entries(flux2VersionIds).map(([mode, id]) => [id, mode as Flux2Mode])
);

/** Options for flux2 mode selector (using version IDs as values) */
const flux2ModeVersionOptions = [
  { label: 'Dev', value: flux2VersionIds.dev },
  { label: 'Flex', value: flux2VersionIds.flex },
  { label: 'Pro', value: flux2VersionIds.pro },
  { label: 'Max', value: flux2VersionIds.max },
];

// =============================================================================
// Aspect Ratios
// =============================================================================

/** Flux.2 aspect ratios (1024px based) */
const flux2AspectRatios = [
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
];

// =============================================================================
// Flux.2 Guidance Presets
// =============================================================================

/** Flux.2 guidance presets */
const flux2GuidancePresets = [
  { label: 'Low', value: 2 },
  { label: 'Balanced', value: 3.5 },
  { label: 'High', value: 7 },
];

// =============================================================================
// Mode Subgraphs
// =============================================================================

/** Type for model value from parent context */
type ModelValue = { id: number; baseModel: string; model: { type: string } } | undefined;

/** Context shape passed to flux2 mode subgraphs */
type Flux2ModeCtx = {
  baseModel: string;
  workflow: string;
  model: ModelValue;
  flux2Mode: Flux2Mode;
};

/**
 * Base subgraph with common nodes for all modes.
 * Contains: aspectRatio, cfgScale, steps, seed, enhancedCompatibility
 */
const baseModeGraph = new DataGraph<Flux2ModeCtx, GenerationCtx>()
  .node('aspectRatio', aspectRatioNode({ options: flux2AspectRatios, defaultValue: '1:1' }))
  .node(
    'cfgScale',
    cfgScaleNode({
      min: 2,
      max: 20,
      defaultValue: 3.5,
      presets: flux2GuidancePresets,
    })
  )
  .node('steps', stepsNode({ min: 20, max: 50 }))
  .node('seed', seedNode())
  .node('enhancedCompatibility', enhancedCompatibilityNode());

/**
 * Dev mode subgraph: resources + base controls
 * Dev mode supports LoRA resources
 */
const devModeGraph = new DataGraph<Flux2ModeCtx, GenerationCtx>().merge(baseModeGraph).node(
  'resources',
  (ctx, ext) =>
    resourcesNode({
      baseModel: ctx.baseModel,
      resourceIds: ext.resources?.map((x) => x.id) ?? [],
      limit: ext.limits.maxResources,
    }),
  ['baseModel']
);

/**
 * Other modes subgraph: just base controls (no resources)
 * Flex, Pro, and Max don't support LoRA resources
 */
const noResourcesModeGraph = new DataGraph<Flux2ModeCtx, GenerationCtx>().merge(baseModeGraph);

// =============================================================================
// Flux.2 Graph V2
// =============================================================================

/**
 * Flux.2 family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Uses discriminatedUnion on 'flux2Mode' computed from model.id:
 * - dev: resources, aspectRatio, cfgScale, steps, seed, enhancedCompatibility
 * - flex/pro/max: aspectRatio, cfgScale, steps, seed, enhancedCompatibility (no resources)
 *
 * Note: Flux.2 doesn't use negative prompts, samplers, or CLIP skip.
 */
export const flux2Graph = new DataGraph<
  { baseModel: string; workflow: string; model: ModelValue },
  GenerationCtx
>()
  // Merge checkpoint graph with version options
  .merge(
    () =>
      createCheckpointGraph({
        versions: flux2ModeVersionOptions,
        defaultModelId: flux2VersionIds.dev,
      }),
    []
  )
  // Computed: derive flux2 mode from model.id (version ID)
  .computed(
    'flux2Mode',
    (ctx): Flux2Mode => {
      const modelId = ctx.model?.id;
      if (modelId) {
        const mode = versionIdToMode.get(modelId);
        if (mode) return mode;
      }
      return 'dev'; // Default to dev if unknown
    },
    ['model']
  )
  // Discriminated union based on flux2Mode
  .discriminator('flux2Mode', {
    dev: devModeGraph,
    flex: noResourcesModeGraph,
    pro: noResourcesModeGraph,
    max: noResourcesModeGraph,
  });

// Export mode options for use in components
export { flux2ModeVersionOptions, flux2VersionIds };
