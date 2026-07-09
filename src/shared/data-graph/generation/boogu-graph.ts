/**
 * Boogu Family Graph
 *
 * Controls for the Boogu ecosystem (Boogu-Image-0.1, comfy engine).
 * One ecosystem, three checkpoints selected per workflow and discriminated on
 * model.id into base / turbo / edit modes:
 *  - Base  (txt2img):      full steps/cfg
 *  - Turbo (txt2img):      distilled — few steps, low cfg
 *  - Edit  (img2img:edit): takes source image(s)
 *
 * Built on Qwen3-VL-8B + FLUX.1-dev. Supports community LoRAs.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  createCheckpointGraph,
  createResourcesGraph,
  imagesNode,
  negativePromptGraph,
  promptGraph,
  seedNode,
  sliderNode,
  snippetsGraph,
  triggerWordsGraph,
  type ResourceData,
} from './common';
import { sdxlAspectRatioBuckets } from '~/shared/constants/generation.constants';

// =============================================================================
// Boogu Constants
// =============================================================================

/** Boogu mode type */
export type BooguMode = 'base' | 'turbo' | 'edit';

/** Boogu model version IDs (CivitaiOfficial Boogu-Image-0.1 checkpoints) */
const booguVersionIds = {
  base: 3049541,
  turbo: 3050010,
  edit: 3049824,
} as const;

/** Map from version ID to mode name */
const versionIdToMode = new Map<number, BooguMode>(
  Object.entries(booguVersionIds).map(([mode, id]) => [id, mode as BooguMode])
);

/** Version options for txt2img workflow (Base + Turbo) */
const booguTxt2ImgVersionOptions = [
  { label: 'Base', value: booguVersionIds.base },
  { label: 'Turbo', value: booguVersionIds.turbo },
];

/** Version options for img2img:edit workflow (Edit only) */
const booguEditVersionOptions = [{ label: 'Edit', value: booguVersionIds.edit }];

/** Workflow-specific version configuration */
const booguWorkflowVersions = {
  txt2img: {
    versions: { options: booguTxt2ImgVersionOptions },
    defaultModelId: booguVersionIds.base,
  },
  'img2img:edit': {
    versions: { options: booguEditVersionOptions },
    defaultModelId: booguVersionIds.edit,
  },
};

// =============================================================================
// Mode Subgraphs
// =============================================================================

/** Context shape passed to boogu mode subgraphs */
type BooguModeCtx = {
  ecosystem: string;
  workflow: string;
  model: ResourceData;
  booguMode: BooguMode;
};

/**
 * Base mode subgraph: full controls (cfg 1-8, steps up to 50).
 * Defaults live on each subgraph's sliderNode — zod clamps across variants,
 * so no `.effect()` reset is needed (and Boogu is in TURBO_VARIANT_ECOSYSTEMS,
 * which scopes cfgScale/steps per model.id so Turbo and Base don't trample).
 */
const baseModeGraph = new DataGraph<BooguModeCtx, GenerationCtx>()
  .merge(createResourcesGraph())
  .merge(negativePromptGraph)
  .node('aspectRatio', aspectRatioNode({ options: sdxlAspectRatioBuckets, defaultValue: '1:1' }))
  .node('cfgScale', sliderNode({ min: 1, max: 8, step: 0.5, defaultValue: 4 }))
  .node('steps', sliderNode({ min: 1, max: 50, defaultValue: 35 }));

/** Turbo mode subgraph: distilled — few steps, low cfg. */
const turboModeGraph = new DataGraph<BooguModeCtx, GenerationCtx>()
  .merge(createResourcesGraph())
  .node('aspectRatio', aspectRatioNode({ options: sdxlAspectRatioBuckets, defaultValue: '1:1' }))
  .node('cfgScale', sliderNode({ min: 1, max: 2, step: 0.1, defaultValue: 1 }))
  .node('steps', sliderNode({ min: 1, max: 12, defaultValue: 4 }));

/** Edit mode subgraph: full controls; source image taken via the root images node. */
const editModeGraph = new DataGraph<BooguModeCtx, GenerationCtx>()
  .merge(createResourcesGraph())
  .merge(negativePromptGraph)
  .node('aspectRatio', aspectRatioNode({ options: sdxlAspectRatioBuckets, defaultValue: '1:1' }))
  .node('cfgScale', sliderNode({ min: 1, max: 8, step: 0.5, defaultValue: 5 }))
  .node('steps', sliderNode({ min: 1, max: 50, defaultValue: 35 }));

// =============================================================================
// Boogu Family Graph
// =============================================================================

/**
 * Boogu family controls.
 *
 * Checkpoint selector swaps version options per workflow (Base/Turbo on
 * txt2img, Edit on img2img:edit). `booguMode` is computed from the selected
 * model.id, then discriminated into the base/turbo/edit subgraphs.
 */
export const booguGraph = new DataGraph<
  { ecosystem: string; workflow: string; model: ResourceData },
  GenerationCtx
>()
  // Images node — shown for img2img:edit, hidden for txt2img
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ max: 1 }),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  // Checkpoint graph with per-workflow version options
  .merge(
    (ctx) =>
      createCheckpointGraph({
        workflowVersions: booguWorkflowVersions,
        currentWorkflow: ctx.workflow,
      }),
    ['workflow']
  )
  .node('seed', seedNode())
  // Computed: derive boogu mode from the selected model.id (fallback by workflow)
  .computed(
    'booguMode',
    (ctx): BooguMode => {
      const modelId = ctx.model?.id;
      if (modelId) {
        const mode = versionIdToMode.get(modelId);
        if (mode) return mode;
      }
      return ctx.workflow.startsWith('txt') ? 'base' : 'edit';
    },
    ['model', 'workflow']
  )
  // Discriminated union based on booguMode
  .discriminator('booguMode', {
    base: baseModeGraph,
    turbo: turboModeGraph,
    edit: editModeGraph,
  })
  // Prompt + triggerWords are common to all modes. negativePrompt is only in
  // base/edit branches; its registration effect self-adds to the snippets
  // target map when that branch is active.
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph);

// Export constants for use in components and handlers
export { booguVersionIds, booguTxt2ImgVersionOptions, booguEditVersionOptions };
