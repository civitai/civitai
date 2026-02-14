/**
 * LTXV2 Graph
 *
 * Controls for LTX Video 2 generation ecosystem.
 * Advanced video generation model from Lightricks.
 *
 * Nodes:
 * - seed: Optional seed for reproducibility
 * - aspectRatio: Output aspect ratio
 * - cfgScale: CFG scale for generation control
 * - duration: Video duration
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
  imagesNode,
  resourcesNode,
  createCheckpointGraph,
} from './common';

// =============================================================================
// Constants
// =============================================================================

/** LTXV2 aspect ratio options */
const ltxv2AspectRatios = [
  { label: '16:9', value: '16:9', width: 848, height: 480 },
  { label: '3:2', value: '3:2', width: 720, height: 480 },
  { label: '1:1', value: '1:1', width: 512, height: 512 },
  { label: '2:3', value: '2:3', width: 480, height: 720 },
  { label: '9:16', value: '9:16', width: 480, height: 848 },
];

/** LTXV2 duration options */
const ltxv2Durations = [
  { label: '3 seconds', value: 3 },
  { label: '5 seconds', value: 5 },
  { label: '7 seconds', value: 7 },
];

// =============================================================================
// LTXV2 Graph
// =============================================================================

/** Context shape for LTXV2 graph */
type LTXV2Ctx = { ecosystem: string; workflow: string };

/**
 * LTXV2 video generation controls.
 *
 * Txt2vid with optional LoRA support.
 */
export const ltxv2Graph = new DataGraph<LTXV2Ctx, GenerationCtx>()
  // Images node - shown for img2vid, hidden for txt2vid
  .node(
    'images',
    (ctx) => ({
      ...imagesNode(),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )

  // Merge checkpoint graph (model node with locked model from ecosystem settings)
  .merge(createCheckpointGraph())

  // Seed node
  .node('seed', seedNode())

  // Aspect ratio node
  .node('aspectRatio', aspectRatioNode({ options: ltxv2AspectRatios, defaultValue: '16:9' }))

  // CFG scale node
  .node(
    'cfgScale',
    cfgScaleNode({
      min: 1,
      max: 10,
      step: 0.5,
      defaultValue: 3,
      presets: [
        { label: 'Low', value: 2 },
        { label: 'Balanced', value: 3 },
        { label: 'High', value: 5 },
      ],
    })
  )

  // Duration node
  .node('duration', enumNode({ options: ltxv2Durations, defaultValue: 5 }))

  // Steps node
  .node(
    'steps',
    stepsNode({
      min: 10,
      max: 50,
      step: 1,
      defaultValue: 30,
      presets: [
        { label: 'Fast', value: 20 },
        { label: 'Balanced', value: 30 },
        { label: 'Quality', value: 50 },
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
export { ltxv2AspectRatios, ltxv2Durations };
