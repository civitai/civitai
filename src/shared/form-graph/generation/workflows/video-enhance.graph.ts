import { z } from 'zod';
import { cachedFactory, defineGraph } from 'form-graph';
import type { GenerationCtx } from '~/shared/generation/context';
import { clampCorrect, optionFallback, VIDEO, sliderDef } from '../defs';
import {
  videoPreprocessKindParamSpecs,
  videoPreprocessKinds,
} from '~/shared/generation/preprocess-specs';

const videoKindParamsSchema = z.record(z.string(), z.unknown());
const videoKindParamsInput = videoKindParamsSchema.optional();

const interpolationFactorInput = z.coerce.number().int().min(2).max(4).optional();
const interpolationFactorOutput = z.number().int().min(2).max(4);

/**
 * The video enhancement workflows. Standalone — no ecosystem; they operate on an
 * existing video, and the option sets derive from its metadata.
 */

const MAX_OUTPUT_RESOLUTION = 2560;
const VIDEO_UPSCALERS = ['relayvsr', 'flashvsr'] as const;
type VideoUpscaler = (typeof VIDEO_UPSCALERS)[number];
const UPSCALE_MULTIPLIERS = {
  relayvsr: [2, 4],
  flashvsr: [2, 3],
} as const;

const MAX_OUTPUT_FPS = 120;
const INTERPOLATION_MULTIPLIERS = [2, 3, 4] as const;

export type InterpolationOption = {
  value: number;
  label: string;
  disabled: boolean;
  targetFps: number;
};

export type ScaleFactorOption = {
  value: number;
  label: string;
  disabled: boolean;
  targetWidth: number;
  targetHeight: number;
};

const SCALE_FACTOR_MIN = 2;
const SCALE_FACTOR_MAX = 4;
const SCALE_FACTOR_INPUT = z.coerce
  .number()
  .int()
  .min(SCALE_FACTOR_MIN)
  .max(SCALE_FACTOR_MAX)
  .optional();
// Keyed on the largest factor the source allows, not its raw size: the size is
// request-supplied, and a cache keyed on it would grow without bound on the server.
const scaleFactorOutput = cachedFactory((model: VideoUpscaler, ceiling: number | null) =>
  z
    .number()
    .int()
    .min(SCALE_FACTOR_MIN)
    .max(SCALE_FACTOR_MAX)
    .refine((val) => (UPSCALE_MULTIPLIERS[model] as readonly number[]).includes(val), {
      message: 'Scale factor is not supported by the selected upscaler',
    })
    .refine((val) => ceiling == null || val <= ceiling, {
      message: `Scale factor would exceed maximum output resolution of ${MAX_OUTPUT_RESOLUTION}px`,
    })
);

