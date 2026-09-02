import { z } from 'zod';
import { defineGraph } from 'form-graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { VIDEO } from '../defs';

/**
 * The video enhancement workflows, ported from `video-upscale-graph.ts` and
 * `video-interpolation-graph.ts`. Standalone — no ecosystem; they operate on
 * an existing video, and the option sets derive from its metadata.
 */

// ---- copied from the v1 graphs, which die with the data-graph engine --------

const MAX_OUTPUT_RESOLUTION = 2560;
const UPSCALE_MULTIPLIERS = [2, 3] as const;

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

// ---- end of v1 copies -------------------------------------------------------

export const videoUpscale = defineGraph<GenerationCtx>()
  .field('video', VIDEO)
  .field('scaleFactor', ({ video }) => {
    const width = video?.metadata?.width;
    const height = video?.metadata?.height;
    const maxDimension = width && height ? Math.max(width, height) : undefined;

    const options: ScaleFactorOption[] = UPSCALE_MULTIPLIERS.map((multiplier) => ({
      value: multiplier,
      label: `x${multiplier}`,
      disabled: maxDimension ? multiplier * maxDimension > MAX_OUTPUT_RESOLUTION : false,
      targetWidth: width ? multiplier * width : 0,
      targetHeight: height ? multiplier * height : 0,
    }));
    const defaultValue = options.find((o) => !o.disabled)?.value ?? UPSCALE_MULTIPLIERS[0];
    const canUpscale = maxDimension
      ? maxDimension * Math.min(...UPSCALE_MULTIPLIERS) <= MAX_OUTPUT_RESOLUTION
      : true;

    const min = Math.min(...UPSCALE_MULTIPLIERS);
    const max = Math.max(...UPSCALE_MULTIPLIERS);
    return {
      input: z.coerce.number().int().min(min).max(max).optional(),
      output: z
        .number()
        .int()
        .min(min)
        .max(max)
        .refine((val) => !maxDimension || val * maxDimension <= MAX_OUTPUT_RESOLUTION, {
          message: `Scale factor would exceed maximum output resolution of ${MAX_OUTPUT_RESOLUTION}px`,
        }),
      default: defaultValue,
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
      input: z.coerce.number().int().min(2).max(4).optional(),
      output: z.number().int().min(2).max(4),
      default: defaultValue,
      meta: { options, canInterpolate, sourceFps: fps, maxOutputFps: MAX_OUTPUT_FPS },
    };
  })
  .computed('targetFps', ({ video, interpolationFactor }) => {
    const fps = video?.metadata?.fps;
    if (!fps) return undefined;
    return interpolationFactor * fps;
  });
