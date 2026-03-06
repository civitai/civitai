/**
 * Image Upscale Graph
 *
 * Graph for image upscale workflow (img2img:upscale).
 * This workflow has no ecosystem support - it operates on existing images
 * to increase resolution through upscaling.
 *
 * Supports batch upscaling of up to 10 images in a single request.
 * Each image is adaptively assigned the best available multiplier
 * (falling back to lower multipliers when the selected one would exceed
 * the maximum output resolution).
 *
 * Note: This graph defines its own 'images' node since it doesn't use ecosystemGraph.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { imagesNode } from './common';

// =============================================================================
// Constants
// =============================================================================

/** Maximum output resolution (longest side) for upscaled images */
const MAX_OUTPUT_RESOLUTION = 4096;

/** Maximum number of images in a single upscale batch */
const MAX_UPSCALE_IMAGES = 10;

/** Available upscale multipliers (applied to source dimensions) */
const UPSCALE_MULTIPLIERS = [1.5, 2, 2.5, 3] as const;

/** Available target resolution presets (longest side in pixels) */
const UPSCALE_RESOLUTIONS = [
  { label: '2K', value: 2048 },
  { label: '4K', value: 3840 },
] as const;

// =============================================================================
// Types
// =============================================================================

/** Upscale selection — the user's chosen preset (multiplier or resolution target) */
export type UpscaleSelection =
  | { type: 'multiplier'; multiplier: number }
  | { type: 'resolution'; resolution: number };

export interface UpscaleMultiplierOption {
  label: string;
  multiplier: number;
  width: number;
  height: number;
  disabled: boolean;
}

export interface UpscaleResolutionOption {
  label: string;
  resolution: number;
  width: number;
  height: number;
  disabled: boolean;
}

/** Per-image annotation for the images input overlay */
export interface ImageAnnotation {
  label: string;
  color: 'green' | 'yellow' | 'red';
  tooltip?: string;
}

export interface UpscaleSelectionMeta {
  sourceWidth: number | undefined;
  sourceHeight: number | undefined;
  maxOutputResolution: number;
  multiplierOptions: UpscaleMultiplierOption[];
  resolutionOptions: UpscaleResolutionOption[];
  canUpscale: boolean;
  imageCount: number;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Compute upscale target dimensions maintaining aspect ratio.
 * The longest side is set to `target`, the other side is scaled proportionally.
 * Both sides are aligned to 64px boundaries.
 */
function computeUpscaleDimensions(
  sourceWidth: number,
  sourceHeight: number,
  target: number
): { width: number; height: number } {
  const aspectRatio = sourceWidth / sourceHeight;
  let width: number;
  let height: number;

  if (sourceWidth >= sourceHeight) {
    width = target;
    height = Math.round(target / aspectRatio);
  } else {
    width = Math.round(target * aspectRatio);
    height = target;
  }

  return {
    width: Math.ceil(width / 64) * 64,
    height: Math.ceil(height / 64) * 64,
  };
}

/**
 * Check whether applying a multiplier to an image produces valid output dimensions.
 */
function isMultiplierValid(sourceWidth: number, sourceHeight: number, multiplier: number): boolean {
  const target = Math.max(sourceWidth, sourceHeight) * multiplier;
  const dims = computeUpscaleDimensions(sourceWidth, sourceHeight, target);
  return Math.max(dims.width, dims.height) <= MAX_OUTPUT_RESOLUTION;
}

/**
 * Find the best effective multiplier for an image given the user's selected multiplier.
 * Tries the selected value first, then falls back to lower multipliers.
 * Returns the effective multiplier or null if no multiplier works.
 */
function findEffectiveMultiplier(
  sourceWidth: number,
  sourceHeight: number,
  selectedMultiplier: number
): number | null {
  // Candidates: all multipliers <= selected, sorted descending (try highest first)
  const candidates = [...UPSCALE_MULTIPLIERS]
    .filter((m) => m <= selectedMultiplier)
    .sort((a, b) => b - a);

  for (const multiplier of candidates) {
    if (isMultiplierValid(sourceWidth, sourceHeight, multiplier)) {
      return multiplier;
    }
  }
  return null;
}

// =============================================================================
// Schemas
// =============================================================================

const upscaleSelectionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('multiplier'), multiplier: z.number() }),
  z.object({ type: z.literal('resolution'), resolution: z.number() }),
]);

