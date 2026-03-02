/**
 * Video Interpolation Graph
 *
 * Graph for video interpolation workflow (vid2vid:interpolate).
 * This workflow has no ecosystem support - it operates on existing videos
 * to increase frame rate through interpolation.
 */

import { z } from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { videoNode } from './common';

// =============================================================================
// Constants
// =============================================================================

/** Maximum output FPS for interpolated videos */
const MAX_OUTPUT_FPS = 120;

/** Available interpolation multipliers */
const INTERPOLATION_MULTIPLIERS = [2, 3, 4] as const;

// =============================================================================
// Types
// =============================================================================

/** Interpolation factor option */
export type InterpolationOption = {
  value: number;
  label: string;
  disabled: boolean;
  targetFps: number;
};

// =============================================================================
// Video Interpolation Graph
// =============================================================================

/**
 * Video interpolation graph definition.
 *
 * Nodes:
 * - video: Source video URL with metadata (fetched via trpc)
 * - interpolationFactor: Multiplier for frame rate (x2, x3, x4)
 *
 * The interpolation options are computed based on the video's current FPS
 * and the maximum allowed output FPS.
 */
export const videoInterpolationGraph = new DataGraph<Record<never, never>, GenerationCtx>()
  .node('video', videoNode())
  // Interpolation factor node - depends on video metadata for available options
  .node(
    'interpolationFactor',
    (ctx) => {
      const fps = ctx.video?.metadata?.fps;

      // Build options based on current video FPS
      const options: InterpolationOption[] = INTERPOLATION_MULTIPLIERS.map((multiplier) => ({
        value: multiplier,
        label: `x${multiplier}`,
        disabled: fps ? multiplier * fps > MAX_OUTPUT_FPS : false,
        targetFps: fps ? multiplier * fps : 0,
      }));

      // Find the first non-disabled option as default
      const defaultOption = options.find((o) => !o.disabled);
      const defaultValue = defaultOption?.value ?? INTERPOLATION_MULTIPLIERS[0];

      // Calculate whether interpolation is possible at all
      const canInterpolate = fps
        ? fps * Math.min(...INTERPOLATION_MULTIPLIERS) <= MAX_OUTPUT_FPS
        : true;

      return {
        input: z.coerce.number().int().min(2).max(4).optional(),
        output: z.number().int().min(2).max(4),
        defaultValue,
        meta: {
          options,
          canInterpolate,
          sourceFps: fps,
          maxOutputFps: MAX_OUTPUT_FPS,
        },
      };
    },
    ['video']
  )
  // Computed target FPS for display
  .computed(
    'targetFps',
    (ctx) => {
      const fps = ctx.video?.metadata?.fps;
      if (!fps) return undefined;
      return ctx.interpolationFactor * fps;
    },
    ['video', 'interpolationFactor']
  );

/** Type helper for the video interpolation graph context */
export type VideoInterpolationGraphCtx = ReturnType<typeof videoInterpolationGraph.init>;
