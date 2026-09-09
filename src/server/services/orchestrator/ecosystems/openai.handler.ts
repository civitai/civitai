/**
 * OpenAI Ecosystem Handler
 *
 * Handles OpenAI workflows using imageGen step type.
 * Supports gpt-image-1, gpt-image-1.5, gpt-image-2 and the two gpt-image-2.5
 * builds (flare, sunburst).
 *
 * gpt-image-2 and 2.5 share an API shape that differs from the v1/v1.5 family:
 * - Uses numeric `width`/`height` instead of a `size` enum string
 * - No `background` (transparent toggle unsupported)
 * - No `seed` field
 *
 * The 2.5 builds differ from each other only in the `model` literal.
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
import type {
  OpenAiGpt25FlareCreateImageInput,
  OpenAiGpt25FlareEditImageInput,
  OpenAiGpt25SunburstCreateImageInput,
  OpenAiGpt25SunburstEditImageInput,
} from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { openaiVersionIds } from '~/shared/data-graph/generation/openai-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type OpenAICtx = EcosystemGraphOutput & { ecosystem: 'OpenAI' };

// Map from version ID to API model name
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

const WIDTH_HEIGHT_MODELS: readonly OpenAIModel[] = [
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
];

type WidthHeightCreateInput =
  | OpenAiGpt2CreateImageInput
  | OpenAiGpt25FlareCreateImageInput
  | OpenAiGpt25SunburstCreateImageInput;
type WidthHeightEditInput =
  | OpenAiGpt2EditImageInput
  | OpenAiGpt25FlareEditImageInput
  | OpenAiGpt25SunburstEditImageInput;

/**
 * Creates imageGen input for OpenAI ecosystem.
 * Handles both createImage and editImage operations across GPT-1/1.5/2/2.5.
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
  // GPT-Image-2 / 2.5: distinct input shape — width/height numbers, no background/seed
  // ---------------------------------------------------------------------------
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

    if (!hasImages) {
      return [
        {
          $type: 'imageGen',
          input: removeEmpty({
            ...widthHeightBase,
            operation: 'createImage',
          }) as WidthHeightCreateInput,
        },
      ];
    }

    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          ...widthHeightBase,
          operation: 'editImage',
          images: data.images?.map((x) => x.url) ?? [],
        }) as WidthHeightEditInput,
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
