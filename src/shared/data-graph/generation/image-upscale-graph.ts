/**
 * Image Upscale Graph
 *
 * Graph for image upscale workflow (img2img:upscale).
 * This workflow has no ecosystem support - it operates on existing images
 * to increase resolution through upscaling.
 *
 * Note: This graph defines its own 'images' node since it doesn't use ecosystemGraph.
 */

import { z } from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { imagesNode } from './common';

// =============================================================================
// Constants
// =============================================================================

/** Maximum output resolution (longest side) for upscaled images */
const MAX_OUTPUT_RESOLUTION = 4096;

/** Available upscale multipliers */
const UPSCALE_MULTIPLIERS = [2, 4] as const;

// =============================================================================
// Types
// =============================================================================

/** Upscale factor option */
export type ImageUpscaleOption = {
  value: number;
  label: string;
  disabled: boolean;
  targetWidth: number;
  targetHeight: number;
};

// =============================================================================
// Image Upscale Graph
// =============================================================================

/**
 * Image upscale graph definition.
 *
 * Nodes:
 * - images: Source image (max 1)
 * - scaleFactor: Multiplier for resolution (x2, x4)
 * - targetDimensions: Computed output dimensions
 *
 * The upscale options are computed based on the first image's current dimensions
 * and the maximum allowed output resolution.
 */
export const imageUpscaleGraph = new DataGraph<Record<never, never>, GenerationCtx>()
  // Images node - upscale only allows 1 image
  .node('images', imagesNode({ max: 1, min: 1 }), [])
  // Scale factor node - depends on image dimensions for available options
  .node(
    'scaleFactor',
    (ctx) => {
      const firstImage = ctx.images?.[0];
      const width = firstImage?.width;
      const height = firstImage?.height;
      const maxDimension = width && height ? Math.max(width, height) : undefined;

      // Build options based on current image dimensions
      const options: ImageUpscaleOption[] = UPSCALE_MULTIPLIERS.map((multiplier) => ({
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
        input: z.coerce.number().int().min(2).max(4).optional(),
        output: z.number().int().min(2).max(4),
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
