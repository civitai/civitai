/**
 * SD Family Ecosystem Handler
 *
 * Handles Stable Diffusion family workflows:
 * - SD1, SD2, SDXL, Pony, Illustrious, NoobAI
 *
 * Uses textToImage step type for txt2img workflows,
 * comfy step type for img2img, face-fix, and hires-fix workflows.
 */

import type { ImageJobNetworkParams, Scheduler, WorkflowStepTemplate } from '@civitai/client';
import { populateWorkflowDefinition, applyResources } from '../comfy/comfy.utils';
import {
  samplersToSchedulers,
  samplersToComfySamplers,
} from '~/shared/constants/generation.constants';
import { getRandomInt } from '~/utils/number-helpers';
import { maxRandomSeed } from '~/server/common/constants';
import { removeEmpty } from '~/utils/object-helpers';
import { getEcosystemName } from '~/shared/constants/basemodel.constants';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type StepInput = WorkflowStepTemplate & { input: unknown };
type SDFamilyCtx = EcosystemGraphOutput & {
  baseModel: 'SD1' | 'SD2' | 'SDXL' | 'Pony' | 'Illustrious' | 'NoobAI';
};

// =============================================================================
// Constants
// =============================================================================

/** SD1 Draft LoRA resource version ID */
const SD1_DRAFT_RESOURCE_ID = 424706;

/** SDXL Draft LoRA resource version ID (also used for Pony, Illustrious, NoobAI) */
const SDXL_DRAFT_RESOURCE_ID = 391999;

/** Workflows that use comfy instead of textToImage */
const COMFY_WORKFLOWS = [
  'img2img',
  'txt2img:face-fix',
  'txt2img:hires-fix',
  'img2img:face-fix',
  'img2img:hires-fix',
] as const;

