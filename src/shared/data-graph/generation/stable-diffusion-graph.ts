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
  imagesNode,
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

/** Workflows that always show the denoise node (regardless of images) */
const DENOISE_ALWAYS = [
  'txt2img:face-fix',
  'img2img:face-fix',
  'txt2img:hires-fix',
  'img2img:hires-fix',
];

/**
 * Stable Diffusion family controls.
 * Used for SD1, SDXL, Pony, Illustrious, NoobAI ecosystems.
 *
 * Meta only contains dynamic props - static props like label are in components.
 */
export const stableDiffusionGraph = new DataGraph<
  { ecosystem: string; workflow: string },
  GenerationCtx
>()
  // Merge checkpoint graph (includes model node and ecosystem sync effect)
  .merge(createCheckpointGraph())
  // Images node - shown for img2img variants (required), hidden for all txt variants
  .node(
    'images',
    (ctx) => ({
      ...imagesNode(),
      when: ctx.workflow.startsWith('img2img'),
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
  .node('vae', (ctx) => vaeNode({ ecosystem: ctx.ecosystem }), ['ecosystem'])
  .node(
    'aspectRatio',
    (ctx) => {
      const options = ctx.ecosystem === 'SD1' ? sd1AspectRatios : sdAspectRatios;
      const hasImages = Array.isArray(ctx.images) && ctx.images.length > 0;
      return { ...aspectRatioNode({ options }), when: !hasImages };
    },
    ['ecosystem', 'images']
  )
  .node('negativePrompt', negativePromptNode())
  .node('sampler', samplerNode())
  .node('cfgScale', cfgScaleNode())
  .node('steps', stepsNode())
  .node('clipSkip', clipSkipNode())
  .node('seed', seedNode())
  .node('enhancedCompatibility', enhancedCompatibilityNode())
  // Denoise is shown for face-fix/hires-fix (always) or img2img/txt2img when images are present
  // Max is 0.75 when no images (text-only), 1.0 when images are present
  .node(
    'denoise',
    (ctx) => {
      const hasImages = Array.isArray(ctx.images) && ctx.images.length > 0;
      const alwaysShow = DENOISE_ALWAYS.includes(ctx.workflow);
      const showForImages = (ctx.workflow === 'txt2img' || ctx.workflow === 'img2img') && hasImages;
      const max = hasImages ? 1 : 0.75;
      return {
        ...denoiseNode({ max }),
        when: alwaysShow || showForImages,
      };
    },
    ['workflow', 'images']
  );
