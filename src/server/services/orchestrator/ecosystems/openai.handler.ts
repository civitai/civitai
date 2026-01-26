/**
 * OpenAI Ecosystem Handler
 *
 * Handles OpenAI workflows using imageGen step type.
 * Supports gpt-image-1 and gpt-image-1.5 models.
 */

import type {
  OpenAiGpt1CreateImageInput,
  OpenAiGpt1EditImageInput,
  OpenAiGpt15CreateImageInput,
  OpenAiGpt15EditImageInput,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { openaiVersionIds } from '~/shared/data-graph/generation/openai-graph';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type OpenAICtx = EcosystemGraphOutput & { baseModel: 'OpenAI' };

// Return type union
type OpenAIInput =
  | OpenAiGpt1CreateImageInput
  | OpenAiGpt1EditImageInput
  | OpenAiGpt15CreateImageInput
  | OpenAiGpt15EditImageInput;

// OpenAI supported sizes (for aspect ratio matching)
const openAISizes = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
];

// Map from version ID to API model name
type OpenAIModel = 'gpt-image-1' | 'gpt-image-1.5';
const versionIdToModel = new Map<number, OpenAIModel>([
  [openaiVersionIds.v1, 'gpt-image-1'],
  [openaiVersionIds['v1.5'], 'gpt-image-1.5'],
]);

/**
 * Creates imageGen input for OpenAI ecosystem.
 * Handles both createImage and editImage operations.
 */
export async function createOpenAIInput(data: OpenAICtx): Promise<OpenAIInput> {
  const quantity = Math.min(data.quantity ?? 1, 10);

  // Determine model from resources
  let model: OpenAIModel = 'gpt-image-1';
  if (data.model) {
    const match = versionIdToModel.get(data.model.id);
    if (match) model = match;
  }

  // Find closest supported size
  const { width, height } = data.aspectRatio
    ? findClosestAspectRatio(data.aspectRatio, openAISizes)
    : { width: 1024, height: 1024 };

  // Get background setting
  const background =
    'openAITransparentBackground' in data && data.openAITransparentBackground
      ? 'transparent'
      : 'opaque';

  // Get quality setting
  const quality = 'openAIQuality' in data ? data.openAIQuality : undefined;

  const baseData = {
    engine: 'openai',
    model,
    prompt: data.prompt,
    background,
    quantity,
    quality,
    size: `${width}x${height}`,
    seed: data.seed,
  };

  const hasImages = !!data.images?.length;
  if (!hasImages) {
    return removeEmpty({
      ...baseData,
      operation: 'createImage',
    }) as OpenAIInput;
  } else {
    return removeEmpty({
      ...baseData,
      operation: 'editImage',
      images: data.images?.map((x) => x.url) ?? [],
    }) as OpenAIInput;
  }
}
