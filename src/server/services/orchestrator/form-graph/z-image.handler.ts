/**
 * ZImage handler for the form-graph lane (ZImageTurbo + ZImageBase) — comfy
 * imageGen steps, with optional ControlNet preprocess steps.
 */

import type { ImageGenStepTemplate, PreprocessImageStepTemplate } from '@civitai/client';
import type {
  ComfyZImageBaseCreateImageGenInput,
  ComfyZImageTurboCreateImageGenInput,
} from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import { buildControlNetSteps } from '../ecosystems/controlnets.helper';
import { resourcesToLoras } from './types';
import type { EcosystemData } from './types';

type ZImageInput = ComfyZImageTurboCreateImageGenInput | ComfyZImageBaseCreateImageGenInput;

const baseModelToModel: Record<string, 'turbo' | 'base'> = {
  ZImageTurbo: 'turbo',
  ZImageBase: 'base',
};

export const createZImageInput = defineHandler<
  EcosystemData<'ZImageTurbo' | 'ZImageBase'>,
  (ImageGenStepTemplate | PreprocessImageStepTemplate)[]
>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for ZImage workflows');

  const quantity = data.quantity ?? 1;
  const model = baseModelToModel[data.ecosystem] ?? 'turbo';
  const sampler = data.zImageMode === 'base' ? data.sampler : undefined;
  const scheduler = data.zImageMode === 'base' ? data.scheduler : undefined;

  const loras = resourcesToLoras(data.resources, ctx.airs);

  const { preprocessSteps, controlNets } = buildControlNetSteps(
    data.controlNets,
    ctx.baseStepIndex
  );

  const genStep: ImageGenStepTemplate = {
    $type: 'imageGen',
    input: removeEmpty({
      engine: 'comfy',
      ecosystem: 'zImage',
      model,
      operation: 'createImage' as const,
      prompt: data.prompt,
      negativePrompt: data.negativePrompt,
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
      cfgScale: data.cfgScale ?? 1,
      steps: data.steps ?? 4,
      sampler: sampler ?? 'euler',
      scheduler: scheduler ?? 'simple',
      quantity,
      seed: data.seed,
      loras,
      diffuserModel: data.model ? ctx.airs.getOrThrow(data.model.id) : undefined,
      ...(controlNets.length ? { controlNets } : {}),
    }) as ZImageInput,
  };

  return [...preprocessSteps, genStep];
});
