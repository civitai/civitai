/**
 * Flux2 handler for the form-graph lane — imageGen steps; the mode derives
 * from the model version id, and only dev carries LoRAs.
 */

import type {
  Flux2DevImageGenInput,
  Flux2FlexImageGenInput,
  Flux2MaxImageGenInput,
  Flux2ProImageGenInput,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { flux2ModeOf, type Flux2Mode } from '~/shared/form-graph/generation/image/flux2.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import type { EcosystemData } from './types';

type Flux2Input =
  | Flux2DevImageGenInput
  | Flux2FlexImageGenInput
  | Flux2ProImageGenInput
  | Flux2MaxImageGenInput;

export const createFlux2Input = defineHandler<EcosystemData<'Flux2'>, [ImageGenStepTemplate]>(
  (data, ctx) => {
    const model: Flux2Mode = flux2ModeOf(data.model);

    const loras: { air: string; strength: number }[] = [];
    if (model === 'dev' && 'resources' in data && data.resources?.length) {
      for (const resource of data.resources) {
        loras.push({
          air: ctx.airs.getOrThrow(resource.id),
          strength: resource.strength ?? 1,
        });
      }
    }

    const hasImages = !!data.images?.length;

    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          engine: 'flux2',
          model,
          operation: hasImages ? 'editImage' : 'createImage',
          prompt: data.prompt,
          width: data.aspectRatio?.width,
          height: data.aspectRatio?.height,
          guidanceScale: data.cfgScale,
          numInferenceSteps: data.steps,
          quantity: data.quantity ?? 1,
          seed: data.seed,
          loras: loras.length > 0 ? loras : undefined,
          images: hasImages ? data.images?.map((x) => x.url) : undefined,
        }) as Flux2Input,
      },
    ];
  }
);