// =============================================================================
// Image Upscale Graph
// =============================================================================

/**
 * Image upscale graph definition.
 *
 * Nodes:
 * - images: Source images (max 10)
 * - upscaleSelection: User's chosen preset (multiplier or resolution)
 * - targetDimensions: Per-image target dimensions array (null = excluded)
 *
 * The available upscale options (multipliers and resolution presets) are
 * exposed via the upscaleSelection node meta so the UI can render preset buttons.
 * Options are enabled when at least one image in the batch can use them.
 */
export const imageUpscaleGraph = new DataGraph<Record<never, never>, GenerationCtx>()
  // Images node - batch upscale allows up to 10 images
  .node('images', () => imagesNode({ min: 1, max: MAX_UPSCALE_IMAGES }), [])
  // Upscale selection - the user's chosen preset
  .node(
    'upscaleSelection',
    (ctx) => {
      const images = ctx.images ?? [];
      // Use first image for display dimensions in options
      const firstImage = images[0];
      const sourceWidth = firstImage?.width;
      const sourceHeight = firstImage?.height;

      // Build multiplier options (display dims from first image, disabled based on all images)
      const multiplierOptions: UpscaleMultiplierOption[] =
        sourceWidth && sourceHeight
          ? UPSCALE_MULTIPLIERS.map((multiplier) => {
              // Display dimensions from first image
              const target = Math.max(sourceWidth, sourceHeight) * multiplier;
              const dims = computeUpscaleDimensions(sourceWidth, sourceHeight, target);

              // Disabled only if NO image in the batch can use this multiplier
              const disabled =
                images.length > 0
                  ? images.every((img) => {
                      if (!img.width || !img.height) return true;
                      return !isMultiplierValid(img.width, img.height, multiplier);
                    })
                  : true;

              return {
                label: `x${multiplier}`,
                multiplier,
                ...dims,
                disabled,
              };
            })
          : [];

      // Build resolution options (display dims from first image, disabled based on all images)
      const resolutionOptions: UpscaleResolutionOption[] =
        sourceWidth && sourceHeight
          ? UPSCALE_RESOLUTIONS.map(({ label, value: targetRes }) => {
              const dims = computeUpscaleDimensions(sourceWidth, sourceHeight, targetRes);

              // Disabled only if NO image can benefit from this resolution
              const disabled =
                images.length > 0
                  ? images.every((img) => {
                      if (!img.width || !img.height) return true;
                      const maxDim = Math.max(img.width, img.height);
                      if (maxDim >= targetRes) return true;
                      const imgDims = computeUpscaleDimensions(img.width, img.height, targetRes);
                      return Math.max(imgDims.width, imgDims.height) > MAX_OUTPUT_RESOLUTION;
                    })
                  : true;

              return {
                label,
                resolution: targetRes,
                ...dims,
                disabled,
              };
            })
          : [];

      // Default to first non-disabled multiplier
      const defaultMultiplier = multiplierOptions.find((o) => !o.disabled);
      const defaultValue: UpscaleSelection | undefined = defaultMultiplier
        ? { type: 'multiplier', multiplier: defaultMultiplier.multiplier }
        : undefined;

      const canUpscale =
        multiplierOptions.some((o) => !o.disabled) || resolutionOptions.some((o) => !o.disabled);

      return {
        input: upscaleSelectionSchema.optional(),
        output: upscaleSelectionSchema,
        defaultValue,
        // When images change, validate the current selection is still useful for at least one image.
        // If the selection is now useless for all images, reset to the first available option.
        transform: (
          value: UpscaleSelection,
          ctx: { images?: { width: number; height: number }[] }
        ) => {
          // Guard: transform can be called before a value is set (e.g., append from menu)
          if (!value) return (defaultValue ?? value) as UpscaleSelection;
          const imgs = ctx.images ?? [];
          if (imgs.length === 0) return value;

          if (value.type === 'multiplier') {
            // Valid if at least one image can use this multiplier (with fallback)
            const anyValid = imgs.some(
              (img) =>
                img.width &&
                img.height &&
                findEffectiveMultiplier(img.width, img.height, value.multiplier) !== null
            );
            if (!anyValid) return defaultValue ?? value;
          } else {
            // Resolution: valid if at least one image benefits
            const anyValid = imgs.some((img) => {
              if (!img.width || !img.height) return false;
              const maxDim = Math.max(img.width, img.height);
              if (maxDim >= value.resolution) return false;
              const dims = computeUpscaleDimensions(img.width, img.height, value.resolution);
              return Math.max(dims.width, dims.height) <= MAX_OUTPUT_RESOLUTION;
            });
            if (!anyValid) return defaultValue ?? value;
          }

          return value;
        },
        meta: (): UpscaleSelectionMeta => ({
          sourceWidth,
          sourceHeight,
          maxOutputResolution: MAX_OUTPUT_RESOLUTION,
          multiplierOptions,
          resolutionOptions,
          canUpscale,
          imageCount: images.length,
        }),
      };
    },
    ['images']
  )
  // Per-image target dimensions (parallel to images array; null = excluded/can't upscale)
  .computed(
    'targetDimensions',
    (ctx) => {
      const images = ctx.images ?? [];
      const selection = ctx.upscaleSelection;
      if (!selection || images.length === 0) return [];

      return images.map(
        (image): { width: number; height: number; effectiveMultiplier: number } | null => {
          if (!image.width || !image.height) return null;

          if (selection.type === 'resolution') {
            const maxDim = Math.max(image.width, image.height);
            if (maxDim >= selection.resolution) return null;
            const dims = computeUpscaleDimensions(image.width, image.height, selection.resolution);
            if (Math.max(dims.width, dims.height) > MAX_OUTPUT_RESOLUTION) return null;
            const effectiveMultiplier =
              Math.max(dims.width, dims.height) / Math.max(image.width, image.height);
            return { ...dims, effectiveMultiplier };
          }

          // Multiplier mode: try selected, then fall back to lower multipliers
          const effective = findEffectiveMultiplier(
            image.width,
            image.height,
            selection.multiplier
          );
          if (effective === null) return null;
          const target = Math.max(image.width, image.height) * effective;
          const dims = computeUpscaleDimensions(image.width, image.height, target);
          return { ...dims, effectiveMultiplier: effective };
        }
      );
    },
    ['images', 'upscaleSelection']
  )
  // Per-image annotations for the images input overlay (parallel to images array)
  .computed(
    'annotations',
    (ctx): (ImageAnnotation | null)[] => {
      const images = ctx.images ?? [];
      const selection = ctx.upscaleSelection;
      if (!selection || images.length === 0) return [];

      return images.map((image) => {
        if (!image.width || !image.height) {
          return { label: 'No dims', color: 'red' as const, tooltip: 'Missing dimensions' };
        }

        if (selection.type === 'resolution') {
          const maxDim = Math.max(image.width, image.height);
          if (maxDim >= selection.resolution) {
            return {
              label: 'Excluded',
              color: 'red' as const,
              tooltip: `Already at or above ${selection.resolution}px`,
            };
          }
          const dims = computeUpscaleDimensions(image.width, image.height, selection.resolution);
          if (Math.max(dims.width, dims.height) > MAX_OUTPUT_RESOLUTION) {
            return {
              label: 'Excluded',
              color: 'red' as const,
              tooltip: `Would exceed ${MAX_OUTPUT_RESOLUTION}px max`,
            };
          }
          return {
            label: `${dims.width}x${dims.height}`,
            color: 'green' as const,
          };
        }

        // Multiplier mode
        const effective = findEffectiveMultiplier(image.width, image.height, selection.multiplier);
        if (effective === null) {
          return {
            label: 'Excluded',
            color: 'red' as const,
            tooltip: 'No valid multiplier — image too large',
          };
        }
        if (effective < selection.multiplier) {
          return {
            label: `x${effective}`,
            color: 'yellow' as const,
            tooltip: `Downgraded from x${selection.multiplier} to x${effective}`,
          };
        }
        return { label: `x${effective}`, color: 'green' as const };
      });
    },
    ['images', 'upscaleSelection']
  );

/** Type helper for the image upscale graph context */
export type ImageUpscaleGraphCtx = ReturnType<typeof imageUpscaleGraph.init>;
