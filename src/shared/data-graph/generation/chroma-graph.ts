/**
 * Chroma Family Graph V2
 *
 * Controls for Chroma ecosystem.
 * Meta contains only dynamic props - static props defined in components.
 *
 * Chroma is an open-source model based on Flux architecture with improved
 * color and composition capabilities.
 *
 * Note: No negative prompts or CLIP skip.
 * Supports full addon types (LoRA, DoRA, LoCon, TextualInversion).
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  createCheckpointGraph,
  createResourcesGraph,
  promptGraph,
  samplerNode,
  seedNode,
  sliderNode,
  snippetsGraph,
  triggerWordsGraph,
} from './common';
import { sdxlAspectRatioBuckets } from '~/shared/constants/generation.constants';

// =============================================================================
// Constants
// =============================================================================

/** Chroma default model version ID */
const chromaVersionId = 2164239;

// =============================================================================
// Guidance Presets
// =============================================================================

/** Chroma guidance presets */
const chromaGuidancePresets = [
  { label: 'Low', value: 2 },
  { label: 'Balanced', value: 3.5 },
  { label: 'High', value: 7 },
];

/** Chroma sampler options (Flow-compatible) */
const chromaSamplers = ['Euler', 'Euler a', 'DPM++ SDE', 'DPM++ 2M Karras', 'DPM++ SDE Karras'];

// =============================================================================
// Chroma Graph V2
// =============================================================================

/**
 * Chroma family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Note: Chroma doesn't use negative prompts, samplers, or CLIP skip.
 */
export const chromaGraph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  // Merge checkpoint graph
  .merge(
    () =>
      createCheckpointGraph({
        defaultModelId: chromaVersionId,
      }),
    []
  )
  .merge(createResourcesGraph())
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .node('aspectRatio', aspectRatioNode({ options: sdxlAspectRatioBuckets, defaultValue: '1:1' }))
  .node('sampler', samplerNode({ options: chromaSamplers, defaultValue: 'Euler' }))
  .node(
    'cfgScale',
    sliderNode({ min: 1, max: 20, defaultValue: 3.5, step: 0.5, presets: chromaGuidancePresets })
  )
  .node('steps', sliderNode({ min: 4, max: 50, defaultValue: 25 }))
  .node('seed', seedNode());
