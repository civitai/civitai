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
  controlNetsNode,
  CONTROLNET_LIMIT,
  createCheckpointGraph,
  createResourcesGraph,
  createVaeGraph,
  imagesNode,
  negativePromptGraph,
  promptGraph,
  snippetsGraph,
  samplerNode,
  seedNode,
  sliderNode,
  triggerWordsGraph,
} from './common';
import {
  sdxlAspectRatioBuckets,
  sd1AspectRatioBuckets,
} from '~/shared/constants/generation.constants';
import {
  sd1ControlNetPreprocessors,
  sdxlControlNetPreprocessors,
} from '~/shared/constants/controlnets.constants';

// =============================================================================
// Constants
// =============================================================================

/** Maximum output resolution (longest side) for hires fix upscaling */
const MAX_UPSCALE_RESOLUTION = 4096;

// =============================================================================
// Stable Diffusion Graph V2
// =============================================================================

/** Workflows that always show the denoise node (regardless of images) */
const DENOISE_ALWAYS = [
  'img2img',
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
  .merge(createResourcesGraph())
  .merge(createVaeGraph())
  .node(
    'aspectRatio',
    (ctx) => {
      const options = ctx.ecosystem === 'SD1' ? sd1AspectRatioBuckets : sdxlAspectRatioBuckets;
      const hasImages = Array.isArray(ctx.images) && ctx.images.length > 0;
      return { ...aspectRatioNode({ options }), when: !hasImages };
    },
    ['ecosystem', 'images']
  )
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .merge(negativePromptGraph)
  .node('sampler', samplerNode())
  .node(
    'cfgScale',
    sliderNode({
      min: 1,
      max: 10,
      step: 0.5,
      defaultValue: 7,
      presets: [
        { label: 'Creative', value: 4 },
        { label: 'Balanced', value: 7 },
        { label: 'Precise', value: 10 },
      ],
    })
  )
  .node(
    'steps',
    sliderNode({
      min: 10,
      max: 50,
      defaultValue: 30,
      presets: [
        { label: 'Fast', value: 20 },
        { label: 'Balanced', value: 30 },
        { label: 'High', value: 40 },
      ],
    })
  )
  .node('clipSkip', sliderNode({ min: 1, max: 3, defaultValue: 2 }))
  // ControlNets — SD1 has its own preprocessor list; SDXL/Pony/Illustrious/NoobAI/SDXLDistilled share SDXL's.
  // Only available for txt2img workflows.
  .node(
    'controlNets',
    (ctx) => {
      const preprocessors =
        ctx.ecosystem === 'SD1' ? sd1ControlNetPreprocessors : sdxlControlNetPreprocessors;
      return {
        ...controlNetsNode({ preprocessors, limit: CONTROLNET_LIMIT }),
        // Disabled for now (was: ctx.workflow === 'txt2img').
        when: false,
      };
    },
    ['ecosystem', 'workflow']
  )
  .node('seed', seedNode())
  // Denoise is shown for face-fix/hires-fix (always) or img2img/txt2img when images are present
  // Max is 0.75 when no images (text-only), 1.0 when images are present
  .node(
    'denoise',
    (ctx) => {
      const hasImages = Array.isArray(ctx.images) && ctx.images.length > 0;
      const alwaysShow = DENOISE_ALWAYS.includes(ctx.workflow);
      const showForTxt2imgImages = ctx.workflow === 'txt2img' && hasImages;
      // img2img always shows denoise (included in DENOISE_ALWAYS); use max 1 to prevent value resets
      const isImg2Img = ctx.workflow === 'img2img';
      const max = alwaysShow || isImg2Img || hasImages ? 1 : 0.75;
      return {
        ...sliderNode({ min: 0, max, step: 0.01, defaultValue: 0.75 }),
        when: alwaysShow || showForTxt2imgImages,
      };
    },
    ['workflow', 'images']
  )
  // Computed upscale dimensions for hires-fix workflows.
  // Derived from the source image (img2img) or aspect ratio (txt2img) dimensions,
  // scaled 1.5× clamped so the longest side doesn't exceed MAX_UPSCALE_RESOLUTION.
  .computed(
    'upscaleWidth',
    (ctx) => {
      if (!ctx.workflow.includes('hires')) return undefined;
      const w = ctx.images?.[0]?.width ?? ctx.aspectRatio?.width;
      const h = ctx.images?.[0]?.height ?? ctx.aspectRatio?.height;
      if (!w || !h) return undefined;
      const scale =
        Math.max(w, h) * 1.5 <= MAX_UPSCALE_RESOLUTION
          ? 1.5
          : MAX_UPSCALE_RESOLUTION / Math.max(w, h);
      return Math.round(w * scale);
    },
    ['workflow', 'images', 'aspectRatio']
  )
  .computed(
    'upscaleHeight',
    (ctx) => {
      if (!ctx.workflow.includes('hires')) return undefined;
      const w = ctx.images?.[0]?.width ?? ctx.aspectRatio?.width;
      const h = ctx.images?.[0]?.height ?? ctx.aspectRatio?.height;
      if (!w || !h) return undefined;
      const scale =
        Math.max(w, h) * 1.5 <= MAX_UPSCALE_RESOLUTION
          ? 1.5
          : MAX_UPSCALE_RESOLUTION / Math.max(w, h);
      return Math.round(h * scale);
    },
    ['workflow', 'images', 'aspectRatio']
  );
