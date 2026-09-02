/** Anima handler for the form-graph lane — comfy imageGen + controlNet preprocess steps. */

import type {
  ComfyAnimaCreateImageGenInput,
  ComfySampler,
  ComfyScheduler,
  ImageGenStepTemplate,
  PreprocessImageStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import { buildControlNetSteps } from '../ecosystems/controlnets.helper';
import { resourcesToLoras } from './types';
import type { LooseGenerationData } from './types';

export const createAnimaInput = defineHandler<
  LooseGenerationData,
  (ImageGenStepTemplate | PreprocessImageStepTemplate)[]
>((data, ctx) => {
  const loras = resourcesToLoras(data.resources, ctx.airs);

  const diffuserModel = data.model ? ctx.airs.getOrThrow(data.model.id) : undefined;

  const { preprocessSteps, controlNets } = buildControlNetSteps(
    data.controlNets,
    ctx.baseStepIndex
  );

  const input: ComfyAnimaCreateImageGenInput = {
    engine: 'comfy',
    ecosystem: 'anima',
    operation: 'createImage',
    prompt: data.prompt ?? '',
    negativePrompt: data.negativePrompt,
    width: data.aspectRatio?.width,
    height: data.aspectRatio?.height,
    cfgScale: data.cfgScale,
    steps: data.steps,
    sampler: data.sampler as ComfySampler,
    scheduler: (data as { scheduler?: string }).scheduler as ComfyScheduler,
    seed: data.seed,
    quantity: data.quantity ?? 1,
    outputFormat: data.outputFormat,
    loras,
    diffuserModel,
    ...(controlNets.length ? { controlNets } : {}),
  };

  const genStep: ImageGenStepTemplate = {
    $type: 'imageGen',
    input: removeEmpty(input),
  };

  return [...preprocessSteps, genStep];
});
