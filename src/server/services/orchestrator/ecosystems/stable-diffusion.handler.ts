/**
 * SD Family Ecosystem Handler
 *
 * Handles Stable Diffusion family workflows:
 * - SD1, SDXL, Pony, Illustrious, NoobAI
 *
 * imageGen for plain txt2img; comfy when images are present, or for face-fix/hires-fix.
 */

import type {
  ComfyStepTemplate,
  ImageGenStepTemplate,
  PreprocessImageStepTemplate,
} from '@civitai/client';
import type {
  ComfySd1CreateImageGenInput,
  ComfySdxlCreateImageGenInput,
  Sd1CreateImageGenInput,
  SdxlCreateImageGenInput,
} from '@civitai/orchestration-client';
import {
  samplersToComfySamplers,
  samplersToSdCppSamplers,
  usesComfyEngine,
} from '~/shared/constants/generation.constants';
import { removeEmpty } from '~/utils/object-helpers';
import { getRandomInt } from '~/utils/number-helpers';
import { maxRandomSeed } from '~/server/common/constants';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ControlNetsNodeValue } from '~/shared/data-graph/generation/common';
import { createComfyInput } from './comfy-input';
import { defineHandler } from './handler-factory';
import { buildControlNetSteps } from './controlnets.helper';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type SDFamilyCtx = EcosystemGraphOutput & {
  ecosystem: 'SD1' | 'SDXL' | 'Pony' | 'Illustrious' | 'NoobAI';
};

// =============================================================================
// Constants
// =============================================================================

const IMAGE_GEN_ECOSYSTEM: Record<SDFamilyCtx['ecosystem'], 'sd1' | 'sdxl'> = {
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
// Main Handler
// =============================================================================

/**
 * Creates step input for SD family workflows.
 *
 * Routes on workflow + images:
 * - txt2img (text only) → imageGen
 * - img2img, face-fix, hires-fix → comfy
 */
export const createStableDiffusionInput = defineHandler<
  SDFamilyCtx,
  (ImageGenStepTemplate | ComfyStepTemplate | PreprocessImageStepTemplate)[]
>(async (data, ctx) => {
  if (!data.model) throw new Error('Model is required for SD family workflows');
  if (!data.aspectRatio && !data.images?.length)
    throw new Error('Aspect ratio is required for SD family workflows');

  const hasImages = Array.isArray(data.images) && data.images.length > 0;
  const comfyKey = getComfyKey(data.workflow, hasImages);
  const useComfy =
    comfyKey !== undefined || COMFY_ALWAYS.includes(data.workflow as (typeof COMFY_ALWAYS)[number]);

  const userResources = data.resources ?? [];
  const sampler = data.sampler ?? 'Euler';
  const steps = data.steps ?? 25;
  const cfgScale = data.cfgScale ?? 7;
  const quantity = data.quantity ?? 1;

  // Auto-generate seed if not provided
  const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

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
  // The sdcpp inputs carry no `controlNets` field, so a ControlNet request must name comfy.
  const comfyEngine =
    controlNets.length > 0 ||
    usesComfyEngine({
      ecosystem: data.ecosystem,
      modelId: data.model.id,
      enhancedCompatibility:
        'enhancedCompatibility' in data ? (data.enhancedCompatibility as boolean) : undefined,
    });
  const embeddings = userResources.filter((r) => r.model?.type === 'TextualInversion');
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
    ...(data.clipSkip != null ? { clipSkip: data.clipSkip } : {}),
    ...(embeddings.length ? { embeddings: embeddings.map((r) => ctx.airs.getOrThrow(r.id)) } : {}),
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
    };
  }

  return [
    ...preprocessSteps,
    { $type: 'imageGen', input: removeEmpty(input) } as ImageGenStepTemplate,
  ];
});
