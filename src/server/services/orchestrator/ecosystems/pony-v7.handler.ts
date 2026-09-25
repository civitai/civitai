import type { ImageGenStepTemplate } from '@civitai/client';
import type { ComfyPonyV7CreateImageGenInput } from '@civitai/orchestration-client';
import { maxRandomSeed } from '~/server/common/constants';
import { samplersToComfySamplers } from '~/shared/constants/generation.constants';
import { removeEmpty } from '~/utils/object-helpers';
import { getRandomInt } from '~/utils/number-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type PonyV7Ctx = EcosystemGraphOutput & { ecosystem: 'PonyV7' };

export const createPonyV7Input = defineHandler<PonyV7Ctx, [ImageGenStepTemplate]>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for PonyV7 workflows');

  const quantity = data.quantity ?? 1;
  const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

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
});
