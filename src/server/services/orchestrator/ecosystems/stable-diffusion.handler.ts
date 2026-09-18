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
  ImageGenStepTemplate,
  ImageJobControlNet,
  ImageJobNetworkParams,
  PreprocessImageStepTemplate,
  Scheduler,
  TextToImageStep,
  TextToImageStepTemplate,
} from '@civitai/client';
import type {
  ComfySd1CreateImageGenInput,
  ComfySdxlCreateImageGenInput,
  Sd1CreateImageGenInput,
  SdxlCreateImageGenInput,
} from '@civitai/orchestration-client';
import {
  samplersToComfySamplers,
  samplersToSchedulers,
  samplersToSdCppSamplers,
  usesComfyEngine,
} from '~/shared/constants/generation.constants';
import { removeEmpty } from '~/utils/object-helpers';
import { getRandomInt } from '~/utils/number-helpers';
import { maxRandomSeed } from '~/server/common/constants';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ControlNetsNodeValue, ResourceData } from '~/shared/data-graph/generation/common';
import type { GenerationHandlerCtx } from '.';
import { createComfyInput } from './comfy-input';
import { defineHandler } from './handler-factory';
import { buildControlNetSteps, mapControlNetsToJobInput } from './controlnets.helper';

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

const IMAGE_GEN_ECOSYSTEM: Partial<Record<SDFamilyCtx['ecosystem'], 'sd1' | 'sdxl'>> = {
  SD1: 'sd1',
  SDXL: 'sdxl',
  Pony: 'sdxl',
  Illustrious: 'sdxl',
  NoobAI: 'sdxl',
};

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
    controlNets?: ImageJobControlNet[];
  },
  ctx: GenerationHandlerCtx
): TextToImageStepTemplate {
  const { model, resources = [], vae, draftLoraAir, controlNets, ...rest } = args;

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
      ...(controlNets?.length ? { controlNets } : {}),
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
  (
    | TextToImageStepTemplate
    | ImageGenStepTemplate
    | ComfyStepTemplate
    | PreprocessImageStepTemplate
  )[]
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
      workflowData.upscaleWidth = data.upscaleWidth;
      workflowData.upscaleHeight = data.upscaleHeight;
    }

    return [
      await createComfyInput(
        {
          key: comfyKey,
          quantity,
          params: workflowData,
          resources: [data.model, ...userResources, ...(data.vae ? [data.vae] : [])],
        },
        ctx
      ),
    ];
  }

  const { preprocessSteps, controlNets } = buildControlNetSteps(
    (data as { controlNets?: ControlNetsNodeValue }).controlNets,
    ctx.baseStepIndex
  );

  const ecosystem = IMAGE_GEN_ECOSYSTEM[data.ecosystem];
  // Keep whichever engine this request runs on today: the comfy inputs have no
  // `embeddings` and the sdcpp ones no `controlNets`, so each route sends only
  // what it can carry and the rest stays on textToImage. Draft needs batchSize,
  // which no imageGen input has.
  const comfyEngine = usesComfyEngine({
    ecosystem: data.ecosystem,
    modelId: data.model.id,
    enhancedCompatibility:
      'enhancedCompatibility' in data ? (data.enhancedCompatibility as boolean) : undefined,
  });
  const embeddings = userResources.filter((r) => r.model?.type === 'TextualInversion');
  const canImageGen =
    ctx.useImageGen &&
    !!ecosystem &&
    !isDraft &&
    (comfyEngine ? embeddings.length === 0 : controlNets.length === 0);

  if (canImageGen && ecosystem) {
    const loras: Record<string, number> = {};
    for (const r of userResources) {
      if (r.model?.type === 'TextualInversion') continue;
      loras[ctx.airs.getOrThrow(r.id)] = r.strength ?? 1;
    }

    const shared = {
      ecosystem,
      operation: 'createImage' as const,
      model: ctx.airs.getOrThrow(data.model.id),
      prompt: data.prompt,
      negativePrompt: data.negativePrompt,
      width: data.aspectRatio?.width,
      height: data.aspectRatio?.height,
      steps,
      cfgScale,
      seed,
      quantity,
      outputFormat: data.outputFormat,
      loras: Object.keys(loras).length ? loras : undefined,
      vaeModel: data.vae ? ctx.airs.getOrThrow(data.vae.id) : undefined,
      // Only the sd1 inputs carry clipSkip; the sdxl ones drop it on both engines.
      ...(ecosystem === 'sd1' && data.clipSkip != null ? { clipSkip: data.clipSkip } : {}),
    };

    let input:
      | ComfySd1CreateImageGenInput
      | ComfySdxlCreateImageGenInput
      | Sd1CreateImageGenInput
      | SdxlCreateImageGenInput;
    if (comfyEngine) {
      const comfy =
        samplersToComfySamplers[sampler as keyof typeof samplersToComfySamplers] ??
        samplersToComfySamplers['undefined'];
      input = {
        ...shared,
        engine: 'comfy',
        sampler: comfy.sampler,
        scheduler: comfy.scheduler,
        ...(controlNets.length ? { controlNets } : {}),
      };
    } else {
      const sdcpp =
        samplersToSdCppSamplers[sampler as keyof typeof samplersToSdCppSamplers] ??
        samplersToSdCppSamplers['undefined'];
      input = {
        ...shared,
        engine: 'sdcpp',
        sampleMethod: sdcpp.sampleMethod,
        schedule: sdcpp.schedule,
        ...(embeddings.length
          ? { embeddings: embeddings.map((r) => ctx.airs.getOrThrow(r.id)) }
          : {}),
      };
    }

    return [
      ...preprocessSteps,
      { $type: 'imageGen', input: removeEmpty(input) } as ImageGenStepTemplate,
    ];
  }

  const genStep = createTextToImageInput(
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
      controlNets: controlNets.length ? controlNets : undefined,
    },
    ctx
  );

  return [...preprocessSteps, genStep];
});
