/**
 * Flux.3 Klein handler for the form-graph lane — comfy imageGen steps. The
 * model derives from the ecosystem; the distilled model takes no steps/cfg.
 */

import type {
  ComfyFlux3KleinBaseCreateImageInput,
  ComfyFlux3KleinBaseEditImageInput,
  ComfyFlux3KleinDistilledCreateImageInput,
  ComfyFlux3KleinDistilledEditImageInput,
  ImageGenStepTemplate,
} from '@civitai/orchestration-client';
import { flux3KleinModeOf } from '~/shared/form-graph/generation/image/flux3-klein.graph';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../handlers/handler-factory';
import { resourcesToLoras } from './types';
import type { EcosystemData } from './types';

type Flux3KleinInput =
  | ComfyFlux3KleinDistilledCreateImageInput
  | ComfyFlux3KleinDistilledEditImageInput
  | ComfyFlux3KleinBaseCreateImageInput
  | ComfyFlux3KleinBaseEditImageInput;

export const createFlux3KleinInput = defineHandler<
  EcosystemData<'Flux3Klein' | 'Flux3Klein_base'>,
  [ImageGenStepTemplate]
>((data, ctx) => {
  const model = flux3KleinModeOf(data.ecosystem);
  const isBase = model === 'base';
  const hasImages = !!data.images?.length;

  return [
    {
      $type: 'imageGen',
      input: removeEmpty<Flux3KleinInput>({
        engine: 'comfy',
        ecosystem: 'flux3Klein',
        model,
        operation: hasImages ? 'editImage' : 'createImage',
        prompt: data.prompt,
        negativePrompt: isBase ? data.negativePrompt : undefined,
        width: data.aspectRatio?.width,
        height: data.aspectRatio?.height,
        steps: isBase && 'steps' in data ? data.steps : undefined,
        cfgScale: isBase && 'cfgScale' in data ? data.cfgScale : undefined,
        quantity: data.quantity ?? 1,
        seed: data.seed,
        loras: resourcesToLoras(data.resources, ctx.airs),
        images: data.images?.map((x) => x.url) ?? [],
      }),
    },
  ];
});
