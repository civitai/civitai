/**
 * MAI Ecosystem Handler
 *
 * Handles MAI workflows using imageGen step type (FAL engine).
 * Uses Microsoft's MAI-Image-2.5 model. Model is locked, no LoRA support.
 *
 * Routes by workflow:
 * - txt2img: text-to-image (createImage / MaiImageCreateFalImageGenInput)
 * - img2img:edit: reference-image editing (editImage / MaiImageEditFalImageGenInput)
 */

import type {
  ImageGenStepTemplate,
  MaiImageCreateFalImageGenInput,
  MaiImageEditFalImageGenInput,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { maiCropAspectRatios } from '~/shared/data-graph/generation/mai-graph';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import { defineHandler } from './handler-factory';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type MAICtx = EcosystemGraphOutput & { ecosystem: 'MAI' };

type MAIAspectRatio = NonNullable<MaiImageCreateFalImageGenInput['aspectRatio']>;

/**
 * Creates imageGen input for the MAI ecosystem.
 * Routes to createImage (txt2img) or editImage (img2img:edit) based on workflow.
 */
export const createMAIInput = defineHandler<MAICtx, [ImageGenStepTemplate]>((data) => {
  const quantity = data.quantity ?? 1;

  const baseInput = {
    engine: 'fal' as const,
    model: 'maiImage' as const,
    prompt: data.prompt,
    quantity,
  };

  // img2img:edit — reference-image editing. There's no aspect-ratio picker;
  // the output ratio is derived from the (cropped) reference image.
  if (!data.workflow.startsWith('txt')) {
    const firstImage = data.images?.[0];
    const aspectRatio =
      firstImage?.width && firstImage?.height
        ? (findClosestAspectRatio(
            { width: firstImage.width, height: firstImage.height },
            maiCropAspectRatios
          ) as MAIAspectRatio)
        : undefined;

    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...baseInput,
          operation: 'editImage',
          aspectRatio,
          images: data.images?.map((x) => x.url) ?? [],
        }) as MaiImageEditFalImageGenInput,
      },
    ];
  }

  // txt2img — text-to-image
  return [
    {
      $type: 'imageGen',
      input: removeEmpty({
        ...baseInput,
        operation: 'createImage',
        aspectRatio: data.aspectRatio?.value as MAIAspectRatio | undefined,
      }) as MaiImageCreateFalImageGenInput,
    },
  ];
});
