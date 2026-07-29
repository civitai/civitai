/**
 * Boogu Family Handler
 *
 * Handles the Boogu ecosystem (comfy engine, ecosystem 'boogu') using the
 * imageGen step type. One ecosystem, checkpoints routed by model.id:
 *  - base      -> ComfyBooguBaseCreateImageGenInput  (operation: createImage)
 *  - turbo     -> ComfyBooguTurboCreateImageGenInput (operation: createImage)
 *  - edit      -> ComfyBooguEditImageInput           (operation: editImage, + images)
 *  - editTurbo -> ComfyBooguEditTurboImageInput      (operation: editImage, + images)
 *
 * Supports community LoRAs (mapped AIR -> strength).
 */

import type {
  ComfyBooguBaseCreateImageGenInput,
  ComfyBooguTurboCreateImageGenInput,
  ComfyBooguEditImageInput,
  ComfyBooguEditTurboImageInput,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type BooguCtx = EcosystemGraphOutput & { ecosystem: 'Boogu' };

/** Map model version ID -> orchestrator model string */
const versionIdToModel = new Map<number, 'base' | 'turbo' | 'edit' | 'editTurbo'>([
  [3049541, 'base'],
  [3050010, 'turbo'],
  [3049824, 'edit'],
  [3113427, 'editTurbo'],
]);

export const createBooguInput = defineHandler<BooguCtx, [ImageGenStepTemplate]>((data, ctx) => {
  const quantity = data.quantity ?? 1;

  let model: 'base' | 'turbo' | 'edit' | 'editTurbo' = data.workflow.startsWith('txt')
    ? 'base'
    : 'edit';
  if (data.model) {
    const match = versionIdToModel.get(data.model.id);
    if (match) model = match;
  }

  const loras: Record<string, number> = {};
  if ('resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
    }
  }

  const baseInput = {
    engine: 'comfy',
    ecosystem: 'boogu',
    prompt: data.prompt,
    negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
    width: data.aspectRatio?.width,
    height: data.aspectRatio?.height,
    cfgScale: 'cfgScale' in data ? data.cfgScale : undefined,
    steps: 'steps' in data ? data.steps : undefined,
    quantity,
    seed: data.seed,
    loras: Object.keys(loras).length > 0 ? loras : undefined,
  };

  if (model === 'editTurbo') {
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...baseInput,
          model: 'editTurbo',
          operation: 'editImage',
          images: data.images?.map((x) => x.url) ?? [],
        }) as ComfyBooguEditTurboImageInput,
      },
    ];
  }

  if (model === 'edit') {
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...baseInput,
          model: 'edit',
          operation: 'editImage',
          images: data.images?.map((x) => x.url) ?? [],
        }) as ComfyBooguEditImageInput,
      },
    ];
  }

  if (model === 'turbo') {
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...baseInput,
          model: 'turbo',
          operation: 'createImage',
        }) as ComfyBooguTurboCreateImageGenInput,
      },
    ];
  }

  return [
    {
      $type: 'imageGen',
      input: removeEmpty({
        ...baseInput,
        model: 'base',
        operation: 'createImage',
      }) as ComfyBooguBaseCreateImageGenInput,
    },
  ];
});
