/**
 * LTXV2 Graph
 *
 * Controls for LTX Video 2 generation ecosystem.
 * Advanced video generation model from Lightricks.
 *
 * Workflows:
 * - txt2vid: Text to video generation
 * - img2vid: Image to video with optional source image
 * - img2vid:ref2vid: First/last frame guided video generation
 *
 * Nodes:
 * - images: Workflow-dependent image input
 * - seed: Optional seed for reproducibility
 * - aspectRatio: Output aspect ratio
 * - cfgScale: CFG scale for generation control
 * - duration: Video duration
 * - steps: Number of inference steps
 * - frameGuideStrength: Frame guide conditioning strength (ref2vid only)
 * - resources: Additional LoRAs
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  seedNode,
  aspectRatioNode,
  sliderNode,
  enumNode,
  imagesNode,
  createResourcesGraph,
  createCheckpointGraph,
} from './common';
import { isWorkflowOrVariant } from './config/workflows';

// =============================================================================
// Constants
// =============================================================================

/** LTXV2 model version options */
const ltxv2VersionOptions = [
  { label: '19B Dev', value: 2578325 },
  { label: '19B Distilled', value: 2600562 },
];

/** LTXV2 distilled model version ID */
const ltxv2DistilledId = 2600562;

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
 * Workflow-specific behavior:
 * - txt2vid: Text to video with optional LoRA support
 * - img2vid: First/last frame guided generation with frameGuideStrength
 */
export const ltxv2Graph = new DataGraph<LTXV2Ctx, GenerationCtx>()
  // Images node - first/last frame slots for img2vid, hidden for txt2vid
  .node(
    'images',
    (ctx) => {
      if (isWorkflowOrVariant(ctx.workflow, 'img2vid')) {
        return {
          ...imagesNode({
            slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame (optional)' }],
            warnOnMissingAiMetadata: true,
            aspectRatios: ltxv2AspectRatios.map((a) => a.value as `${number}:${number}`),
          }),
          when: true,
        };
      }
      return { ...imagesNode(), when: false };
    },
    ['workflow']
  )

  // Merge checkpoint graph with version options
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: ltxv2VersionOptions },
        defaultModelId: ltxv2VersionOptions[0].value,
      }),
    []
  )

  // Seed node
  .node('seed', seedNode())

  // Aspect ratio node - hidden for img2vid (aspect ratio is determined by uploaded images)
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: ltxv2AspectRatios, defaultValue: '16:9' }),
      when: ctx.workflow !== 'img2vid',
    }),
    ['workflow']
  )

  // CFG scale node - hidden for distilled models
  .node(
    'cfgScale',
    (ctx) => ({
      ...sliderNode({
        min: 1,
        max: 10,
        step: 0.5,
        defaultValue: 3,
        presets: [
          { label: 'Low', value: 2 },
          { label: 'Balanced', value: 3 },
          { label: 'High', value: 5 },
        ],
      }),
      when: ctx.model?.id !== ltxv2DistilledId,
    }),
    ['model']
  )

  // Duration node
  .node('duration', enumNode({ options: ltxv2Durations, defaultValue: 5 }))

  // Steps node - hidden for distilled models
  .node(
    'steps',
    (ctx) => ({
      ...sliderNode({
        min: 10,
        max: 50,
        defaultValue: 30,
        presets: [
          { label: 'Fast', value: 20 },
          { label: 'Balanced', value: 30 },
          { label: 'Quality', value: 50 },
        ],
      }),
      when: ctx.model?.id !== ltxv2DistilledId,
    }),
    ['model']
  )

  // Frame guide strength - img2vid only (first/last frame conditioning)
  .node(
    'frameGuideStrength',
    (ctx) => ({
      ...sliderNode({
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 1,
        presets: [
          { label: 'Subtle', value: 0.3 },
          { label: 'Moderate', value: 0.6 },
          { label: 'Strong', value: 1 },
        ],
      }),
      when: isWorkflowOrVariant(ctx.workflow, 'img2vid') && ctx.images?.length === 2, // Only show if both first and last frames are provided
    }),
    ['workflow']
  )

  // Resources node (LoRAs)
  .merge(createResourcesGraph());

// Export constants for use in components
export { ltxv2AspectRatios, ltxv2Durations };
