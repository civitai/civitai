/**
 * Flux.1 Kontext Family Graph V2
 *
 * Controls for Flux1Kontext ecosystem.
 * Meta contains only dynamic props - static props defined in components.
 *
 * Flux.1 Kontext modes:
 * - pro: Standard Kontext generation
 * - max: Premium mode with best quality
 *
 * Note: Flux Kontext is primarily an img2img model that requires a source image.
 * No LoRA support, no negative prompts, samplers, steps, or CLIP skip.
 * Supports CFG scale (guidance), aspect ratio, and seed.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  cfgScaleNode,
  createCheckpointGraph,
  imagesNode,
  seedNode,
} from './common';

// =============================================================================
// Flux Kontext Mode Constants
// =============================================================================

/** Flux Kontext mode type */
export type FluxKontextMode = 'pro' | 'max';

/** Flux Kontext mode version IDs */
const fluxKontextVersionIds = {
  pro: 1892509,
  max: 1892523,
} as const;

/** Map from version ID to mode name */
const versionIdToMode = new Map<number, FluxKontextMode>(
  Object.entries(fluxKontextVersionIds).map(([mode, id]) => [id, mode as FluxKontextMode])
);

/** Options for flux kontext mode selector (using version IDs as values) */
const fluxKontextModeVersionOptions = [
  { label: 'Pro', value: fluxKontextVersionIds.pro },
  { label: 'Max', value: fluxKontextVersionIds.max },
];

// =============================================================================
// Aspect Ratios
// =============================================================================

/** Flux Kontext aspect ratios (matches source image when possible) */
const fluxKontextAspectRatios = [
  { label: '21:9', value: '21:9', width: 2352, height: 1008 },
  { label: '16:9', value: '16:9', width: 1792, height: 1008 },
  { label: '4:3', value: '4:3', width: 1344, height: 1008 },
  { label: '3:2', value: '3:2', width: 1512, height: 1008 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '2:3', value: '2:3', width: 1008, height: 1512 },
  { label: '3:4', value: '3:4', width: 1008, height: 1344 },
  { label: '9:16', value: '9:16', width: 1008, height: 1792 },
  { label: '9:21', value: '9:21', width: 1008, height: 2352 },
];

// =============================================================================
// Flux Kontext Graph V2
// =============================================================================

/**
 * Flux.1 Kontext family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Note: Flux Kontext doesn't use LoRAs, negative prompts, samplers, steps, or CLIP skip.
 */
export const fluxKontextGraph = new DataGraph<
  { ecosystem: string; workflow: string },
  GenerationCtx
>()
  // Images node - shown for img2img variants, hidden for txt2img
  .node(
    'images',
    (ctx) => ({
      ...imagesNode(),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  // Merge checkpoint graph with version options
  .merge(
    () =>
      createCheckpointGraph({
        versions: fluxKontextModeVersionOptions,
        defaultModelId: fluxKontextVersionIds.pro,
      }),
    []
  )
  .node('aspectRatio', aspectRatioNode({ options: fluxKontextAspectRatios, defaultValue: '1:1' }))
  .node(
    'cfgScale',
    cfgScaleNode({
      min: 2,
      max: 20,
      defaultValue: 3.5,
    })
  )
  .node('seed', seedNode());

// Export mode options for use in components
export { fluxKontextModeVersionOptions, fluxKontextVersionIds };