export const videoUpscale = defineGraph<GenerationCtx>()
  .field('video', VIDEO)
  .field('videoUpscaler', {
    input: z.enum(VIDEO_UPSCALERS).optional(),
    output: z.enum(VIDEO_UPSCALERS),
    default: 'relayvsr',
    correct: optionFallback(VIDEO_UPSCALERS, 'relayvsr'),
    meta: {
      options: [
        { value: 'relayvsr', label: 'RelayVSR' },
        { value: 'flashvsr', label: 'FlashVSR' },
      ],
    },
  })
  .field('scaleFactor', ({ video, videoUpscaler }) => {
    const width = video?.metadata?.width;
    const height = video?.metadata?.height;
    const maxDimension = width && height ? Math.max(width, height) : undefined;
    const multipliers = UPSCALE_MULTIPLIERS[videoUpscaler];

    const options: ScaleFactorOption[] = multipliers.map((multiplier) => ({
      value: multiplier,
      label: `x${multiplier}`,
      disabled: maxDimension ? multiplier * maxDimension > MAX_OUTPUT_RESOLUTION : false,
      targetWidth: width ? multiplier * width : 0,
      targetHeight: height ? multiplier * height : 0,
    }));
    const defaultValue = options.find((o) => !o.disabled)?.value ?? multipliers[0];
    const canUpscale = maxDimension
      ? maxDimension * Math.min(...multipliers) <= MAX_OUTPUT_RESOLUTION
      : true;

    return {
      input: SCALE_FACTOR_INPUT,
      output: scaleFactorOutput(
        videoUpscaler,
        maxDimension && maxDimension > 0
          ? Math.min(Math.floor(MAX_OUTPUT_RESOLUTION / maxDimension), SCALE_FACTOR_MAX)
          : null
      ),
      default: defaultValue,
      // Scope keeps a factor from a different model/source from blocking submit;
      // raw requests must still refuse unsupported or over-ceiling factors.
      scope: `${videoUpscaler}:${maxDimension ?? 'unknown'}`,
      meta: {
        options,
        canUpscale,
        sourceWidth: width,
        sourceHeight: height,
        maxOutputResolution: MAX_OUTPUT_RESOLUTION,
      },
    };
  })
  .computed('targetDimensions', ({ video, scaleFactor }) => {
    const width = video?.metadata?.width;
    const height = video?.metadata?.height;
    if (!width || !height) return undefined;
    return { width: scaleFactor * width, height: scaleFactor * height };
  });

export const videoInterpolation = defineGraph<GenerationCtx>()
  .field('video', VIDEO)
  .field('interpolationFactor', ({ video }) => {
    const fps = video?.metadata?.fps;

    const options: InterpolationOption[] = INTERPOLATION_MULTIPLIERS.map((multiplier) => ({
      value: multiplier,
      label: `x${multiplier}`,
      disabled: fps ? multiplier * fps > MAX_OUTPUT_FPS : false,
      targetFps: fps ? multiplier * fps : 0,
    }));
    const defaultValue = options.find((o) => !o.disabled)?.value ?? INTERPOLATION_MULTIPLIERS[0];
    const canInterpolate = fps
      ? fps * Math.min(...INTERPOLATION_MULTIPLIERS) <= MAX_OUTPUT_FPS
      : true;

    return {
      input: interpolationFactorInput,
      output: interpolationFactorOutput,
      default: defaultValue,
      // Unlike `scaleFactor` above, the fps ceiling is advisory here — it disables an
      // option in meta but the output does not refuse on it. So the only refusal is an
      // out-of-range factor, and clamping is safe rather than scope-per-source.
      correct: clampCorrect({ min: 2, max: 4, fallback: defaultValue }),
      meta: { options, canInterpolate, sourceFps: fps, maxOutputFps: MAX_OUTPUT_FPS },
    };
  })
  .computed('targetFps', ({ video, interpolationFactor }) => {
    const fps = video?.metadata?.fps;
    if (!fps) return undefined;
    return interpolationFactor * fps;
  });

/**
 * The standalone control-preprocessor workflow for video (vid2vid:preprocess).
 * Same field names as the image
 * preprocess arm — they sit in different branch arms, so the narrower video
 * kind enum does not collide with the image one.
 */
export const videoPreprocess = defineGraph<GenerationCtx>()
  .field('video', VIDEO)
  .field('preprocessKind', {
    input: z.enum(videoPreprocessKinds).optional(),
    output: z.enum(videoPreprocessKinds),
    default: videoPreprocessKinds[0],
    correct: optionFallback(videoPreprocessKinds, videoPreprocessKinds[0]),
    meta: { options: videoPreprocessKinds.map((value) => ({ label: value, value })) },
  })
  .field('preprocessResolution', sliderDef({ min: 64, max: 2048, step: 8, default: 512 }))
  .field('kindParams', ({ preprocessKind }) => ({
    input: videoKindParamsInput,
    output: videoKindParamsSchema,
    default: {} as Record<string, unknown>,
    meta: {
      specs: preprocessKind ? videoPreprocessKindParamSpecs[preprocessKind] ?? [] : [],
    },
  }));
