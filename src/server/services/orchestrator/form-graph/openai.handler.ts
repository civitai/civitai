/** OpenAI handler for the form-graph lane — gpt-image 1/1.5/2, create/edit. */

import type {
  ImageGenStepTemplate,
  OpenAiGpt1CreateImageInput,
  OpenAiGpt1EditImageInput,
  OpenAiGpt15CreateImageInput,
  OpenAiGpt15EditImageInput,
  OpenAiGpt2CreateImageInput,
  OpenAiGpt2EditImageInput,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { openaiVersionIds } from '~/shared/form-graph/generation/image/openai.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import type { LooseGenerationData } from './types';

type OpenAIModel = 'gpt-image-1' | 'gpt-image-1.5' | 'gpt-image-2';
const versionIdToModel = new Map<number, OpenAIModel>([
  [openaiVersionIds.v1, 'gpt-image-1'],
  [openaiVersionIds['v1.5'], 'gpt-image-1.5'],
  [openaiVersionIds.v2, 'gpt-image-2'],
]);

export const createOpenAIInput = defineHandler<LooseGenerationData, [ImageGenStepTemplate]>(
  (data) => {
    const quantity = Math.min(data.quantity ?? 1, 10);

    const model: OpenAIModel =
      (data.model?.id != null ? versionIdToModel.get(data.model.id) : undefined) ?? 'gpt-image-1';

    const { width, height } = data.aspectRatio ?? { width: 1024, height: 1024 };
    const hasImages = !!data.images?.length;

    if (model === 'gpt-image-2') {
      const gpt2Base = {
        engine: 'openai' as const,
        model: 'gpt-image-2' as const,
        prompt: data.prompt,
        quality: (data as { quality?: string }).quality,
        quantity,
        width,
        height,
      };

      return [
        {
          $type: 'imageGen',
          input: removeEmpty(
            hasImages
              ? {
                  ...gpt2Base,
                  operation: 'editImage',
                  images: data.images?.map((x) => x.url) ?? [],
                }
              : { ...gpt2Base, operation: 'createImage' }
          ) as OpenAiGpt2CreateImageInput | OpenAiGpt2EditImageInput,
        },
      ];
    }

    const background = (data as { transparent?: boolean }).transparent ? 'transparent' : 'opaque';

    const gpt1Base = {
      engine: 'openai',
      model,
      prompt: data.prompt,
      background,
      quantity,
      quality: (data as { quality?: string }).quality,
      size: `${width}x${height}`,
      seed: data.seed,
    };

    return [
      {
        $type: 'imageGen',
        input: removeEmpty(
          hasImages
            ? { ...gpt1Base, operation: 'editImage', images: data.images?.map((x) => x.url) ?? [] }
            : { ...gpt1Base, operation: 'createImage' }
        ) as
          | OpenAiGpt1CreateImageInput
          | OpenAiGpt15CreateImageInput
          | OpenAiGpt1EditImageInput
          | OpenAiGpt15EditImageInput,
      },
    ];
  }
);
