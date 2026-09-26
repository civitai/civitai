/**
 * Chroma Ecosystem Handler
 *
 * Emits an imageGen step.
 */

import type { ImageGenStepTemplate } from '@civitai/client';
import type { ComfyChromaCreateImageGenInput } from '@civitai/orchestration-client';
import { maxRandomSeed } from '~/server/common/constants';
import { samplersToComfySamplers } from '~/shared/constants/generation.constants';
import { removeEmpty } from '~/utils/object-helpers';
import { getRandomInt } from '~/utils/number-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type ChromaCtx = EcosystemGraphOutput & { ecosystem: 'Chroma' };

/**
 * Creates step input for Chroma ecosystem.
 */
export const createChromaInput = defineHandler<ChromaCtx, [ImageGenStepTemplate]>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for Chroma workflows');

  const quantity = data.quantity ?? 1;
  const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;
  const sampler = data.sampler ?? 'Euler';

  if (!data.model) throw new Error('Model is required for Chroma imageGen workflows');

  // The endpoint has no `embeddings` field and the picker still offers textual inversions, so
  // they would have to ride in as loras — drop them instead.
  const loras: Record<string, number> = {};
  for (const resource of data.resources ?? []) {
    if (resource.model?.type === 'TextualInversion') continue;
    loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
  }

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
    loras: Object.keys(loras).length ? loras : undefined,
  };

  return [{ $type: 'imageGen', input: removeEmpty(input) } as ImageGenStepTemplate];
});
