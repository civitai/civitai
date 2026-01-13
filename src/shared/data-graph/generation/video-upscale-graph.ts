/**
 * Video Upscale Graph
 *
 * Graph for video upscale workflow (vid2vid:upscale).
 * This workflow has no ecosystem support - it operates on existing videos
 * to increase resolution through upscaling.
 */

import { z } from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { videoNode } from './common';

// =============================================================================
// Constants
// =============================================================================

/** Maximum output resolution (longest side) for upscaled videos */
const MAX_OUTPUT_RESOLUTION = 2560;

/** Available upscale multipliers */
const UPSCALE_MULTIPLIERS = [2, 3] as const;

// =============================================================================
// Types
// =============================================================================

/** Upscale factor option */
export type UpscaleOption = {
  value: number;
  label: string;
  disabled: boolean;
  targetWidth: number;
  targetHeight: number;
};

// =============================================================================
// Video Upscale Graph
// =============================================================================

/**
 * Video upscale graph definition.
 *
 * Nodes:
 * - video: Source video URL with metadata (fetched via trpc)
 * - scaleFactor: Multiplier for resolution (x2, x3)
 *
 * The upscale options are computed based on the video's current resolution
 * and the maximum allowed output resolution.
 */
export const videoUpscaleGraph = new DataGraph<Record<never, never>, GenerationCtx>()
  .node('video', videoNode())
  // Scale factor node - depends on video metadata for available options
  .node(
    'scaleFactor',
    (ctx) => {
      const width = ctx.video?.metadata?.width;
      const height = ctx.video?.metadata?.height;
      const maxDimension = width && height ? Math.max(width, height) : undefined;

      // Build options based on current video dimensions
      const options: UpscaleOption[] = UPSCALE_MULTIPLIERS.map((multiplier) => ({
        value: multiplier,
        label: `x${multiplier}`,
        disabled: maxDimension ? multiplier * maxDimension > MAX_OUTPUT_RESOLUTION : false,
        targetWidth: width ? multiplier * width : 0,
        targetHeight: height ? multiplier * height : 0,
      }));

      // Find the first non-disabled option as default
      const defaultOption = options.find((o) => !o.disabled);
      const defaultValue = defaultOption?.value ?? UPSCALE_MULTIPLIERS[0];

      // Calculate whether upscaling is possible at all
      const canUpscale = maxDimension
        ? maxDimension * Math.min(...UPSCALE_MULTIPLIERS) <= MAX_OUTPUT_RESOLUTION
        : true;

      return {
        input: z.coerce.number().int().min(2).max(3).optional(),
        output: z.number().int().min(2).max(3),
        defaultValue,
        meta: {
          options,
          canUpscale,
          sourceWidth: width,
          sourceHeight: height,
          maxOutputResolution: MAX_OUTPUT_RESOLUTION,
        },
      };
    },
    ['video']
  )
  // Computed target dimensions for display
  .computed(
    'targetDimensions',
    (ctx) => {
      const width = ctx.video?.metadata?.width;
      const height = ctx.video?.metadata?.height;
      if (!width || !height) return undefined;
      return {
        width: ctx.scaleFactor * width,
        height: ctx.scaleFactor * height,
      };
    },
    ['video', 'scaleFactor']
  );

/** Type helper for the video upscale graph context */
export type VideoUpscaleGraphCtx = ReturnType<typeof videoUpscaleGraph.init>;
