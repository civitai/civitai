/**
 * Flux2 Klein Ecosystem Handler
 *
 * Handles Flux2 Klein workflows (9B, 9B Base, 4B, 4B Base) using imageGen step type.
 * Supports LoRA resources, negative prompts, and samplers.
 */

import type { Flux2KleinCreateImageInput, Flux2KleinEditImageInput } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { defineHandler } from './handler-factory';
import type { Flux2KleinMode } from '~/shared/data-graph/generation/flux2-klein-graph';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type Flux2KleinCtx = EcosystemGraphOutput & {
  baseModel: 'Flux2Klein_9B' | 'Flux2Klein_9B_base' | 'Flux2Klein_4B' | 'Flux2Klein_4B_base';
};

// Return type union
type Flux2KleinInput = Flux2KleinCreateImageInput | Flux2KleinEditImageInput;

// Map baseModel to model variant
const baseModelToVariant: Record<string, Flux2KleinMode> = {
  Flux2Klein_9B: '9b',
  Flux2Klein_9B_base: '9b-base',
  Flux2Klein_4B: '4b',
  Flux2Klein_4B_base: '4b-base',
};

// Default values per variant (distilled vs base)
const variantDefaults: Record<Flux2KleinMode, { steps: number; cfgScale: number }> = {
  '9b': { steps: 12, cfgScale: 1 },
  '9b-base': { steps: 20, cfgScale: 2.5 },
  '4b': { steps: 12, cfgScale: 1 },
  '4b-base': { steps: 20, cfgScale: 2.5 },
};

/**
 * Creates imageGen input for Flux2 Klein ecosystem.
 * Handles both txt2img and img2img operations.
 * All variants support LoRA resources.
 */
export const createFlux2KleinInput = defineHandler<Flux2KleinCtx, Flux2KleinInput>((data, ctx) => {
  const quantity = data.quantity ?? 1;

  // Determine model variant from baseModel
  const modelVersion = baseModelToVariant[data.baseModel] ?? '9b';
  const isDistilled = modelVersion === '9b' || modelVersion === '4b';
  const defaults = variantDefaults[modelVersion];

  // Build loras from additional resources
  const loras: Record<string, number> = {};
  if ('resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
    }
  }

  const hasImages = !!data.images?.length;
  const operation = hasImages ? 'editImage' : 'createImage';

  // For distilled variants, use fixed steps/cfgScale
  const steps = isDistilled ? defaults.steps : 'steps' in data ? data.steps : defaults.steps;
  const cfgScale = isDistilled
    ? defaults.cfgScale
    : 'cfgScale' in data
    ? data.cfgScale
    : defaults.cfgScale;

  return removeEmpty({
    engine: 'flux2',
    model: 'klein',
    modelVersion,
    operation,
    prompt: data.prompt,
    negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
    width: data.aspectRatio?.width,
    height: data.aspectRatio?.height,
    cfgScale,
    steps,
    sampleMethod: 'sampler' in data ? data.sampler : 'euler',
    schedule: 'simple',
    quantity,
    seed: data.seed,
    loras: Object.keys(loras).length > 0 ? loras : undefined,
    images: hasImages ? data.images?.map((x) => x.url) : undefined,
  }) as Flux2KleinInput;
});
