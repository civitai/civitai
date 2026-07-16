/**
 * Reve Ecosystem Handler
 *
 * Handles Reve workflows using imageGen step type (FAL engine).
 * Uses Reve AI's Reve 2.1 model. Model is locked, no LoRA support.
 *
 * Routes by workflow:
 * - txt2img: text-to-image (createImage / ReveCreateFalImageGenInput)
 * - img2img:edit: reference-frame editing (editImage / ReveEditFalImageGenInput)
 */

import type {
  ImageGenStepTemplate,
  ReveCreateFalImageGenInput,
  ReveEditFalImageGenInput,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type ReveCtx = EcosystemGraphOutput & { ecosystem: 'Reve' };

type ReveAspectRatio = NonNullable<ReveCreateFalImageGenInput['aspectRatio']>;

/**
 * Creates imageGen input for the Reve ecosystem.
 * Routes to createImage (txt2img) or editImage (img2img:edit) based on workflow.
 */
export const createReveInput = defineHandler<ReveCtx, [ImageGenStepTemplate]>((data) => {
  const quantity = data.quantity ?? 1;

  const baseInput = {
    engine: 'fal' as const,
    model: 'reve' as const,
    prompt: data.prompt,
    quantity,
  };

  // img2img:edit — reference-frame editing. Reve derives the output ratio from
  // the reference frames, so no aspect-ratio picker is shown ('auto').
  if (!data.workflow.startsWith('txt')) {
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...baseInput,
          operation: 'editImage',
          aspectRatio: 'auto',
          images: data.images?.map((x) => x.url) ?? [],
        }) as ReveEditFalImageGenInput,
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
        aspectRatio: data.aspectRatio?.value as ReveAspectRatio | undefined,
      }) as ReveCreateFalImageGenInput,
    },
  ];
});
