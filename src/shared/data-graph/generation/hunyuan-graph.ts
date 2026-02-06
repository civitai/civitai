/**
 * Hunyuan Graph
 *
 * Controls for Hunyuan video generation ecosystem.
 * Supports txt2vid workflow only (no img2vid support).
 *
 * Nodes:
 * - seed: Optional seed for reproducibility
 * - aspectRatio: Output aspect ratio
 * - cfgScale: CFG scale for generation control
 * - duration: Video duration (3 or 5 seconds)
 * - steps: Number of inference steps
 * - resources: Additional LoRAs
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  seedNode,
  aspectRatioNode,
  cfgScaleNode,
  stepsNode,
  enumNode,
  resourcesNode,
  createCheckpointGraph,
} from './common';

// =============================================================================
// Constants
// =============================================================================

/** Hunyuan aspect ratio options */
const hunyuanAspectRatios = [
  { label: '16:9', value: '16:9', width: 848, height: 480 },
  { label: '3:2', value: '3:2', width: 720, height: 480 },
  { label: '1:1', value: '1:1', width: 480, height: 480 },
  { label: '2:3', value: '2:3', width: 480, height: 720 },
  { label: '9:16', value: '9:16', width: 480, height: 848 },
];

/** Hunyuan duration options */
const hunyuanDurations = [
  { label: '3 seconds', value: 3 },
  { label: '5 seconds', value: 5 },
];

// =============================================================================
// Hunyuan Graph
// =============================================================================

/** Context shape for hunyuan graph */
type HunyuanCtx = { ecosystem: string; workflow: string };

/**
 * Hunyuan video generation controls.
 *
 * Txt2vid only - no image input support.
 * Supports LoRAs for customization.
 */
export const hunyuanGraph = new DataGraph<HunyuanCtx, GenerationCtx>()
  // Merge checkpoint graph (model node with locked model from ecosystem settings)
  .merge(createCheckpointGraph())

  // Seed node
  .node('seed', seedNode())

  // Aspect ratio node
  .node('aspectRatio', aspectRatioNode({ options: hunyuanAspectRatios, defaultValue: '1:1' }))

  // CFG scale node
  .node(
    'cfgScale',
    cfgScaleNode({
      min: 1,
      max: 10,
      step: 0.5,
      defaultValue: 6,
      presets: [
        { label: 'Low', value: 3 },
        { label: 'Balanced', value: 6 },
        { label: 'High', value: 9 },
      ],
    })
  )

  // Duration node
  .node('duration', enumNode({ options: hunyuanDurations, defaultValue: 5 }))

  // Steps node
  .node(
    'steps',
    stepsNode({
      min: 10,
      max: 30,
      step: 1,
      defaultValue: 20,
      presets: [
        { label: 'Fast', value: 10 },
        { label: 'Balanced', value: 20 },
        { label: 'Quality', value: 30 },
      ],
    })
  )

  // Resources node (LoRAs)
  .node(
    'resources',
    (ctx, ext) =>
      resourcesNode({
        ecosystem: ctx.ecosystem,
        limit: ext.limits.maxResources,
      }),
    ['ecosystem']
  );

// Export constants for use in components
export { hunyuanAspectRatios, hunyuanDurations };
