/**
 * Muse Image Ecosystem Handler
 *
 * Handles Muse Image workflows using imageGen step type (FAL engine).
 * Uses Meta's Muse Image model. Model is locked, no LoRA support.
 *
 * Routes by workflow:
 * - txt2img: text-to-image (createImage / MuseImageCreateFalImageGenInput)
 * - img2img:edit: reference-image editing (editImage / MuseImageEditFalImageGenInput)
 */

import type {
  ImageGenStepTemplate,
  MuseImageCreateFalImageGenInput,
  MuseImageEditFalImageGenInput,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type MuseImageCtx = EcosystemGraphOutput & { ecosystem: 'MuseImage' };

type MuseImageAspectRatio = NonNullable<MuseImageCreateFalImageGenInput['aspectRatio']>;

export const createMuseImageInput = defineHandler<MuseImageCtx, [ImageGenStepTemplate]>((data) => {
  const baseInput = {
    engine: 'fal' as const,
    model: 'museImage' as const,
    prompt: data.prompt,
    quantity: data.quantity ?? 1,
  };

  // img2img:edit — Muse Image derives the output ratio from the reference
  // images, so no aspect-ratio picker is shown ('auto').
  if (!data.workflow.startsWith('txt')) {
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...baseInput,
          operation: 'editImage',
          aspectRatio: 'auto',
          images: data.images?.map((x) => x.url) ?? [],
        }) as MuseImageEditFalImageGenInput,
      },
    ];
  }

  return [
    {
      $type: 'imageGen',
      input: removeEmpty({
        ...baseInput,
        operation: 'createImage',
        aspectRatio: data.aspectRatio?.value as MuseImageAspectRatio | undefined,
      }) as MuseImageCreateFalImageGenInput,
    },
  ];
});
