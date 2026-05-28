/**
 * Krea 2 Ecosystem Handler
 *
 * Handles Krea 2 workflows using imageGen step type (FAL engine).
 * Model is locked, no LoRA support.
 *
 * The selected model version maps to the `size` tier (medium/large) the
 * orchestrator expects.
 */

import type {
  ImageGenStepTemplate,
  Krea2FalImageGenInput,
  Krea2StyleReference,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { krea2VersionIdToSize } from '~/shared/data-graph/generation/krea2-graph';
import { defineHandler } from './handler-factory';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type Krea2Ctx = EcosystemGraphOutput & { ecosystem: 'Krea2' };

type Krea2AspectRatio = NonNullable<Krea2FalImageGenInput['aspectRatio']>;
type Krea2Creativity = NonNullable<Krea2FalImageGenInput['creativity']>;

export const createKrea2Input = defineHandler<Krea2Ctx, [ImageGenStepTemplate]>((data) => {
  const quantity = data.quantity ?? 1;
  const size = data.model ? krea2VersionIdToSize.get(data.model.id) : undefined;

  const styleRefs =
    'styleReferences' in data && Array.isArray(data.styleReferences) ? data.styleReferences : [];
  const imageStyleReferences: Krea2StyleReference[] = styleRefs.map((ref) => ({
    imageUrl: ref.image.url,
    strength: ref.strength,
  }));

  return [
    {
      $type: 'imageGen',
      input: removeEmpty({
        engine: 'fal',
        model: 'krea2',
        operation: 'createImage',
        prompt: data.prompt,
        aspectRatio: data.aspectRatio?.value as Krea2AspectRatio | undefined,
        size,
        creativity: 'creativity' in data ? (data.creativity as Krea2Creativity) : undefined,
        seed: data.seed,
        quantity,
        imageStyleReferences,
      }) as Krea2FalImageGenInput,
    },
  ];
});
