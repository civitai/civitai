/**
 * Kling handler for the form-graph lane — legacy engine (`kling`) for
 * V1.6/V2/V2.5 Turbo, `kling-v3` for V3, `kling-v4` for V4. V3's multiShot/klingElements
 * subtree is not built (see `video/kling.graph.ts`); V4's is.
 */

import type {
  KlingVideoGenInput,
  KlingV3VideoGenInput,
  KlingV4ElementInput,
  KlingV4VideoGenInput,
  KlingModel,
  VideoGenStepTemplate,
} from '@civitai/orchestration-client';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { removeEmpty } from '~/utils/object-helpers';
import { klingVersionIds } from '~/shared/generation/version-ids';
import {
  KLING_V4_EDIT_WORKFLOW,
  type KlingV4Element,
} from '~/shared/form-graph/generation/video/kling.graph';
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
  // A locked picker swaps a version the user may not see for the default, which would turn an
  // edit into a text-to-video and bill for it.
  if (data.workflow === KLING_V4_EDIT_WORKFLOW && data.klingVersion !== 'v4')
    throw throwBadRequestError('Video edits need Kling V4');
  const input =
    data.klingVersion === 'v4'
      ? createV4Input(data)
      : data.klingVersion === 'v3'
      ? createV3Input(data)
      : createLegacyInput(data);
  return [{ $type: 'videoGen', input }];
});

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

function toElementInput(element: KlingV4Element): KlingV4ElementInput {
  const [frontal, ...references] = element.images;
  return removeEmpty({
    frontalImage: frontal?.url,
    referenceImages: references.map((image) => image.url),
    videoUrl: element.video?.url,
    voiceId: element.voiceId,
  });
}

function createV4Input(data: KlingV4Data): KlingV4VideoGenInput {
  const shots = 'multiShot' in data && data.multiShot?.length ? data.multiShot : undefined;
  const keyframes = data.operation === 'imageToVideo';
  const images = 'images' in data ? data.images?.map((image) => image.url) : undefined;

  return removeEmpty({
    engine: 'kling-v4' as const,
    operation: data.operation,
    // The input requires the key even when the shots carry the prompts.
    prompt: shots ? '' : data.prompt,
    multiPrompt: shots?.map(({ prompt, duration }) => ({ prompt, duration })),
    duration: shots || !('duration' in data) ? undefined : data.duration,
    resolution: data.resolution,
    aspectRatio: data.aspectRatio?.value as KlingV4VideoGenInput['aspectRatio'],
    sourceImage: keyframes ? images?.[0] : undefined,
    endImage: keyframes ? images?.[1] : undefined,
    middleImages: 'middleImages' in data ? data.middleImages?.map((image) => image.url) : undefined,
    images: keyframes ? undefined : images,
    videoUrl: 'video' in data ? data.video?.url : undefined,
    videos: 'referenceVideos' in data ? data.referenceVideos?.map((video) => video.url) : undefined,
    elements: 'klingElements' in data ? data.klingElements?.map(toElementInput) : undefined,
    voiceIds: 'voiceIds' in data ? data.voiceIds : undefined,
  }) as KlingV4VideoGenInput;
}
