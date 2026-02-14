/**
 * SD Family Ecosystem Handler
 *
 * Handles Stable Diffusion family workflows:
 * - SD1, SD2, SDXL, Pony, Illustrious, NoobAI
 *
 * Uses textToImage step type for txt2img (text only) and txt2img:draft,
 * comfy step type when images are present, or for face-fix/hires-fix workflows.
 */

import type {
  ComfyStepTemplate,
  ImageJobNetworkParams,
  Scheduler,
  TextToImageStep,
  TextToImageStepTemplate,
} from '@civitai/client';
import { samplersToSchedulers } from '~/shared/constants/generation.constants';
import { getRandomInt } from '~/utils/number-helpers';
import { maxRandomSeed } from '~/server/common/constants';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import type { GenerationHandlerCtx } from '.';
import { createComfyInput } from './comfy-input';
import { defineHandler } from './handler-factory';
import { removeEmpty } from '~/utils/object-helpers';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type SDFamilyCtx = EcosystemGraphOutput & {
  ecosystem: 'SD1' | 'SD2' | 'SDXL' | 'Pony' | 'Illustrious' | 'NoobAI';
};

// =============================================================================
// Constants
// =============================================================================

/** SD1 Draft LoRA - pre-computed AIR string */
const SD1_DRAFT_LORA = {
  id: 424706,
  air: 'urn:air:sd1:lora:civitai:424706@424706',
  strength: 1,
} as const;

/** SDXL Draft LoRA - pre-computed AIR string (also used for Pony, Illustrious, NoobAI) */
const SDXL_DRAFT_LORA = {
  id: 391999,
  air: 'urn:air:sdxl1:lora:civitai:391999@391999',
  strength: 1,
} as const;

/** Workflows that always use comfy (regardless of images) */
const COMFY_ALWAYS = [
  'txt2img:face-fix',
  'img2img:face-fix',
  'txt2img:hires-fix',
  'img2img:hires-fix',
] as const;

/**
 * Get the external comfy workflow key from the internal workflow key + images presence.
 * Returns undefined if this workflow/images combination should NOT use comfy.
 */
function getComfyKey(workflow: string, hasImages: boolean): string | undefined {
  if (hasImages) {
    switch (workflow) {
      case 'txt2img':
      case 'img2img':
        return 'img2img';
      case 'txt2img:face-fix':
      case 'img2img:face-fix':
        return 'img2img-facefix';
      case 'txt2img:hires-fix':
      case 'img2img:hires-fix':
        return 'img2img-hires';
      default:
        return undefined;
    }
  }
  switch (workflow) {
    case 'txt2img:face-fix':
    case 'img2img:face-fix':
      return 'txt2img-facefix';
    case 'txt2img:hires-fix':
    case 'img2img:hires-fix':
      return 'txt2img-hires';
    default:
      return undefined;
  }
}

// =============================================================================
// Step Input Creators
// =============================================================================

/**
 * Creates a textToImage step input for SD family.
 */
function createTextToImageInput(
  args: {
    model: ResourceData;
    resources?: ResourceData[];
    vae?: ResourceData;
    prompt: string;
    negativePrompt?: string;
    scheduler: Scheduler;
    steps: number;
    cfgScale: number;
    clipSkip?: number;
    seed: number;
    width?: number;
    height?: number;
    quantity: number;
    batchSize: number;
    outputFormat?: string;
    /** Draft LoRA AIR to add (if in draft mode) */
    draftLoraAir?: string;
  },
  ctx: GenerationHandlerCtx
): TextToImageStepTemplate {
  const { model, resources = [], vae, draftLoraAir, ...rest } = args;

  // Build additionalNetworks from resources + vae
  const additionalNetworks: Record<string, ImageJobNetworkParams> = {};

  // Add user resources
  for (const r of resources) {
    additionalNetworks[ctx.airs.getOrThrow(r.id)] = { strength: r.strength };
  }

  // Add VAE if present
  if (vae) {
    additionalNetworks[ctx.airs.getOrThrow(vae.id)] = { strength: vae.strength };
  }

  // Add draft LoRA if present (uses pre-computed AIR, not from ctx)
  if (draftLoraAir) {
    additionalNetworks[draftLoraAir] = { strength: 1 };
  }

  return {
    $type: 'textToImage',
    input: {
      model: ctx.airs.getOrThrow(model.id),
      additionalNetworks,
      ...rest,
    },
  } as TextToImageStepTemplate;
}

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Creates step input for SD family workflows.
 *
 * Routes to textToImage or comfy based on workflow + images:
 * - txt2img (text only), txt2img:draft → textToImage
 * - img2img, face-fix, hires-fix → comfy
 */
