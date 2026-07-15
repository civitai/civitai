/**
 * Anima Ecosystem Handler
 *
 * Handles Anima workflows using imageGen step type.
 * Uses the comfy engine with ComfyAnimaCreateImageGenInput.
 */

import type {
  ComfyAnimaCreateImageGenInput,
  ComfySampler,
  ComfyScheduler,
  ImageGenStepTemplate,
  PreprocessImageStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ControlNetsNodeValue, ResourceData } from '~/shared/data-graph/generation/common';
import { defineHandler } from './handler-factory';
import { buildControlNetSteps } from './controlnets.helper';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type AnimaCtx = EcosystemGraphOutput & { ecosystem: 'Anima' };

/**
 * Creates imageGen input for Anima ecosystem.
 */
export const createAnimaInput = defineHandler<
  AnimaCtx,
  (ImageGenStepTemplate | PreprocessImageStepTemplate)[]
>((data, ctx) => {
  const loras: Record<string, number> = {};
  if ('resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
    }
  }

  const diffuserModel = data.model ? ctx.airs.getOrThrow(data.model.id) : undefined;

  const { preprocessSteps, controlNets } = buildControlNetSteps(
    (data as { controlNets?: ControlNetsNodeValue }).controlNets,
    ctx.baseStepIndex
  );

  const input: ComfyAnimaCreateImageGenInput = {
    engine: 'comfy',
    ecosystem: 'anima',
    operation: 'createImage',
    prompt: data.prompt,
    negativePrompt: data.negativePrompt,
    width: data.aspectRatio?.width,
    height: data.aspectRatio?.height,
    cfgScale: data.cfgScale,
    steps: data.steps,
    sampler: data.sampler as ComfySampler,
    scheduler: data.scheduler as ComfyScheduler,
    seed: data.seed,
    quantity: data.quantity ?? 1,
    outputFormat: data.outputFormat,
    loras: Object.keys(loras).length > 0 ? loras : undefined,
    diffuserModel,
    ...(controlNets.length ? { controlNets } : {}),
  };

  const genStep: ImageGenStepTemplate = {
    $type: 'imageGen',
    input: removeEmpty(input),
  };

  return [...preprocessSteps, genStep];
});
