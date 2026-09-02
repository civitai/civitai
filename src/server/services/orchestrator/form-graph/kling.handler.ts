/**
 * Kling handler for the form-graph lane — legacy engine (`kling`) for
 * V1.6/V2/V2.5 Turbo, `kling-v3` for V3. V3's multiShot/klingElements subtree
 * is dead in v1 and not ported, so the elements/multiPrompt build is omitted.
 */

import type {
  KlingVideoGenInput,
  KlingV3VideoGenInput,
  KlingModel,
  VideoGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { klingVersionIds } from '~/shared/data-graph/generation/version-ids';
import { defineHandler } from '../ecosystems/handler-factory';
import type { LooseGenerationData } from './types';

const versionIdToModel = new Map<number, KlingModel>([
  [klingVersionIds.v1_6, 'v1.6'],
  [klingVersionIds.v2, 'v2'],
  [klingVersionIds.v2_5_turbo, 'v2.5-turbo'],
]);

export const createKlingInput = defineHandler<LooseGenerationData, [VideoGenStepTemplate]>(
  (data) => {
    const input =
      (data as { klingVersion?: string }).klingVersion === 'v3'
        ? createV3Input(data)
        : createLegacyInput(data);
    return [{ $type: 'videoGen', input }];
  }
);

function createLegacyInput(data: LooseGenerationData): KlingVideoGenInput {
  const model: KlingModel =
    (data.model ? versionIdToModel.get(data.model.id) : undefined) ?? 'v1.6';

  return removeEmpty({
    engine: 'kling',
    model,
    prompt: data.prompt,
    negativePrompt: data.negativePrompt,
    aspectRatio: data.aspectRatio?.value as KlingVideoGenInput['aspectRatio'],
    mode: (data as { mode?: string }).mode,
    duration: (data as { duration?: string }).duration,
    cfgScale: data.cfgScale,
    sourceImage: data.images?.[0]?.url,
    quantity: data.quantity ?? 1,
    seed: data.seed,
    enablePromptEnhancer: (data as { enablePromptEnhancer?: boolean }).enablePromptEnhancer,
  }) as KlingVideoGenInput;
}

function createV3Input(data: LooseGenerationData): KlingV3VideoGenInput {
  const hasImages = !!data.images?.length;
  const isRef2Vid = (data as { operation?: string }).operation === 'reference-to-video';

  return removeEmpty({
    engine: 'kling-v3' as const,
    prompt: data.prompt,
    operation: (data as { operation?: string }).operation,
    mode: (data as { mode?: string }).mode,
    duration: data.duration != null ? Number(data.duration) : undefined,
    aspectRatio: data.aspectRatio?.value as KlingV3VideoGenInput['aspectRatio'],
    // ref2vid sends images as an array; img2vid uses sourceImage/endImage slots
    sourceImage: !isRef2Vid && hasImages ? data.images?.[0]?.url : undefined,
    endImage: !isRef2Vid && hasImages ? data.images?.[1]?.url : undefined,
    images: isRef2Vid && hasImages ? data.images?.map((img) => img.url) : undefined,
    generateAudio: (data as { generateAudio?: boolean }).generateAudio,
    quantity: data.quantity ?? 1,
    seed: data.seed,
  }) as KlingV3VideoGenInput;
}
