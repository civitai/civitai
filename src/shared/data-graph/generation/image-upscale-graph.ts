/**
 * Image Upscale Graph
 *
 * Graph for image upscale workflow (img2img:upscale).
 * This workflow has no ecosystem support - it operates on existing images
 * to increase resolution through upscaling.
 *
 * Note: This graph defines its own 'images' node since it doesn't use ecosystemGraph.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { imagesNode, scaleFactorNode } from './common';

// =============================================================================
// Constants
// =============================================================================

/** Maximum output resolution (longest side) for upscaled images */
const MAX_OUTPUT_RESOLUTION = 4096;

/** Available upscale multipliers */
const UPSCALE_MULTIPLIERS = [2, 3, 4] as const;

// =============================================================================
// Image Upscale Graph
// =============================================================================

/**
 * Image upscale graph definition.
 *
 * Nodes:
 * - images: Source image (max 1)
 * - scaleFactor: Multiplier for resolution (x2, x3, x4)
 * - targetDimensions: Computed output dimensions
 *
 * The upscale options are computed based on the first image's current dimensions
 * and the maximum allowed output resolution.
 */
export const imageUpscaleGraph = new DataGraph<Record<never, never>, GenerationCtx>()
  // Images node - upscale only allows 1 image
  .node('images', () => imagesNode({ max: 1, min: 1 }), [])
  // Scale factor node - depends on image dimensions for available options
  .node(
    'scaleFactor',
    (ctx) =>
      scaleFactorNode({
        multipliers: UPSCALE_MULTIPLIERS,
        maxOutputResolution: MAX_OUTPUT_RESOLUTION,
        sourceWidth: ctx.images?.[0]?.width,
        sourceHeight: ctx.images?.[0]?.height,
      }),
    ['images']
  )
  // Computed target dimensions for display
  .computed(
    'targetDimensions',
    (ctx) => {
      const firstImage = ctx.images?.[0];
      const width = firstImage?.width;
      const height = firstImage?.height;
      if (!width || !height) return undefined;
      return {
        width: ctx.scaleFactor * width,
        height: ctx.scaleFactor * height,
      };
    },
    ['images', 'scaleFactor']
  );

/** Type helper for the image upscale graph context */
export type ImageUpscaleGraphCtx = ReturnType<typeof imageUpscaleGraph.init>;
