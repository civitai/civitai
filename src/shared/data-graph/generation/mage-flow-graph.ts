/**
 * Mage Flow Graph
 *
 * Controls for the MageFlow ecosystem (Microsoft, comfy engine).
 *
 * Generation and editing ship as separate checkpoints, so the version picker
 * swaps sets per workflow: txt2img offers the text-to-image builds,
 * img2img:edit offers the Edit builds.
 *
 * Only the RL-aligned and Turbo builds appear — the orchestrator's four models
 * (`4b`, `4b-turbo`, `4b-edit`, `4b-edit-turbo`) have no entry for upstream's
 * Base checkpoints, so those stay download-only.
 *
 * Turbo is 4-step / CFG 1 distilled and gets its own slider ranges.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  createCheckpointGraph,
  imagesNode,
  promptGraph,
  seedNode,
  sliderNode,
  snippetsGraph,
  triggerWordsGraph,
} from './common';

// =============================================================================
// Constants
// =============================================================================

/** Generatable Mage Flow model version IDs (model 2812690) */
export const mageFlowVersionIds = {
  txt2img_standard: 3172038,
  txt2img_turbo: 3172039,
  edit_standard: 3172043,
  edit_turbo: 3172044,
} as const;

const mageFlowTxt2ImgVersionOptions = [
  { label: 'Standard', value: mageFlowVersionIds.txt2img_standard },
  { label: 'Turbo', value: mageFlowVersionIds.txt2img_turbo },
];

const mageFlowEditVersionOptions = [
  { label: 'Standard', value: mageFlowVersionIds.edit_standard },
  { label: 'Turbo', value: mageFlowVersionIds.edit_turbo },
];

const mageFlowWorkflowVersions = {
  txt2img: {
    versions: { options: mageFlowTxt2ImgVersionOptions },
    defaultModelId: mageFlowVersionIds.txt2img_standard,
  },
  'img2img:edit': {
    versions: { options: mageFlowEditVersionOptions },
    defaultModelId: mageFlowVersionIds.edit_standard,
  },
};

const turboVersionIds = new Set<number>([
  mageFlowVersionIds.txt2img_turbo,
  mageFlowVersionIds.edit_turbo,
]);

/**
 * Native resolution runs 512-2048 on any aspect ratio, so the set spans wider
 * than the usual 1024 buckets - including the 4:1 / 1:4 extremes the model card
 * calls out.
 */
const mageFlowAspectRatios = [
  { label: '1:4', value: '1:4', width: 512, height: 2048 },
  { label: '9:16', value: '9:16', width: 768, height: 1344 },
  { label: '2:3', value: '2:3', width: 832, height: 1248 },
  { label: '3:4', value: '3:4', width: 896, height: 1200 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '4:3', value: '4:3', width: 1200, height: 896 },
  { label: '3:2', value: '3:2', width: 1248, height: 832 },
  { label: '16:9', value: '16:9', width: 1344, height: 768 },
  { label: '4:1', value: '4:1', width: 2048, height: 512 },
];

const mageFlowPriorityAspectRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

// =============================================================================
// Variant Subgraphs
// =============================================================================

type MageFlowVariant = 'standard' | 'turbo';

type MageFlowCtx = {
  ecosystem: string;
  workflow: string;
  mageFlowVariant: MageFlowVariant;
};

const baseVariantGraph = new DataGraph<MageFlowCtx, GenerationCtx>()
  .node(
    'aspectRatio',
    aspectRatioNode({
      options: mageFlowAspectRatios,
      defaultValue: '1:1',
      priorityOptions: mageFlowPriorityAspectRatios,
    })
  )
  .node('seed', seedNode());

const standardVariantGraph = new DataGraph<MageFlowCtx, GenerationCtx>()
  .merge(baseVariantGraph)
  .node('cfgScale', sliderNode({ min: 1, max: 10, defaultValue: 5, step: 0.5 }))
  .node('steps', sliderNode({ min: 10, max: 50, defaultValue: 30 }));

const turboVariantGraph = new DataGraph<MageFlowCtx, GenerationCtx>()
  .merge(baseVariantGraph)
  .node('cfgScale', sliderNode({ min: 1, max: 2, defaultValue: 1, step: 0.1 }))
  .node('steps', sliderNode({ min: 1, max: 12, defaultValue: 4 }));

// =============================================================================
// Mage Flow Graph
// =============================================================================

export const mageFlowGraph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ max: 3 }),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  .merge(
    (ctx) =>
      createCheckpointGraph({
        workflowVersions: mageFlowWorkflowVersions,
        currentWorkflow: ctx.workflow,
      }),
    ['workflow']
  )
  .computed(
    'mageFlowVariant',
    (ctx): MageFlowVariant =>
      ctx.model?.id && turboVersionIds.has(ctx.model.id) ? 'turbo' : 'standard',
    ['model']
  )
  .discriminator('mageFlowVariant', {
    standard: standardVariantGraph,
    turbo: turboVariantGraph,
  })
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph);

export { mageFlowAspectRatios };
