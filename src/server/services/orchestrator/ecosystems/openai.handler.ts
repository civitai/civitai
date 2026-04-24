/**
 * OpenAI Ecosystem Handler
 *
 * Handles OpenAI workflows using imageGen step type.
 * Supports gpt-image-1, gpt-image-1.5, and gpt-image-2 models.
 *
 * gpt-image-2 has a distinct API shape vs the v1/v1.5 family:
 * - Uses numeric `width`/`height` instead of a `size` enum string
 * - No `background` (transparent toggle unsupported)
 * - No `seed` field
 */

import type {
  OpenAiGpt1CreateImageInput,
  OpenAiGpt1EditImageInput,
  OpenAiGpt15CreateImageInput,
  OpenAiGpt15EditImageInput,
  OpenAiGpt2CreateImageInput,
  OpenAiGpt2EditImageInput,
  ImageGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { openaiVersionIds } from '~/shared/data-graph/generation/openai-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type OpenAICtx = EcosystemGraphOutput & { ecosystem: 'OpenAI' };

// Map from version ID to API model name
type OpenAIModel = 'gpt-image-1' | 'gpt-image-1.5' | 'gpt-image-2';
const versionIdToModel = new Map<number, OpenAIModel>([
  [openaiVersionIds.v1, 'gpt-image-1'],
  [openaiVersionIds['v1.5'], 'gpt-image-1.5'],
  [openaiVersionIds.v2, 'gpt-image-2'],
]);

/**
 * Creates imageGen input for OpenAI ecosystem.
 * Handles both createImage and editImage operations across GPT-1/1.5/2.
 */
export const createOpenAIInput = defineHandler<OpenAICtx, [ImageGenStepTemplate]>((data) => {
  const quantity = Math.min(data.quantity ?? 1, 10);

  // Determine model from resources
  let model: OpenAIModel = 'gpt-image-1';
  if (data.model) {
    const match = versionIdToModel.get(data.model.id);
    if (match) model = match;
  }

  const { width, height } = data.aspectRatio;
  const hasImages = !!data.images?.length;

  // ---------------------------------------------------------------------------
  // GPT-Image-2: distinct input shape — width/height numbers, no background/seed
  // ---------------------------------------------------------------------------
  if (model === 'gpt-image-2') {
    const gpt2Base = {
      engine: 'openai' as const,
      model: 'gpt-image-2' as const,
      prompt: data.prompt,
      quality: data.quality,
      quantity,
      width,
      height,
    };

    if (!hasImages) {
      return [
        {
          $type: 'imageGen',
          input: removeEmpty({
            ...gpt2Base,
            operation: 'createImage',
          }) as OpenAiGpt2CreateImageInput,
        },
      ];
    }

    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...gpt2Base,
          operation: 'editImage',
          images: data.images?.map((x) => x.url) ?? [],
        }) as OpenAiGpt2EditImageInput,
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // GPT-Image-1 / GPT-Image-1.5
  // ---------------------------------------------------------------------------
  const background = 'transparent' in data && data.transparent ? 'transparent' : 'opaque';

  const gpt1Base = {
    engine: 'openai',
    model,
    prompt: data.prompt,
    background,
    quantity,
    quality: data.quality,
    size: `${width}x${height}`,
    seed: data.seed,
  };

  if (!hasImages) {
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...gpt1Base,
          operation: 'createImage',
        }) as OpenAiGpt1CreateImageInput | OpenAiGpt15CreateImageInput,
      },
    ];
  }

  return [
    {
      $type: 'imageGen',
      input: removeEmpty({
        ...gpt1Base,
        operation: 'editImage',
        images: data.images?.map((x) => x.url) ?? [],
      }) as OpenAiGpt1EditImageInput | OpenAiGpt15EditImageInput,
    },
  ];
});
