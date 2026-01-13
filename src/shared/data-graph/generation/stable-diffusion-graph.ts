/**
 * Stable Diffusion Family Graph V2
 *
 * Controls for SD1, SDXL, Pony, Illustrious, NoobAI ecosystems.
 * Meta contains only dynamic props - static props defined in components.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  cfgScaleNode,
  clipSkipNode,
  createCheckpointGraph,
  denoiseNode,
  enhancedCompatibilityNode,
  negativePromptNode,
  resourcesNode,
  samplerNode,
  seedNode,
  stepsNode,
  vaeNode,
} from './common';

// =============================================================================
// Aspect Ratios
// =============================================================================

/** Default aspect ratio options for SD family models */
const sdAspectRatios = [
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
];

/** SD1-specific aspect ratios (smaller dimensions) */
const sd1AspectRatios = [
  { label: '2:3', value: '2:3', width: 512, height: 768 },
  { label: '1:1', value: '1:1', width: 512, height: 512 },
  { label: '3:2', value: '3:2', width: 768, height: 512 },
];

// =============================================================================
// Stable Diffusion Graph V2
// =============================================================================

/** Workflows that require the denoise node */
const workflowsWithDenoise = [
  'txt2img:face-fix',
  'txt2img:hires-fix',
  'img2img',
  'img2img:face-fix',
  'img2img:hires-fix',
];

/**
 * Stable Diffusion family controls.
 * Used for SD1, SDXL, Pony, Illustrious, NoobAI ecosystems.
 *
 * Meta only contains dynamic props - static props like label are in components.
 */
const checkpointGraph = createCheckpointGraph();
export const stableDiffusionGraph = new DataGraph<
  { baseModel: string; workflow: string },
  GenerationCtx
>()
  .merge(checkpointGraph)
  .node(
    'resources',
    (ctx, ext) =>
      resourcesNode({
        baseModel: ctx.baseModel,
        resourceIds: ext.resources.map((x) => x.id),
        limit: ext.limits.maxResources,
      }),
    ['baseModel']
  )
  .node(
    'vae',
    (ctx, ext) =>
      vaeNode({
        baseModel: ctx.baseModel,
        resourceIds: ext.resources.map((x) => x.id),
      }),
    ['baseModel']
  )
  .node(
    'aspectRatio',
    (ctx) => {
      const options = ctx.baseModel === 'SD1' ? sd1AspectRatios : sdAspectRatios;
      return aspectRatioNode({ options });
    },
    ['baseModel']
  )
  .node('negativePrompt', negativePromptNode())
  .node('sampler', samplerNode())
  .node('cfgScale', cfgScaleNode())
  .node('steps', stepsNode())
  .node('clipSkip', clipSkipNode())
  .node('seed', seedNode())
  .node('enhancedCompatibility', enhancedCompatibilityNode())
  // Denoise is only shown for specific workflows (face-fix, hires-fix, img2img variants)
  .node(
    'denoise',
    (ctx) => ({
      ...denoiseNode(),
      when: workflowsWithDenoise.includes(ctx.workflow),
    }),
    ['workflow']
  );
