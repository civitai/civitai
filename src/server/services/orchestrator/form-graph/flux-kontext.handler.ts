/**
 * Flux Kontext handler for the form-graph lane — imageGen steps; the mode
 * (pro/max) derives from the model version id.
 */

import type {
  Flux1KontextMaxImageGenInput,
  Flux1KontextProImageGenInput,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import {
  fluxKontextModeOf,
  type FluxKontextMode,
} from '~/shared/form-graph/generation/image/flux-kontext.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import type { LooseGenerationData } from './types';

type FluxKontextInput = Flux1KontextProImageGenInput | Flux1KontextMaxImageGenInput;

export const createFluxKontextInput = defineHandler<LooseGenerationData, [ImageGenStepTemplate]>(
  (data) => {
    const model: FluxKontextMode = fluxKontextModeOf(data.model);

    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          engine: 'flux1-kontext',
          model,
          prompt: data.prompt,
          images: data.images?.map((x) => x.url),
          aspectRatio: data.aspectRatio?.value,
          quantity: data.quantity ?? 1,
          guidanceScale: data.cfgScale,
          seed: data.seed,
        }) as FluxKontextInput,
      },
    ];
  }
);
