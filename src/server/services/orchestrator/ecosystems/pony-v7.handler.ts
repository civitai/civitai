import type {
  ImageGenStepTemplate,
  ImageJobNetworkParams,
  Scheduler,
  TextToImageStepTemplate,
} from '@civitai/client';
import type { ComfyPonyV7CreateImageGenInput } from '@civitai/orchestration-client';
import { maxRandomSeed } from '~/server/common/constants';
import {
  samplersToComfySamplers,
  samplersToSchedulers,
} from '~/shared/constants/generation.constants';
import { removeEmpty } from '~/utils/object-helpers';
import { getRandomInt } from '~/utils/number-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { defineHandler } from './handler-factory';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type PonyV7Ctx = EcosystemGraphOutput & { ecosystem: 'PonyV7' };

export const createPonyV7Input = defineHandler<
  PonyV7Ctx,
  [TextToImageStepTemplate | ImageGenStepTemplate]
>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for PonyV7 workflows');

  const quantity = data.quantity ?? 1;
  const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

  if (ctx.useImageGen) {
    if (!data.model) throw new Error('Model is required for PonyV7 imageGen workflows');

    const loras: Record<string, number> = {};
    for (const resource of data.resources ?? []) {
      loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
    }

    const input: ComfyPonyV7CreateImageGenInput = {
      engine: 'comfy',
      ecosystem: 'ponyV7',
      operation: 'createImage',
      model: ctx.airs.getOrThrow(data.model.id),
      prompt: data.prompt,
      negativePrompt: 'negativePrompt' in data ? (data.negativePrompt as string) : undefined,
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
      steps: data.steps ?? 25,
      cfgScale: data.cfgScale ?? 7,
      sampler: samplersToComfySamplers['Euler'].sampler,
      seed,
      quantity,
      outputFormat: data.outputFormat,
      loras: Object.keys(loras).length > 0 ? loras : undefined,
    };

    return [{ $type: 'imageGen', input: removeEmpty(input) } as ImageGenStepTemplate];
  }

  const vae = 'vae' in data ? (data.vae as ResourceData | undefined) : undefined;
  const additionalNetworks: Record<string, ImageJobNetworkParams> = {};
  for (const resource of [...(data.resources ?? []), ...(vae ? [vae] : [])]) {
    additionalNetworks[ctx.airs.getOrThrow(resource.id)] = { strength: resource.strength };
  }

  return [
    {
      $type: 'textToImage',
      input: {
        model: data.model ? ctx.airs.getOrThrow(data.model.id) : undefined,
        additionalNetworks,
        scheduler: samplersToSchedulers['Euler'] as Scheduler,
        prompt: data.prompt,
        negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
        steps: data.steps ?? 25,
        cfgScale: data.cfgScale ?? 7,
        clipSkip: 'clipSkip' in data ? data.clipSkip : undefined,
        seed,
        width: data.aspectRatio.width,
        height: data.aspectRatio.height,
        quantity,
        batchSize: 1,
        outputFormat: data.outputFormat,
      },
    } as TextToImageStepTemplate,
  ];
});
