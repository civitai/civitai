/** HiDream handler for the form-graph lane — through hidream.config. */

import type {
  ImageGenStepTemplate,
  ImageJobNetworkParams,
  Scheduler,
  TextToImageStepTemplate,
} from '@civitai/client';
import type { ComfyHiDreamI1CreateImageGenInput } from '@civitai/orchestration-client';
import { maxRandomSeed } from '~/server/common/constants';
import {
  samplersToComfySamplers,
  samplersToSchedulers,
} from '~/shared/constants/generation.constants';
import {
  getHiDreamInput,
  getHiDreamResourceFromVersionId,
} from '~/shared/orchestrator/hidream.config';
import { removeEmpty } from '~/utils/object-helpers';
import { getRandomInt } from '~/utils/number-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import type { EcosystemData } from './types';

export const createHiDreamInput = defineHandler<
  EcosystemData<'HiDream'>,
  [TextToImageStepTemplate | ImageGenStepTemplate]
>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for HiDream workflows');
  if (!data.model) throw new Error('Model is required for HiDream workflows');

  const full = data.hiDreamVariant === 'full' ? data : undefined;
  const quantity = data.quantity ?? 1;
  const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

  const hiDreamResult = getHiDreamInput({
    ecosystem: 'HiDream',
    workflow: data.workflow ?? '',
    resources: [
      { id: data.model.id, strength: data.model.strength ?? 1 },
      ...(full?.resources ?? []).map((r) => ({ id: r.id, strength: r.strength ?? 1 })),
    ],
    prompt: data.prompt,
    negativePrompt: data.negativePrompt,
    width: data.aspectRatio.width,
    height: data.aspectRatio.height,
    seed,
    steps: full?.steps,
    cfgScale: full?.cfgScale,
    sampler: full?.sampler,
  });

  const additionalNetworks: Record<string, ImageJobNetworkParams> = {};
  for (const resource of hiDreamResult.resources ?? []) {
    if (resource.air) {
      additionalNetworks[resource.air] = { strength: resource.strength, type: 'LORA' };
    }
  }

  const { params } = hiDreamResult;

  if (ctx.useImageGen) {
    // The endpoint selects the checkpoint from variant+precision, so the model AIR is
    // consumed as the selector rather than sent.
    const selected = getHiDreamResourceFromVersionId(data.model.id);
    if (!selected) throw new Error('Unrecognized HiDream model version');

    const input: ComfyHiDreamI1CreateImageGenInput = {
      engine: 'comfy',
      ecosystem: 'hidream',
      operation: 'createImage',
      variant: selected.variant,
      precision: selected.precision,
      prompt: params.prompt ?? data.prompt,
      negativePrompt: params.negativePrompt ?? data.negativePrompt,
      width: params.width ?? data.aspectRatio.width,
      height: params.height ?? data.aspectRatio.height,
      steps: params.steps ?? full?.steps ?? 25,
      cfgScale: params.cfgScale ?? full?.cfgScale ?? 7,
      sampler:
        samplersToComfySamplers[(params.sampler ?? 'Euler') as keyof typeof samplersToComfySamplers]
          .sampler,
      seed,
      quantity,
      outputFormat: data.outputFormat,
      loras: Object.keys(additionalNetworks).length
        ? Object.fromEntries(
            Object.entries(additionalNetworks).map(([air, v]) => [air, v.strength ?? 1])
          )
        : undefined,
    };

    return [{ $type: 'imageGen', input: removeEmpty(input) } as ImageGenStepTemplate];
  }

  const scheduler = samplersToSchedulers[
    (params.sampler ?? 'Euler') as keyof typeof samplersToSchedulers
  ] as Scheduler;

  return [
    {
      $type: 'textToImage',
      input: {
        model: ctx.airs.getOrThrow(data.model.id),
        additionalNetworks,
        scheduler,
        prompt: params.prompt ?? data.prompt,
        negativePrompt: params.negativePrompt ?? data.negativePrompt,
        steps: params.steps ?? full?.steps ?? 25,
        cfgScale: params.cfgScale ?? full?.cfgScale ?? 7,
        clipSkip: undefined,
        seed,
        width: params.width ?? data.aspectRatio.width,
        height: params.height ?? data.aspectRatio.height,
        quantity,
        batchSize: 1,
        outputFormat: data.outputFormat,
      },
    } as TextToImageStepTemplate,
  ];
});
