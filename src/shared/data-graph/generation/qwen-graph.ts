/**
 * Qwen Family Graph V2
 *
 * Controls for Qwen ecosystem.
 * Meta contains only dynamic props - static props defined in components.
 *
 * Supports txt2img and img2img:edit workflows with model version selection.
 * Model versions differ per workflow:
 * - txt2img: v2509, v2512 (default)
 * - img2img:edit: v2509, v2511
 *
 * Note: Qwen doesn't use negative prompts, samplers, or CLIP skip.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  cfgScaleNode,
  createCheckpointGraph,
  enhancedCompatibilityNode,
  imagesNode,
  resourcesNode,
  seedNode,
  stepsNode,
} from './common';

// =============================================================================
// Model Versions
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
    versions: qwenTxt2ImgVersionOptions,
    defaultModelId: qwenVersionIds.txt2img_v2512,
  },
  'img2img:edit': {
    versions: qwenImg2ImgVersionOptions,
    defaultModelId: qwenVersionIds.img2img_v2511,
  },
};

// =============================================================================
// Aspect Ratios
// =============================================================================

/** Qwen aspect ratios (1024px based) */
const qwenAspectRatios = [
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
];

// =============================================================================
// Qwen Graph V2
// =============================================================================

/**
 * Qwen family controls.
 *
 * Meta only contains dynamic props - static props like label are in components.
 * Note: Qwen doesn't use negative prompts, samplers, or CLIP skip.
 */
export const qwenGraph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  // Merge checkpoint graph with workflow-specific versions
  // modelLocked: true ensures stale stored values are forced to valid version IDs
  // Automatically syncs model version when workflow changes (txt2img ↔ img2img:edit)
  .merge(
    (ctx) =>
      createCheckpointGraph({
        workflowVersions: qwenWorkflowVersions,
        currentWorkflow: ctx.workflow,
        modelLocked: true,
      }),
    ['workflow']
  )
  // Images node - shown for img2img variants, hidden for txt2img
  .node(
    'images',
    (ctx) => ({
      ...imagesNode(),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  .node(
    'resources',
    (ctx, ext) =>
      resourcesNode({
        ecosystem: ctx.ecosystem,
        limit: ext.limits.maxResources,
      }),
    ['ecosystem']
  )
  .node('aspectRatio', aspectRatioNode({ options: qwenAspectRatios, defaultValue: '1:1' }))
  .node(
    'cfgScale',
    cfgScaleNode({
      min: 2,
      max: 20,
      defaultValue: 3.5,
    })
  )
  .node('steps', stepsNode({ min: 20, max: 50 }))
  .node('seed', seedNode())
  .node('enhancedCompatibility', enhancedCompatibilityNode());
