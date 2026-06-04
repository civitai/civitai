/**
 * MAI Ecosystem Handler
 *
 * Handles MAI workflows using imageGen step type (FAL engine).
 * Uses Microsoft's MAI-Image-2.5 model for text-to-image generation.
 * Model is locked, no LoRA support.
 */

import type { ImageGenStepTemplate, MaiImageCreateFalImageGenInput } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type MAICtx = EcosystemGraphOutput & { ecosystem: 'MAI' };

type MAIAspectRatio = NonNullable<MaiImageCreateFalImageGenInput['aspectRatio']>;

/**
 * Creates imageGen input for the MAI ecosystem.
 * MAI-Image-2.5 only supports text-to-image (createImage) generation here.
 */
export const createMAIInput = defineHandler<MAICtx, [ImageGenStepTemplate]>((data) => {
  const quantity = data.quantity ?? 1;

  return [
    {
      $type: 'imageGen',
      input: removeEmpty({
        engine: 'fal',
        model: 'maiImage',
        operation: 'createImage',
        prompt: data.prompt,
        aspectRatio: data.aspectRatio?.value as MAIAspectRatio | undefined,
        quantity,
      }) as MaiImageCreateFalImageGenInput,
    },
  ];
});
