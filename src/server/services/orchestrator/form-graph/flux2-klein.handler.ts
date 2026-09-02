/**
 * Flux2 Klein handler for the form-graph lane — imageGen steps; the variant
 * derives from the ecosystem, and distilled variants pin steps/cfg.
 */

import type {
  Flux2KleinCreateImageInput,
  Flux2KleinEditImageInput,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { Flux2KleinMode } from '~/shared/form-graph/generation/image/flux2-klein.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import { resourcesToLoras } from './types';
import type { EcosystemData } from './types';

type Flux2KleinInput = Flux2KleinCreateImageInput | Flux2KleinEditImageInput;

const baseModelToVariant: Record<string, Flux2KleinMode> = {
  Flux2Klein_9B: '9b',
  Flux2Klein_9B_base: '9b-base',
  Flux2Klein_4B: '4b',
  Flux2Klein_4B_base: '4b-base',
};

const variantDefaults: Record<Flux2KleinMode, { steps: number; cfgScale: number }> = {
  '9b': { steps: 12, cfgScale: 1 },
  '9b-base': { steps: 20, cfgScale: 2.5 },
  '4b': { steps: 12, cfgScale: 1 },
  '4b-base': { steps: 20, cfgScale: 2.5 },
};

export const createFlux2KleinInput = defineHandler<
  EcosystemData<'Flux2Klein_9B' | 'Flux2Klein_9B_base' | 'Flux2Klein_4B' | 'Flux2Klein_4B_base'>,
  [ImageGenStepTemplate]
>((data, ctx) => {
  const modelVersion = baseModelToVariant[data.ecosystem] ?? '9b';
  const isDistilled = modelVersion === '9b' || modelVersion === '4b';
  const defaults = variantDefaults[modelVersion];

  const loras = resourcesToLoras(data.resources, ctx.airs);

  const hasImages = !!data.images?.length;

  const steps = isDistilled ? defaults.steps : data.steps ?? defaults.steps;
  const cfgScale = isDistilled
    ? defaults.cfgScale
    : ('cfgScale' in data ? data.cfgScale : undefined) ?? defaults.cfgScale;

  return [
    {
      $type: 'imageGen',
      input: removeEmpty({
        engine: 'flux2',
        model: 'klein',
        modelVersion,
        operation: hasImages ? 'editImage' : 'createImage',
        prompt: data.prompt,
        negativePrompt: data.negativePrompt,
        width: data.aspectRatio?.width,
        height: data.aspectRatio?.height,
        cfgScale,
        steps,
        sampleMethod: ('sampler' in data ? data.sampler : undefined) ?? 'euler',
        schedule: ('scheduler' in data ? data.scheduler : undefined) ?? 'simple',
        quantity: data.quantity ?? 1,
        seed: data.seed,
        loras,
        images: hasImages ? data.images?.map((x) => x.url) : undefined,
      }) as Flux2KleinInput,
    },
  ];
});
