/**
 * HiDream Ecosystem Handler
 *
 * Handles HiDream workflows using textToImage step type.
 * Uses HiDream-specific input transformation for variant handling.
 */

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
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type HiDreamCtx = EcosystemGraphOutput & { ecosystem: 'HiDream' };

/**
 * Creates step input for HiDream ecosystem.
 * Uses HiDream-specific input transformation for variant handling.
 */
export const createHiDreamInput = defineHandler<
  HiDreamCtx,
  [TextToImageStepTemplate | ImageGenStepTemplate]
>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for HiDream workflows');
  if (!data.model) throw new Error('Model is required for HiDream workflows');

  const quantity = data.quantity ?? 1;
  const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

  // Use HiDream-specific input transformation
  const hiDreamResult = getHiDreamInput({
    ecosystem: 'HiDream',
    workflow: data.workflow,
    resources: [
      {
        id: data.model.id,
        strength: ('strength' in data.model ? data.model.strength : undefined) ?? 1,
      },
      ...('resources' in data && data.resources
        ? data.resources.map((r) => ({ id: r.id, strength: r.strength ?? 1 }))
        : []),
    ],
    prompt: data.prompt,
    negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
    width: data.aspectRatio.width,
    height: data.aspectRatio.height,
    seed,
    steps: 'steps' in data ? data.steps : undefined,
    cfgScale: 'cfgScale' in data ? data.cfgScale : undefined,
    sampler: 'sampler' in data ? data.sampler : undefined,
  });

  // Build additionalNetworks from transformed resources
  const additionalNetworks: Record<string, ImageJobNetworkParams> = {};
  for (const resource of hiDreamResult.resources ?? []) {
    if (resource.air) {
      additionalNetworks[resource.air] = {
        strength: resource.strength,
        type: 'LORA',
      };
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
      negativePrompt:
        params.negativePrompt ?? ('negativePrompt' in data ? data.negativePrompt : undefined),
      width: params.width ?? data.aspectRatio.width,
      height: params.height ?? data.aspectRatio.height,
      steps: params.steps ?? ('steps' in data ? data.steps : undefined) ?? 25,
      cfgScale: params.cfgScale ?? ('cfgScale' in data ? data.cfgScale : undefined) ?? 7,
      sampler:
        samplersToComfySamplers[(params.sampler ?? 'Euler') as keyof typeof samplersToComfySamplers]
          .sampler,
      seed,
      quantity,
      outputFormat: 'outputFormat' in data ? data.outputFormat : undefined,
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
        negativePrompt:
          params.negativePrompt ?? ('negativePrompt' in data ? data.negativePrompt : undefined),
        steps: params.steps ?? ('steps' in data ? data.steps : undefined) ?? 25,
        cfgScale: params.cfgScale ?? ('cfgScale' in data ? data.cfgScale : undefined) ?? 7,
        clipSkip: 'clipSkip' in data ? data.clipSkip : undefined,
        seed,
        width: params.width ?? data.aspectRatio.width,
        height: params.height ?? data.aspectRatio.height,
        quantity,
        batchSize: 1,
        outputFormat: 'outputFormat' in data ? data.outputFormat : undefined,
      },
    } as TextToImageStepTemplate,
  ];
});
