/** Kling handler — legacy engine for V1.6/V2/V2.5 Turbo, `kling-v3` and `kling-v4` for V3 and V4. */

import type {
  KlingVideoGenInput,
  KlingV3VideoGenInput,
  KlingV4VideoGenInput,
  KlingModel,
  VideoGenStepTemplate,
} from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import { klingVersionIds } from '~/shared/generation/version-ids';
import { defineHandler } from '../handlers/handler-factory';
import type { EcosystemData } from './types';

type KlingData = EcosystemData<'Kling'>;
type KlingLegacyData = Extract<KlingData, { klingVersion: 'legacy' }>;
type KlingV3Data = Extract<KlingData, { klingVersion: 'v3' }>;
type KlingV4Data = Extract<KlingData, { klingVersion: 'v4' }>;

const versionIdToModel = new Map<number, KlingModel>([
  [klingVersionIds.v1_6, 'v1.6'],
  [klingVersionIds.v2, 'v2'],
  [klingVersionIds.v2_5_turbo, 'v2.5-turbo'],
]);

export const createKlingInput = defineHandler<KlingData, [VideoGenStepTemplate]>((data) => {
  const input =
    data.klingVersion === 'v4'
      ? createV4Input(data)
      : data.klingVersion === 'v3'
      ? createV3Input(data)
      : createLegacyInput(data);
  return [{ $type: 'videoGen', input }];
});

function createV4Input(data: KlingV4Data): KlingV4VideoGenInput {
  const images = data.images?.map((img) => img.url);
  const isKeyframes = data.operation === 'imageToVideo';
  const isEdit = data.operation === 'videoToVideoEdit';
  if (isEdit && !data.video?.url) throw new Error('A source video is required for vid2vid:edit');

  return removeEmpty({
    engine: 'kling-v4' as const,
    operation: data.operation,
    prompt: data.prompt,
    duration: data.duration,
    resolution: data.resolution,
    aspectRatio: data.aspectRatio?.value as KlingV4VideoGenInput['aspectRatio'],
    sourceImage: isKeyframes ? images?.[0] : undefined,
    endImage: isKeyframes ? images?.[1] : undefined,
    images: isKeyframes ? undefined : images,
    videoUrl: isEdit ? data.video?.url : undefined,
    quantity: data.quantity ?? 1,
  }) as KlingV4VideoGenInput;
}

function createLegacyInput(data: KlingLegacyData): KlingVideoGenInput {
  const model: KlingModel =
    (data.model ? versionIdToModel.get(data.model.id) : undefined) ?? 'v1.6';

  return removeEmpty({
    engine: 'kling',
    model,
    prompt: data.prompt,
    negativePrompt: data.negativePrompt,
    aspectRatio: data.aspectRatio?.value as KlingVideoGenInput['aspectRatio'],
    mode: data.mode,
    duration: data.duration,
    cfgScale: data.cfgScale,
    sourceImage: data.images?.[0]?.url,
    quantity: data.quantity ?? 1,
    seed: data.seed,
    enhancePrompt: data.enablePromptEnhancer,
  }) as KlingVideoGenInput;
}

function createV3Input(data: KlingV3Data): KlingV3VideoGenInput {
  const hasImages = !!data.images?.length;
  const isRef2Vid = data.operation === 'reference-to-video';

  return removeEmpty({
    engine: 'kling-v3' as const,
    prompt: data.prompt,
    operation: data.operation,
    mode: data.mode,
    duration: data.duration != null ? Number(data.duration) : undefined,
    aspectRatio: data.aspectRatio?.value as KlingV3VideoGenInput['aspectRatio'],
    // ref2vid sends images as an array; img2vid uses sourceImage/endImage slots
    sourceImage: !isRef2Vid && hasImages ? data.images?.[0]?.url : undefined,
    endImage: !isRef2Vid && hasImages ? data.images?.[1]?.url : undefined,
    images: isRef2Vid && hasImages ? data.images?.map((img) => img.url) : undefined,
    generateAudio: data.generateAudio,
    quantity: data.quantity ?? 1,
    seed: data.seed,
  }) as KlingV3VideoGenInput;
}
