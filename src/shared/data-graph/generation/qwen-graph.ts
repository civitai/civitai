/**
 * Qwen Family Graph
 *
 * Controls for Qwen and Qwen 2 ecosystems.
 * Uses ecosystem discriminator to select between Qwen and Qwen 2 subgraphs.
 *
 * Qwen (sdcpp engine):
 * - Supports txt2img and img2img:edit workflows with model version selection
 * - Model versions differ per workflow: txt2img (v2509, v2512), img2img:edit (v2509, v2511)
 * - Nodes: aspectRatio, cfgScale, steps, seed, resources
 *
 * Qwen 2 (fal engine):
 * - Supports txt2img and img2img:edit workflows with locked model
 * - Nodes: aspectRatio (mapped to imageSize in handler), seed, enablePromptExpansion
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  createCheckpointGraph,
  imagesNode,
  negativePromptNode,
  resourcesNode,
  seedNode,
  sliderNode,
} from './common';

// =============================================================================
// Qwen Constants
// =============================================================================

/** Qwen model version IDs */
const qwenVersionIds = {
  txt2img_v2509: 2110043,
  txt2img_v2512: 2552908,
  img2img_v2509: 2133258,
  img2img_v2511: 2558804,
} as const;

/** Version options for txt2img workflow */
const qwenTxt2ImgVersionOptions = [
  { label: 'v2509', value: qwenVersionIds.txt2img_v2509 },
  { label: 'v2512', value: qwenVersionIds.txt2img_v2512 },
];

/** Version options for img2img:edit workflow */
const qwenImg2ImgVersionOptions = [
  { label: 'v2509', value: qwenVersionIds.img2img_v2509 },
  { label: 'v2511', value: qwenVersionIds.img2img_v2511 },
];

/** Workflow-specific version configuration */
const qwenWorkflowVersions = {
  txt2img: {
    versions: { options: qwenTxt2ImgVersionOptions },
    defaultModelId: qwenVersionIds.txt2img_v2512,
  },
  'img2img:edit': {
    versions: { options: qwenImg2ImgVersionOptions },
    defaultModelId: qwenVersionIds.img2img_v2511,
  },
};

/** Qwen aspect ratios (1024px based) */
const qwenAspectRatios = [
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
];

// =============================================================================
// Qwen 2 Constants
// =============================================================================

/** Qwen 2 aspect ratios (2048px based, mapped to imageSize enum in the handler) */
const qwen2AspectRatios = [
  { label: '16:9', value: '16:9', width: 2048, height: 1152 },
  { label: '4:3', value: '4:3', width: 2048, height: 1536 },
  { label: '1:1', value: '1:1', width: 2048, height: 2048 },
  { label: '3:4', value: '3:4', width: 1536, height: 2048 },
  { label: '9:16', value: '9:16', width: 1152, height: 2048 },
];

// =============================================================================
// Types
// =============================================================================

type QwenCtx = { ecosystem: string; workflow: string };

// =============================================================================
// Qwen Subgraph (sdcpp engine)
// =============================================================================

const qwenSubGraph = new DataGraph<QwenCtx, GenerationCtx>()
  .merge(
    (ctx) =>
      createCheckpointGraph({
        workflowVersions: qwenWorkflowVersions,
        currentWorkflow: ctx.workflow,
      }),
    ['workflow']
  )
  .node(
    'resources',
    (_ctx, ext) =>
      resourcesNode({
        ecosystem: 'Qwen',
        limit: ext.limits.maxResources,
      }),
    []
  )
  .node('aspectRatio', aspectRatioNode({ options: qwenAspectRatios, defaultValue: '1:1' }))
  .node('cfgScale', sliderNode({ min: 2, max: 20, defaultValue: 3.5, step: 0.5 }))
  .node('steps', sliderNode({ min: 20, max: 50, defaultValue: 25 }));

// =============================================================================
// Qwen 2 Subgraph (fal engine)
// =============================================================================

const qwen2SubGraph = new DataGraph<QwenCtx, GenerationCtx>()
  .merge(() => createCheckpointGraph(), [])
  .node('aspectRatio', aspectRatioNode({ options: qwen2AspectRatios, defaultValue: '1:1' }))
  .node('negativePrompt', negativePromptNode());

// =============================================================================
// Qwen Family Graph
// =============================================================================

/**
 * Qwen family controls.
 *
 * Shared nodes (images, seed) defined at this level.
 * Ecosystem discriminator selects Qwen or Qwen 2 subgraph for ecosystem-specific nodes.
 */
export const qwenGraph = new DataGraph<QwenCtx, GenerationCtx>()
  // Images node - shown for img2img variants, hidden for txt2img
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ max: 3 }),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )

  // Seed - shared across both ecosystems
  .node('seed', seedNode())

  // Discriminate between Qwen and Qwen 2
  .discriminator('ecosystem', {
    Qwen: qwenSubGraph,
    Qwen2: qwen2SubGraph,
  });

// Export constants for use in components and handlers
export { qwenAspectRatios, qwen2AspectRatios };
