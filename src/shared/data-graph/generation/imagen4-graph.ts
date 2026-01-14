/**
 * Imagen 4 Family Graph V2
 *
 * Controls for Imagen4 ecosystem (Google).
 * Meta contains only dynamic props - static props defined in components.
 *
 * Note: No LoRA support, no samplers, CFG scale, steps, or CLIP skip.
 * Supports negative prompts, aspect ratio, and seed.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  createCheckpointGraph,
  negativePromptNode,
  seedNode,
} from './common';

// =============================================================================
// Constants
// =============================================================================

/** Imagen4 model version ID */
const imagen4VersionId = 1889632;

// =============================================================================
// Aspect Ratios
// =============================================================================

/** Imagen4 aspect ratios */
const imagen4AspectRatios = [
  { label: '16:9', value: '16:9', width: 1920, height: 1080 },
  { label: '4:3', value: '4:3', width: 1440, height: 1080 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:4', value: '3:4', width: 1080, height: 1440 },
  { label: '9:16', value: '9:16', width: 1080, height: 1920 },
];

// =============================================================================
// Imagen4 Graph V2
// =============================================================================

/**
 * Imagen4 family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Note: Imagen4 doesn't use LoRAs, samplers, CFG scale, steps, or CLIP skip.
 */
export const imagen4Graph = new DataGraph<
  { baseModel: string; workflow: string },
  GenerationCtx
>()
  // Merge checkpoint graph with model locked (single version)
  .merge(
    () =>
      createCheckpointGraph({
        modelLocked: true,
        defaultModelId: imagen4VersionId,
      }),
    []
  )
  .node('negativePrompt', negativePromptNode())
  .node('aspectRatio', aspectRatioNode({ options: imagen4AspectRatios, defaultValue: '1:1' }))
  .node('seed', seedNode());
