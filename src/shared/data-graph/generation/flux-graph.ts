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
 * The model.id directly determines the mode - no separate fluxMode node needed.
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
import { fluxModelId, fluxUltraAspectRatios } from '~/shared/constants/generation.constants';

// =============================================================================
// Flux Mode Constants
// =============================================================================

/** Flux mode version IDs */
const fluxVersionIds = {
  draft: 699279,
  standard: 691639,
  pro: 922358,
  krea: 2068000,
  ultra: 1088507,
} as const;

/** Flux ultra version ID for quick checks */
const fluxUltraVersionId = fluxVersionIds.ultra;

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
  { label: '9:16', value: '9:16', width: 768, height: 1344 },
  { label: '16:9', value: '16:9', width: 1344, height: 768 },
];

/** Ultra mode aspect ratios (higher resolution) */
const fluxUltraAspectRatioOptions = fluxUltraAspectRatios.map((ar, index) => ({
  label: ar.label,
  value: `${index}`,
  width: ar.width,
  height: ar.height,
}));

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
// Flux Graph V2
// =============================================================================

/** Type for model value from parent context */
type ModelValue = { id: number; baseModel: string; model: { type: string } } | undefined;

/**
 * Flux family controls.
 * Used for Flux.1 S, Flux.1 D, Flux.1 Krea, Flux.1 Kontext, Flux.2 D.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Note: Flux doesn't use negative prompts, samplers, or CLIP skip.
 *
 * For the standard Flux.1 model (id 618692), supports multiple modes.
 * The model.id directly determines the mode - changing it switches modes.
 * - draft, standard, pro, krea: Standard controls with cfgScale/steps
 * - ultra: High-res mode with different aspect ratios, no cfgScale/steps
 */
const fluxCheckpointGraph = createCheckpointGraph({ versions: fluxModeVersionOptions });
export const fluxGraph = new DataGraph<
  { baseModel: string; workflow: string; model: ModelValue },
  GenerationCtx
>()
  .merge(fluxCheckpointGraph)
  .node(
    'resources',
    (ctx, ext) =>
      resourcesNode({
        baseModel: ctx.baseModel,
        resourceIds: ext.resources.map((x) => x.id),
        limit: ext.limits.maxResources,
      }),
    ['baseModel']
  )
  // Computed: is this the flux standard model that supports mode switching?
  .computed('isFluxStandard', (ctx) => ctx.model?.id === fluxModelId, ['model'])
  // Computed: is this ultra mode? (affects which controls are shown)
  .computed('isFluxUltra', (ctx) => ctx.model?.id === fluxUltraVersionId, ['model'])
  // Aspect ratio - different options for ultra mode
  .node(
    'aspectRatio',
    (ctx) => {
      const isUltra = ctx.isFluxUltra;
      const options = isUltra ? fluxUltraAspectRatioOptions : fluxAspectRatios;
      const defaultValue = isUltra ? '3' : '1:1'; // Ultra: Square 1:1 (index 3), Standard: 1:1
      return aspectRatioNode({ options, defaultValue });
    },
    ['isFluxUltra']
  )
  // CFG Scale - not available in ultra mode
  .node(
    'cfgScale',
    (ctx) => ({
      ...cfgScaleNode({
        min: 2,
        max: 20,
        defaultValue: 3.5,
        presets: fluxGuidancePresets,
      }),
      when: !ctx.isFluxUltra,
    }),
    ['isFluxUltra']
  )
  // Steps - not available in ultra mode
  .node(
    'steps',
    (ctx) => ({
      ...stepsNode({ min: 20, max: 50 }),
      when: !ctx.isFluxUltra,
    }),
    ['isFluxUltra']
  )
  .node('seed', seedNode())
  .node('enhancedCompatibility', enhancedCompatibilityNode())
  // Ultra Raw mode toggle - only for ultra mode
  .node(
    'fluxUltraRaw',
    (ctx) => ({
      input: z.boolean().optional(),
      output: z.boolean(),
      defaultValue: false,
      when: ctx.isFluxUltra,
    }),
    ['isFluxUltra']
  );

// Export flux mode options for use in components that need to render a mode selector
export { fluxModeVersionOptions, fluxVersionIds };
