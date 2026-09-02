/**
 * ZImage handler for the form-graph lane (ZImageTurbo + ZImageBase) — SdCpp
 * imageGen steps, with optional ControlNet preprocess steps.
 */

import type {
  ZImageTurboCreateImageGenInput,
  ZImageBaseCreateImageGenInput,
  ImageGenStepTemplate,
  PreprocessImageStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import { buildControlNetSteps } from '../ecosystems/controlnets.helper';
import { resourcesToLoras } from './types';
import type { LooseGenerationData } from './types';

type ZImageInput = ZImageTurboCreateImageGenInput | ZImageBaseCreateImageGenInput;

const baseModelToModel: Record<string, 'turbo' | 'base'> = {
  ZImageTurbo: 'turbo',
  ZImageBase: 'base',
};

export const createZImageInput = defineHandler<
  LooseGenerationData,
  (ImageGenStepTemplate | PreprocessImageStepTemplate)[]
>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for ZImage workflows');

  const quantity = data.quantity ?? 1;
  const model = baseModelToModel[data.ecosystem ?? ''] ?? 'turbo';

  const loras = resourcesToLoras(data.resources, ctx.airs);

  const { preprocessSteps, controlNets } = buildControlNetSteps(
    data.controlNets,
    ctx.baseStepIndex
  );

  const genStep: ImageGenStepTemplate = {
    $type: 'imageGen',
    // Cast: `controlNets` is not yet declared on ZImage*ImageGenInput in the
    // @civitai/client types but is accepted by the orchestrator for ZImage
    // workflows. Drop the cast once the client SDK is regenerated with the
    // field on SdCpp imageGen inputs.
    input: removeEmpty({
      engine: 'sdcpp',
      ecosystem: 'zImage',
      model,
      operation: 'createImage' as const,
      prompt: data.prompt,
      negativePrompt: data.negativePrompt,
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
      cfgScale: data.cfgScale ?? 1,
      steps: data.steps ?? 4,
      sampleMethod: data.sampler ?? 'euler',
      schedule: data.scheduler ?? 'simple',
      quantity,
      seed: data.seed,
      loras,
      diffuserModel: data.model ? ctx.airs.getOrThrow(data.model.id) : undefined,
      ...(controlNets.length ? { controlNets } : {}),
    }) as ZImageInput,
  };

  return [...preprocessSteps, genStep];
});
