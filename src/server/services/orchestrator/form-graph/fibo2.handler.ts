import type {
  ComfyFibo2DevCreateImageInput,
  ComfyFibo2EditTurboEditImageInput,
  ImageGenStepTemplate,
} from '@civitai/orchestration-client';
import {
  FIBO2_TURBO_BASE_MODEL,
  fibo2ModeOf,
  fibo2VersionIds,
} from '~/shared/form-graph/generation/image/fibo2.graph';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../handlers/handler-factory';
import { resourcesToLoras } from './types';
import type { EcosystemData } from './types';

export const createFibo2Input = defineHandler<EcosystemData<'Fibo2'>, [ImageGenStepTemplate]>(
  (data, ctx) => {
    const shared = {
      engine: 'comfy' as const,
      ecosystem: 'fibo2' as const,
      prompt: data.prompt ?? '',
      negativePrompt: data.negativePrompt,
      width: data.aspectRatio?.width,
      height: data.aspectRatio?.height,
      steps: data.steps,
      cfgScale: data.cfgScale,
      quantity: data.quantity ?? 1,
      seed: data.seed,
    };

    const checkpoint = 'model' in data ? data.model : undefined;
    if (fibo2ModeOf(checkpoint) === 'turbo') {
      return [
        {
          $type: 'imageGen',
          input: removeEmpty<ComfyFibo2EditTurboEditImageInput>({
            ...shared,
            model: 'editTurbo',
            operation: 'editImage',
            images: 'images' in data ? data.images?.map((x) => x.url) ?? [] : [],
          }),
        },
      ];
    }

    // 'dev' already selects the official weights; send diffusionModel only for a fine-tune.
    if (checkpoint?.baseModel === FIBO2_TURBO_BASE_MODEL)
      throw throwBadRequestError('Fibo 2.0 Turbo checkpoints can only edit images');
    const diffusionModel =
      checkpoint && checkpoint.id !== fibo2VersionIds.dev
        ? ctx.airs.getOrThrow(checkpoint.id)
        : undefined;

    return [
      {
        $type: 'imageGen',
        input: removeEmpty<ComfyFibo2DevCreateImageInput>({
          ...shared,
          model: 'dev',
          operation: 'createImage',
          diffusionModel,
          loras: 'resources' in data ? resourcesToLoras(data.resources, ctx.airs) : undefined,
        }),
      },
    ];
  }
);
