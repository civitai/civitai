/**
 * SD family handler for the form-graph lane (SD1 / SDXL / Pony /
 * Illustrious / NoobAI). imageGen for plain txt2img; comfy when images are present, or
 * for face-fix/hires-fix.
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
import { createComfyInput } from '../ecosystems/comfy-input';
import { defineHandler } from '../ecosystems/handler-factory';
import { buildControlNetSteps } from '../ecosystems/controlnets.helper';
import type { EcosystemData } from './types';

const IMAGE_GEN_ECOSYSTEM: Record<string, 'sd1' | 'sdxl' | undefined> = {
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
 * Get the external comfy workflow key from the internal workflow key + images
 * presence. Returns undefined if this combination should NOT use comfy.
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

export const createStableDiffusionInput = defineHandler<
  EcosystemData<'SD1' | 'SDXL' | 'Pony' | 'Illustrious' | 'NoobAI'>,
  (ImageGenStepTemplate | ComfyStepTemplate | PreprocessImageStepTemplate)[]
>(async (data, ctx) => {
  if (!data.model) throw new Error('Model is required for SD family workflows');
  if (!data.aspectRatio && !data.images?.length)
    throw new Error('Aspect ratio is required for SD family workflows');

  const hasImages = Array.isArray(data.images) && data.images.length > 0;
  const workflow = data.workflow ?? 'txt2img';
  const comfyKey = getComfyKey(workflow, hasImages);
  const useComfy =
    comfyKey !== undefined || COMFY_ALWAYS.includes(workflow as (typeof COMFY_ALWAYS)[number]);

  const userResources = data.resources ?? [];
  const sampler = data.sampler ?? 'Euler';
  const steps = data.steps ?? 25;
  const cfgScale = data.cfgScale ?? 7;
  const quantity = data.quantity ?? 1;

  const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

  if (useComfy && comfyKey) {
    const isHires = workflow.includes('hires');

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
      const sourceImage = data.images![0];
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
    data.controlNets,
    ctx.baseStepIndex
  );

  const ecosystem = IMAGE_GEN_ECOSYSTEM[data.ecosystem];
  // The sdcpp inputs carry no `controlNets` field, so a ControlNet request must name comfy.
  const comfyEngine =
    controlNets.length > 0 ||
    usesComfyEngine({
      ecosystem: data.ecosystem,
      modelId: data.model.id,
      enhancedCompatibility: data.enhancedCompatibility,
    });
  const embeddings = userResources.filter((r) => r.model?.type === 'TextualInversion');
  if (!ecosystem) throw new Error(`No imageGen ecosystem for ${data.ecosystem}`);

  const loras: Record<string, number> = {};
  for (const r of userResources) {
    if (r.model?.type === 'TextualInversion') continue;
    loras[ctx.airs.getOrThrow(r.id)] = r.strength ?? 1;
  }

  const shared = {
    ecosystem,
    operation: 'createImage' as const,
    model: ctx.airs.getOrThrow(data.model.id),
    prompt: data.prompt ?? '',
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
