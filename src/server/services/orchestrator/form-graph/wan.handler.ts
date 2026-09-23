/**
 * Wan handler for the form-graph lane. Converts `generationHub.parse().data`
 * into @civitai/client steps. Video only — WanImage27 routes to
 * wan-image.handler.ts in the dispatcher, so `data.ecosystem` here is always
 * a Wan VIDEO backend key (the derived value the family's `backendEcosystem`
 * emits).
 */

import type {
  Wan21CivitaiVideoGenInput,
  Wan22ComfyVideoGenInput,
  Wan22FalTextToVideoInput,
  Wan22FalImageToVideoInput,
  Wan225bFalTextToVideoInput,
  Wan225bFalImageToVideoInput,
  Wan25FalTextToVideoInput,
  Wan25FalImageToVideoInput,
  Wan27FalTextToVideoInput,
  Wan27FalImageToVideoInput,
  Wan27FalReferenceToVideoInput,
  Wan27FalEditVideoInput,
  Wan30TextToVideoInput,
  Wan30ImageToVideoInput,
  VideoGenStepTemplate,
  VideoInterpolationStepTemplate,
} from '@civitai/client';

import { removeEmpty } from '~/utils/object-helpers';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import { ecosystemToVersionDef } from '~/shared/form-graph/generation/video/wan.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import { isFlipt, FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import type { EcosystemData } from './types';

export type WanGenerationData = EcosystemData<
  | 'WanVideo14B_T2V'
  | 'WanVideo14B_I2V_720p'
  | 'WanVideo14B_I2V_480p'
  | 'WanVideo-22-T2V-A14B'
  | 'WanVideo-22-I2V-A14B'
  | 'WanVideo-22-TI2V-5B'
  | 'WanVideo-25-T2V'
  | 'WanVideo-25-I2V'
  | 'WanVideo27'
  | 'WanVideo30'
>;

type WanSteps =
  | [VideoGenStepTemplate]
  | [VideoGenStepTemplate & { metadata: { suppressOutput: true } }, VideoInterpolationStepTemplate];

type WanVersion = 'v2.1' | 'v2.2' | 'v2.2-5b' | 'v2.5' | 'v2.7' | 'v3.0';

// Supported aspect ratios per version (from @civitai/client types)
const v21AspectRatiosByResolution: Record<
  string,
  { value: string; width: number; height: number }[]
> = {
  '480p': [
    { value: '16:9', width: 848, height: 480 },
    { value: '3:2', width: 720, height: 480 },
    { value: '1:1', width: 480, height: 480 },
    { value: '2:3', width: 480, height: 720 },
    { value: '9:16', width: 480, height: 848 },
  ],
  '720p': [
    { value: '16:9', width: 1280, height: 720 },
    { value: '3:2', width: 1080, height: 720 },
    { value: '1:1', width: 720, height: 720 },
    { value: '2:3', width: 720, height: 1080 },
    { value: '9:16', width: 720, height: 1280 },
  ],
};
// Explicit pixel dimensions for v2.2 comfy (resolution + aspect ratio → width/height)
const v22DimensionsByResolutionAndRatio: Record<
  string,
  Record<string, { width: number; height: number }>
> = {
  '480p': {
    '1:1': { width: 480, height: 480 },
    '16:9': { width: 848, height: 480 },
    '9:16': { width: 480, height: 848 },
    '4:3': { width: 640, height: 480 },
    '3:4': { width: 480, height: 640 },
    '4:5': { width: 384, height: 480 },
    '5:4': { width: 608, height: 480 },
  },
  '720p': {
    '1:1': { width: 720, height: 720 },
    '16:9': { width: 1280, height: 720 },
    '9:16': { width: 720, height: 1280 },
    '4:3': { width: 960, height: 720 },
    '3:4': { width: 720, height: 960 },
    '4:5': { width: 576, height: 720 },
    '5:4': { width: 912, height: 720 },
  },
};
const v22AspectRatioEntries = (resolution: string) =>
  Object.entries(
    v22DimensionsByResolutionAndRatio[resolution] ?? v22DimensionsByResolutionAndRatio['480p']
  ).map(([value, dims]) => ({ value, ...dims }));
const v225bAspectRatios = ['1:1', '16:9', '9:16'] as const;
const v25AspectRatios = ['16:9', '9:16', '1:1'] as const;

/** Derive aspect ratio from source image dimensions for img2vid */
function getImageAspectRatio<T extends `${number}:${number}`>(
  images: { width: number; height: number }[] | undefined,
  supportedRatios: readonly T[]
): T | undefined {
  const img = images?.[0];
  if (!img?.width || !img?.height) return undefined;
  return findClosestAspectRatio({ width: img.width, height: img.height }, [...supportedRatios]);
}

/**
 * Returns one videoGen step for most versions, [videoGen, videoInterpolation]
 * for multi-step v2.2. The version comes from the BACKEND ecosystem key,
 * falling back to the branch tag.
 */
