/**
 * HiDream-O1 Ecosystem Handler
 *
 * Routes to one of four typed inputs based on (variant × operation):
 * - Full + create:  ComfyHiDreamO1CreateImageGenInput
 * - Full + edit:    ComfyHiDreamO1EditImageGenInput
 * - Dev  + create:  ComfyHiDreamO1DevCreateImageGenInput
 * - Dev  + edit:    ComfyHiDreamO1DevEditImageGenInput
 *
 * Engine: comfy, ecosystem: 'hidream-o1'. LoRAs are passed as Record<AIR, strength>.
 */

import type {
  ComfyHiDreamO1CreateImageGenInput,
  ComfyHiDreamO1DevCreateImageGenInput,
  ComfyHiDreamO1DevEditImageGenInput,
  ComfyHiDreamO1EditImageGenInput,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { hiDreamO1VersionIds } from '~/shared/data-graph/generation/hi-dream-o1-graph';
import { defineHandler } from './handler-factory';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type HiDreamO1Ctx = EcosystemGraphOutput & { ecosystem: 'HiDream-O1' };

export const createHiDreamO1Input = defineHandler<HiDreamO1Ctx, [ImageGenStepTemplate]>(
  (data, ctx) => {
    if (!data.aspectRatio) throw new Error('Aspect ratio is required for HiDream-O1 workflows');
    if (!data.model) throw new Error('Model is required for HiDream-O1 workflows');

    const isDev = data.model.id === hiDreamO1VersionIds.dev;
    const isEdit = data.workflow === 'img2img:edit';

    // LoRAs: Record<AIR, strength>
    const loras: Record<string, number> = {};
    if ('resources' in data && Array.isArray(data.resources)) {
      for (const resource of data.resources as ResourceData[]) {
        loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
      }
    }
    const lorasField = Object.keys(loras).length > 0 ? loras : undefined;

    // Edit-only: extract image URLs
    const images =
      isEdit && 'images' in data && Array.isArray(data.images)
        ? data.images.map((img) => img.url)
        : undefined;

    // Shared fields across all four variants
    const base = {
      engine: 'comfy' as const,
      ecosystem: 'hidream-o1' as const,
      prompt: data.prompt,
      negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
      steps: 'steps' in data ? data.steps : undefined,
      cfgScale: 'cfgScale' in data ? data.cfgScale : undefined,
      seed: data.seed,
      quantity: data.quantity ?? 1,
      checkpointModel: ctx.airs.getOrThrow(data.model.id),
      loras: lorasField,
    };

    let input:
      | ComfyHiDreamO1CreateImageGenInput
      | ComfyHiDreamO1EditImageGenInput
      | ComfyHiDreamO1DevCreateImageGenInput
      | ComfyHiDreamO1DevEditImageGenInput;

    if (isDev) {
      if (isEdit) {
        input = removeEmpty({
          ...base,
          operation: 'editImage',
          model: 'HiDream-O1-Image-dev',
          images,
        }) as ComfyHiDreamO1DevEditImageGenInput;
      } else {
        input = removeEmpty({
          ...base,
          operation: 'createImage',
          model: 'HiDream-O1-Image-dev',
        }) as ComfyHiDreamO1DevCreateImageGenInput;
      }
    } else {
      if (isEdit) {
        input = removeEmpty({
          ...base,
          operation: 'editImage',
          model: 'HiDream-O1-Image',
          images,
        }) as ComfyHiDreamO1EditImageGenInput;
      } else {
        input = removeEmpty({
          ...base,
          operation: 'createImage',
          model: 'HiDream-O1-Image',
        }) as ComfyHiDreamO1CreateImageGenInput;
      }
    }

    return [
      {
        $type: 'imageGen',
        input,
      } as ImageGenStepTemplate,
    ];
  }
);
