/**
 * Chroma handler for the form-graph lane — emits an imageGen step.
 */

import type { ImageGenStepTemplate } from '@civitai/client';
import type { ComfyChromaCreateImageGenInput } from '@civitai/orchestration-client';
import { maxRandomSeed } from '~/server/common/constants';
import { samplersToComfySamplers } from '~/shared/constants/generation.constants';
import { removeEmpty } from '~/utils/object-helpers';
import { getRandomInt } from '~/utils/number-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import { resourcesToLoras, type EcosystemData } from './types';

export const createChromaInput = defineHandler<EcosystemData<'Chroma'>, [ImageGenStepTemplate]>(
  (data, ctx) => {
    if (!data.aspectRatio) throw new Error('Aspect ratio is required for Chroma workflows');

    const quantity = data.quantity ?? 1;
    const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;
    const sampler = data.sampler ?? 'Euler';

    if (!data.model) throw new Error('Model is required for Chroma imageGen workflows');

    // The endpoint has no `embeddings` field and the picker still offers textual inversions, so
    // they would have to ride in as loras — drop them instead.
    const loras = resourcesToLoras(
      (data.resources ?? []).filter((r) => r.model?.type !== 'TextualInversion'),
      ctx.airs
    );

    const comfy =
      samplersToComfySamplers[sampler as keyof typeof samplersToComfySamplers] ??
      samplersToComfySamplers['undefined'];

    const input: ComfyChromaCreateImageGenInput = {
      engine: 'comfy',
      ecosystem: 'chroma',
      operation: 'createImage',
      model: ctx.airs.getOrThrow(data.model.id),
      prompt: data.prompt,
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
      steps: data.steps ?? 28,
      cfgScale: data.cfgScale ?? 3.5,
      sampler: comfy.sampler,
      seed,
      quantity,
      outputFormat: data.outputFormat,
      loras,
    };

    return [{ $type: 'imageGen', input: removeEmpty(input) } as ImageGenStepTemplate];
  }
);