/** Map generation-graph workflow keys to comfy workflow keys */
const COMFY_WORKFLOW_KEY_MAP: Record<string, string> = {
  img2img: 'img2img',
  'txt2img:face-fix': 'txt2img-facefix',
  'txt2img:hires-fix': 'txt2img-hires',
  'img2img:face-fix': 'img2img-facefix',
  'img2img:hires-fix': 'img2img-hires',
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Converts a ResourceData object to an AIR string.
 * AIR format: urn:air:{ecosystem}:{type}:{source}:{modelId}@{versionId}
 */
function resourceToAir(resource: ResourceData): string {
  const ecosystem = getEcosystemName(resource.baseModel);
  const type = resource.model.type.toLowerCase();
  return `urn:air:${ecosystem}:${type}:civitai:${resource.model.id}@${resource.id}`;
}

// =============================================================================
// Step Input Creators
// =============================================================================

/**
 * Creates a textToImage step input for SD family.
 */
function createTextToImageInput(args: {
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
  width: number;
  height: number;
  quantity: number;
  batchSize: number;
  outputFormat?: string;
}): StepInput {
  const { model, resources = [], vae, ...rest } = args;

  // Build additionalNetworks from resources + vae
  const allResources = [...resources, ...(vae ? [vae] : [])];
  const additionalNetworks = allResources.reduce<Record<string, ImageJobNetworkParams>>(
    (acc, r) => ({
      ...acc,
      [resourceToAir(r)]: {
        strength: r.strength,
        type: r.model.type,
      },
    }),
    {}
  );

  return {
    $type: 'textToImage',
    input: {
      model: resourceToAir(model),
      additionalNetworks,
      ...rest,
    },
  };
}

/**
 * Creates a comfy step input for SD family (img2img, face-fix, hires-fix).
 */
async function createComfyInput(args: {
  key: string;
  quantity: number;
  params: Record<string, unknown>;
  resources: ResourceData[];
}): Promise<StepInput> {
  const { key, quantity, params, resources } = args;

  // Convert sampler to comfy sampler/scheduler if present
  let workflowData: Record<string, unknown> = { ...params };
  if ('sampler' in params && params.sampler) {
    const comfySampler =
      samplersToComfySamplers[
        (params.sampler as keyof typeof samplersToComfySamplers) ?? 'DPM++ 2M Karras'
      ];
    workflowData = {
      ...workflowData,
      sampler: comfySampler.sampler,
      scheduler: comfySampler.scheduler,
    };
  }

  const comfyWorkflow = await populateWorkflowDefinition(key, workflowData);

  // Apply resources (checkpoint, LoRAs, VAE, etc.) to the workflow
  if (resources.length > 0) {
    const resourcesToApply = resources.map((resource) => ({
      air: resourceToAir(resource),
      strength: resource.strength,
    }));
    workflowData = { ...workflowData, resources: resourcesToApply };
    applyResources(comfyWorkflow, resourcesToApply);
  }

  const imageMetadata = JSON.stringify(removeEmpty(workflowData));

  return {
    $type: 'comfy',
    input: {
      quantity,
      comfyWorkflow,
      imageMetadata,
      useSpineComfy: null,
    },
  };
}

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Creates step input for SD family workflows.
 *
 * Routes to textToImage or comfy based on workflow type:
 * - txt2img, txt2img:draft → textToImage
 * - img2img, *:face-fix, *:hires-fix → comfy
 */
export async function createStableDiffusionInput(data: SDFamilyCtx): Promise<StepInput> {
  if (!data.model) throw new Error('Model is required for SD family workflows');
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for SD family workflows');

  const isDraft = data.workflow === 'txt2img:draft';
  const isSD1 = data.baseModel === 'SD1';
  const useComfy = COMFY_WORKFLOWS.includes(data.workflow as (typeof COMFY_WORKFLOWS)[number]);

  // Mutable copy of resources for adding draft LoRA
  const finalResources = [...(data.resources ?? [])];

  // Add draft LoRA and override settings for draft workflow
  let sampler = data.sampler ?? 'Euler';
  let steps = data.steps ?? 25;
  let cfgScale = data.cfgScale ?? 7;

  // Quantity and batch size for draft optimization
  const requestedQuantity = data.quantity ?? 1;
  let quantity = requestedQuantity;
  let batchSize = 1;

  if (isDraft) {
    finalResources.push(
      isSD1
        ? {
            id: SD1_DRAFT_RESOURCE_ID,
            strength: 1,
            baseModel: 'SD 1.5',
            model: { id: 424706, type: 'LORA' },
          }
        : {
            id: SDXL_DRAFT_RESOURCE_ID,
            strength: 1,
            baseModel: 'SDXL 1.0',
            model: { id: 391999, type: 'LORA' },
          }
    );
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

  // Use comfy for img2img, face-fix, and hires-fix workflows
  if (useComfy) {
    const comfyKey = COMFY_WORKFLOW_KEY_MAP[data.workflow] ?? data.workflow;
    const isHires = data.workflow.includes('hires');
    const isImg2Img = data.workflow.startsWith('img2img');

    const workflowData: Record<string, unknown> = {
      prompt: data.prompt,
      negativePrompt: data.negativePrompt,
      seed,
      steps,
      cfgScale,
      sampler,
      outputFormat: data.outputFormat ?? 'jpeg',
    };

    if (isImg2Img) {
      const sourceImage = data.images?.[0];
      if (!sourceImage?.url) {
        throw new Error('Source image is required for img2img workflows');
      }
      workflowData.image = sourceImage.url;
      workflowData.denoise = data.denoise;
      workflowData.width = sourceImage.width;
      workflowData.height = sourceImage.height;
    } else {
      workflowData.width = data.aspectRatio.width;
      workflowData.height = data.aspectRatio.height;
      workflowData.denoise = data.denoise;
    }

    if (isHires) {
      workflowData.upscaleWidth = Math.round((workflowData.width as number) * 1.5);
      workflowData.upscaleHeight = Math.round((workflowData.height as number) * 1.5);
    }

    return createComfyInput({
      key: comfyKey,
      quantity,
      params: workflowData,
      resources: [data.model, ...finalResources, ...(data.vae ? [data.vae] : [])],
    });
  }

  return createTextToImageInput({
    model: data.model,
    resources: finalResources,
    vae: data.vae,
    prompt: data.prompt,
    negativePrompt: data.negativePrompt,
    scheduler,
    steps,
    cfgScale,
    clipSkip: data.clipSkip,
    seed,
    width: data.aspectRatio.width,
    height: data.aspectRatio.height,
    quantity,
    batchSize,
    outputFormat: data.outputFormat,
  });
}