export const createWanSteps = defineHandler<WanGenerationData, WanSteps>(async (data, ctx) => {
  const hasImages = !!data.images?.length;
  const version: WanVersion =
    ecosystemToVersionDef.get(data.ecosystem)?.version ?? data.wanVersion ?? 'v2.1';
  const duration = 'duration' in data ? data.duration : undefined;
  const steps = 'steps' in data ? data.steps : undefined;
  const resources = 'resources' in data ? data.resources : undefined;

  const loras: { air: string; strength: number }[] = [];
  for (const resource of resources ?? []) {
    loras.push({ air: ctx.airs.getOrThrow(resource.id), strength: resource.strength ?? 1 });
  }

  const baseInput = {
    engine: 'wan',
    version,
    prompt: data.prompt,
    cfgScale: data.cfgScale,
    duration,
    quantity: data.quantity ?? 1,
    seed: data.seed,
    loras: loras.length > 0 ? loras : undefined,
    frameRate: 24,
  };

  // `wanVersion` (the branch tag) and the backend-ecosystem lookup agree by
  // construction; the tag is what narrows the arm.
  switch (data.wanVersion) {
    case 'v2.1': {
      const resolution = data.resolution ?? '480p';
      const ratioEntries =
        v21AspectRatiosByResolution[resolution] ?? v21AspectRatiosByResolution['480p'];
      const dims = hasImages
        ? findClosestAspectRatio(data.images![0], ratioEntries)
        : data.aspectRatio;
      return [
        {
          $type: 'videoGen',
          input: removeEmpty({
            ...baseInput,
            provider: 'civitai' as const,
            width: dims?.width,
            height: dims?.height,
            images: hasImages ? data.images?.map((x) => x.url) : undefined,
          }) as Wan21CivitaiVideoGenInput,
        },
      ];
    }

    case 'v2.2': {
      // Multi-step vs legacy is driven entirely by the flipt flag
      const useMultiStep = await isFlipt(FLIPT_FEATURE_FLAGS.WAN22_MULTI_STEP, 'global', {
        userId: String(ctx.user.id),
        isModerator: String(ctx.user.isModerator),
      });

      if (useMultiStep) {
        // Multi-step comfy workflow: 12fps videoGen + VFIMamba frame interpolation
        const resolution = data.resolution ?? '480p';
        const ratioEntries = v22AspectRatioEntries(resolution);
        const dims = hasImages
          ? findClosestAspectRatio(data.images![0], ratioEntries)
          : ratioEntries.find((e) => e.value === data.aspectRatio?.value) ?? ratioEntries[0];
        const videoGenStep: VideoGenStepTemplate & { metadata: { suppressOutput: true } } = {
          $type: 'videoGen',
          input: removeEmpty({
            ...baseInput,
            provider: 'comfy' as const,
            frameRate: 12,
            width: dims?.width,
            height: dims?.height,
            duration: data.duration ?? 5,
            steps: steps ?? 20,
            negativePrompt: data.negativePrompt,
            shift: data.shift,
            images: hasImages ? data.images?.map((x) => x.url) : undefined,
          }) as Wan22ComfyVideoGenInput,
          metadata: { suppressOutput: true },
        };
        const videoInterpolationStep: VideoInterpolationStepTemplate = {
          $type: 'videoInterpolation',
          input: {
            video: { $ref: '$0', path: 'output.video.url' } as unknown as string,
            interpolationFactor: 2,
            model: 'VFIMamba',
          },
        };
        return [videoGenStep, videoInterpolationStep];
      }

      // Legacy single-step fal workflow
      const operation = hasImages ? 'image-to-video' : 'text-to-video';
      const input = {
        ...baseInput,
        provider: 'fal' as const,
        operation,
        negativePrompt: data.negativePrompt,
        resolution: data.resolution,
        aspectRatio: (hasImages
          ? getImageAspectRatio(data.images, v225bAspectRatios)
          : data.aspectRatio?.value) as Wan22FalTextToVideoInput['aspectRatio'],
        enablePromptExpansion: false,
        shift: data.shift,
        interpolatorModel: data.interpolatorModel,
        useTurbo: data.draft,
      };

      if (hasImages) {
        return [
          {
            $type: 'videoGen',
            input: removeEmpty({
              ...input,
              images: data.images?.map((x) => x.url),
            }) as Wan22FalImageToVideoInput,
          },
        ];
      }
      return [{ $type: 'videoGen', input: removeEmpty(input) as Wan22FalTextToVideoInput }];
    }

    case 'v2.2-5b': {
      const operation = hasImages ? 'image-to-video' : 'text-to-video';
      const input = {
        ...baseInput,
        provider: 'fal' as const,
        operation,
        negativePrompt: data.negativePrompt,
        resolution: data.resolution,
        aspectRatio: (hasImages
          ? getImageAspectRatio(data.images, v225bAspectRatios)
          : data.aspectRatio?.value) as Wan225bFalTextToVideoInput['aspectRatio'],
        enablePromptExpansion: false,
        shift: data.shift,
        numInferenceSteps: data.steps,
        interpolatorModel: data.interpolatorModel,
      };
      return [
        {
          $type: 'videoGen',
          input: removeEmpty(
            hasImages ? { ...input, images: data.images?.map((x) => x.url) } : input
          ) as Wan225bFalTextToVideoInput | Wan225bFalImageToVideoInput,
        },
      ];
    }

    case 'v2.5': {
      const operation = hasImages ? 'image-to-video' : 'text-to-video';
      const input = {
        ...baseInput,
        provider: 'fal' as const,
        operation,
        negativePrompt: data.negativePrompt,
        resolution: data.resolution,
        aspectRatio: (hasImages
          ? getImageAspectRatio(data.images, v25AspectRatios)
          : data.aspectRatio?.value) as Wan25FalTextToVideoInput['aspectRatio'],
        enablePromptExpansion: false,
      };
      return [
        {
          $type: 'videoGen',
          input: removeEmpty(
            hasImages ? { ...input, images: data.images?.map((x) => x.url) } : input
          ) as Wan25FalTextToVideoInput | Wan25FalImageToVideoInput,
        },
      ];
    }

    // v2.7 video (WanImage27 routes to wan-image.handler).
    // Per fal spec: cfgScale, steps, frameRate, loras are NOT supported for v2.7.
    case 'v2.7': {
      const v27Base = {
        engine: 'wan' as const,
        version: 'v2.7' as const,
        provider: 'fal' as const,
        seed: data.seed,
        resolution: data.resolution,
      };
      const negativePrompt = data.negativePrompt;
      const duration = data.duration;
      const aspectRatio = data.aspectRatio?.value as
        | Wan27FalTextToVideoInput['aspectRatio']
        | undefined;

      if (data.workflow === 'vid2vid:edit') {
        return [
          {
            $type: 'videoGen',
            input: removeEmpty({
              ...v27Base,
              operation: 'edit-video',
              prompt: data.prompt,
              videoUrl: data.video?.url,
              aspectRatio,
              duration,
              audioSetting: 'auto',
            }) as Wan27FalEditVideoInput,
          },
        ];
      }

      if (data.workflow === 'img2vid:ref2vid') {
        return [
          {
            $type: 'videoGen',
            input: removeEmpty({
              ...v27Base,
              operation: 'reference-to-video',
              prompt: data.prompt,
              referenceImages: hasImages ? data.images!.map((x) => x.url) : undefined,
              aspectRatio,
              duration,
              negativePrompt,
            }) as Wan27FalReferenceToVideoInput,
          },
        ];
      }

      // img2vid → image-to-video (first slot = startImage, second slot = endImage)
      if (hasImages) {
        const startImage = data.images![0]?.url;
        const endImage = data.images![1]?.url;
        return [
          {
            $type: 'videoGen',
            input: removeEmpty({
              ...v27Base,
              operation: 'image-to-video',
              prompt: data.prompt || undefined,
              startImage,
              endImage,
              duration,
              negativePrompt,
              enablePromptExpansion: data.enablePromptEnhancer,
            }) as Wan27FalImageToVideoInput,
          },
        ];
      }

      return [
        {
          $type: 'videoGen',
          input: removeEmpty({
            ...v27Base,
            operation: 'text-to-video',
            prompt: data.prompt,
            aspectRatio,
            duration,
            negativePrompt,
            enablePromptExpansion: data.enablePromptEnhancer,
          }) as Wan27FalTextToVideoInput,
        },
      ];
    }

    // Unlike every other Wan version, v3.0 takes no `provider`, and its image-to-video
    // input carries startImage/endImage rather than an images array.
    case 'v3.0': {
      const v30Base = {
        engine: 'wan' as const,
        version: 'v3.0' as const,
        prompt: data.prompt,
        negativePrompt: data.negativePrompt,
        duration: data.duration,
        resolution: data.resolution,
        enablePromptExpansion: data.enablePromptEnhancer,
        usePrime: data.usePrime,
        seed: data.seed,
      };

      if (hasImages) {
        const [startImage, endImage] = data.images!;
        return [
          {
            $type: 'videoGen',
            input: removeEmpty({
              ...v30Base,
              operation: 'image-to-video',
              startImage: startImage?.url,
              endImage: endImage?.url,
            }) as Wan30ImageToVideoInput,
          },
        ];
      }

      return [
        {
          $type: 'videoGen',
          input: removeEmpty({
            ...v30Base,
            operation: 'text-to-video',
            aspectRatio: data.aspectRatio?.value as Wan30TextToVideoInput['aspectRatio'],
          }) as Wan30TextToVideoInput,
        },
      ];
    }

    default:
      return [
        {
          $type: 'videoGen',
          input: removeEmpty({
            ...baseInput,
            provider: 'civitai' as const,
          }) as Wan21CivitaiVideoGenInput,
        },
      ];
  }
});