export const createStableDiffusionInput = defineHandler<
  SDFamilyCtx,
  TextToImageStepTemplate | ComfyStepTemplate
>(async (data, ctx) => {
  if (!data.model) throw new Error('Model is required for SD family workflows');
  if (!data.aspectRatio && !data.images?.length)
    throw new Error('Aspect ratio is required for SD family workflows');

  const isDraft = data.workflow === 'txt2img:draft';
  const isSD1 = data.ecosystem === 'SD1';
  const hasImages = Array.isArray(data.images) && data.images.length > 0;
  const comfyKey = getComfyKey(data.workflow, hasImages);
  const useComfy =
    comfyKey !== undefined || COMFY_ALWAYS.includes(data.workflow as (typeof COMFY_ALWAYS)[number]);

  // User resources (not modified - draft LoRA handled separately)
  const userResources = data.resources ?? [];

  // Add draft LoRA and override settings for draft workflow
  let sampler = data.sampler ?? 'Euler';
  let steps = data.steps ?? 25;
  let cfgScale = data.cfgScale ?? 7;

  // Quantity and batch size for draft optimization
  const requestedQuantity = data.quantity ?? 1;
  let quantity = requestedQuantity;
  let batchSize = 1;

  // Draft LoRA AIR (pre-computed, not from ctx)
  let draftLoraAir: string | undefined;

  if (isDraft) {
    draftLoraAir = isSD1 ? SD1_DRAFT_LORA.air : SDXL_DRAFT_LORA.air;
    steps = isSD1 ? 6 : 8;
    cfgScale = 1;
    sampler = isSD1 ? 'LCM' : 'Euler';
    // Draft mode batch optimization: generate 4 images per batch
    quantity = Math.ceil(requestedQuantity / 4);
    batchSize = 4;
  }

  // Auto-generate seed if not provided
  const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

  const scheduler = samplersToSchedulers[sampler as keyof typeof samplersToSchedulers] as Scheduler;

  // Use comfy for face-fix, hires-fix, or when images are present (img2img mode)
  if (useComfy && comfyKey) {
    const isHires = data.workflow.includes('hires');

    const workflowData: Record<string, unknown> = {
      prompt: data.prompt,
      negativePrompt: data.negativePrompt,
      seed,
      steps,
      cfgScale,
      sampler,
      outputFormat: data.outputFormat ?? 'jpeg',
    };

    if (hasImages) {
      const sourceImage = data.images![0] as { url?: string; width?: number; height?: number };
      if (!sourceImage?.url) {
        throw new Error('Source image is required when images are provided');
      }
      workflowData.image = sourceImage.url;
      workflowData.denoise = data.denoise;
      workflowData.width = sourceImage.width;
      workflowData.height = sourceImage.height;
    } else {
      workflowData.width = data.aspectRatio?.width;
      workflowData.height = data.aspectRatio?.height;
      workflowData.denoise = data.denoise;
    }

    if (isHires) {
      workflowData.upscaleWidth = Math.round((workflowData.width as number) * 1.5);
      workflowData.upscaleHeight = Math.round((workflowData.height as number) * 1.5);
    }

    const comfyInput = await createComfyInput(
      {
        key: comfyKey,
        quantity,
        params: workflowData,
        resources: [data.model, ...userResources, ...(data.vae ? [data.vae] : [])],
      },
      ctx
    );

    return {
      ...comfyInput,
      metadata: {
        params: removeEmpty({
          upscaleWidth: workflowData.upscaleWidth,
          upscaleHeight: workflowData.upscaleHeight,
        }),
      },
    };
  }

  return createTextToImageInput(
    {
      model: data.model,
      resources: userResources,
      vae: data.vae,
      prompt: data.prompt,
      negativePrompt: data.negativePrompt,
      scheduler,
      steps,
      cfgScale,
      clipSkip: data.clipSkip,
      seed,
      width: data.aspectRatio?.width,
      height: data.aspectRatio?.height,
      quantity,
      batchSize,
      outputFormat: data.outputFormat,
      draftLoraAir,
    },
    ctx
  );
});
