/**
 * Video Upscale Graph
 *
 * Graph for video upscale workflow (vid2vid:upscale).
 * This workflow has no ecosystem support - it operates on existing videos
 * to increase resolution through upscaling.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { scaleFactorNode, videoNode } from './common';

// =============================================================================
// Constants
// =============================================================================

/** Maximum output resolution (longest side) for upscaled videos */
const MAX_OUTPUT_RESOLUTION = 2560;

/** Available upscale multipliers */
const UPSCALE_MULTIPLIERS = [2, 3] as const;

// =============================================================================
// Video Upscale Graph
// =============================================================================

/**
 * Video upscale graph definition.
 *
 * Nodes:
 * - video: Source video URL with metadata (fetched via trpc)
 * - scaleFactor: Multiplier for resolution (x2, x3)
 * - targetDimensions: Computed output dimensions
 *
 * The upscale options are computed based on the video's current resolution
 * and the maximum allowed output resolution.
 */
export const videoUpscaleGraph = new DataGraph<Record<never, never>, GenerationCtx>()
  .node('video', videoNode())
  // Scale factor node - depends on video metadata for available options
  .node(
    'scaleFactor',
    (ctx) =>
      scaleFactorNode({
        multipliers: UPSCALE_MULTIPLIERS,
        maxOutputResolution: MAX_OUTPUT_RESOLUTION,
        sourceWidth: ctx.video?.metadata?.width,
        sourceHeight: ctx.video?.metadata?.height,
      }),
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
