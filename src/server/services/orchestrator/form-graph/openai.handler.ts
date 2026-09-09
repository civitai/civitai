/** OpenAI handler for the form-graph lane — gpt-image 1/1.5/2/2.5, create/edit. */

import type {
  ImageGenStepTemplate,
  OpenAiGpt1CreateImageInput,
  OpenAiGpt1EditImageInput,
  OpenAiGpt15CreateImageInput,
  OpenAiGpt15EditImageInput,
  OpenAiGpt2CreateImageInput,
  OpenAiGpt2EditImageInput,
} from '@civitai/client';
import type {
  OpenAiGpt25FlareCreateImageInput,
  OpenAiGpt25FlareEditImageInput,
  OpenAiGpt25SunburstCreateImageInput,
  OpenAiGpt25SunburstEditImageInput,
} from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import { openaiVersionIds } from '~/shared/form-graph/generation/image/openai.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import type { EcosystemData } from './types';

type OpenAIModel =
  | 'gpt-image-1'
  | 'gpt-image-1.5'
  | 'gpt-image-2'
  | 'gpt-image-2.5-flare'
  | 'gpt-image-2.5-sunburst';
const versionIdToModel = new Map<number, OpenAIModel>([
  [openaiVersionIds.v1, 'gpt-image-1'],
  [openaiVersionIds['v1.5'], 'gpt-image-1.5'],
  [openaiVersionIds.v2, 'gpt-image-2'],
  [openaiVersionIds['v2.5-flare'], 'gpt-image-2.5-flare'],
  [openaiVersionIds['v2.5-sunburst'], 'gpt-image-2.5-sunburst'],
]);

/** gpt-image-2 and both 2.5 builds share one input shape: width/height, no background/seed. */
const WIDTH_HEIGHT_MODELS: readonly OpenAIModel[] = [
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
];

export const createOpenAIInput = defineHandler<EcosystemData<'OpenAI'>, [ImageGenStepTemplate]>(
  (data) => {
    const quantity = Math.min(data.quantity ?? 1, 10);

    const model: OpenAIModel =
      (data.model?.id != null ? versionIdToModel.get(data.model.id) : undefined) ?? 'gpt-image-1';

    const { width, height } = data.aspectRatio ?? { width: 1024, height: 1024 };
    const hasImages = !!data.images?.length;

    if (WIDTH_HEIGHT_MODELS.includes(model)) {
      const widthHeightBase = {
        engine: 'openai' as const,
        model,
        prompt: data.prompt,
        quality: data.quality,
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
                  ...widthHeightBase,
                  operation: 'editImage',
                  images: data.images?.map((x) => x.url) ?? [],
                }
              : { ...widthHeightBase, operation: 'createImage' }
          ) as
            | OpenAiGpt2CreateImageInput
            | OpenAiGpt2EditImageInput
            | OpenAiGpt25FlareCreateImageInput
            | OpenAiGpt25FlareEditImageInput
            | OpenAiGpt25SunburstCreateImageInput
            | OpenAiGpt25SunburstEditImageInput,
        },
      ];
    }

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
