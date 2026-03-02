/**
 * Image Upscale Graph
 *
 * Graph for image upscale workflow (img2img:upscale).
 * This workflow has no ecosystem support - it operates on existing images
 * to increase resolution through upscaling.
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

export interface UpscaleSelectionMeta {
  sourceWidth: number | undefined;
  sourceHeight: number | undefined;
  maxOutputResolution: number;
  multiplierOptions: UpscaleMultiplierOption[];
  resolutionOptions: UpscaleResolutionOption[];
  canUpscale: boolean;
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
 * Resolve an UpscaleSelection to a target longest-side value.
 * - multiplier: source max dimension * multiplier
 * - resolution: the preset resolution value directly
 */
function resolveSelectionTarget(
  selection: UpscaleSelection,
  sourceWidth: number,
  sourceHeight: number
): number {
  if (selection.type === 'multiplier') {
    return Math.max(sourceWidth, sourceHeight) * selection.multiplier;
  }
  return selection.resolution;
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
 * - images: Source image (max 1)
 * - upscaleSelection: User's chosen preset (multiplier or resolution)
 * - targetDimensions: Computed output dimensions from images + upscaleSelection
 *
 * The available upscale options (multipliers and resolution presets) are
 * exposed via the upscaleSelection node meta so the UI can render preset buttons.
 */
export const imageUpscaleGraph = new DataGraph<Record<never, never>, GenerationCtx>()
  // Images node - upscale only allows 1 image
  .node('images', () => imagesNode(), [])
  // Upscale selection - the user's chosen preset
  .node(
    'upscaleSelection',
    (ctx) => {
      const image = ctx.images?.[0];
      const sourceWidth = image?.width;
      const sourceHeight = image?.height;
      const maxDimension =
        sourceWidth && sourceHeight ? Math.max(sourceWidth, sourceHeight) : undefined;

      // Build multiplier options
      const multiplierOptions: UpscaleMultiplierOption[] =
        sourceWidth && sourceHeight
          ? UPSCALE_MULTIPLIERS.map((multiplier) => {
              const target = Math.max(sourceWidth, sourceHeight) * multiplier;
              const dims = computeUpscaleDimensions(sourceWidth, sourceHeight, target);
              return {
                label: `x${multiplier}`,
                multiplier,
                ...dims,
                disabled: Math.max(dims.width, dims.height) > MAX_OUTPUT_RESOLUTION,
              };
            })
          : [];

      // Build resolution options
      const resolutionOptions: UpscaleResolutionOption[] =
        sourceWidth && sourceHeight
          ? UPSCALE_RESOLUTIONS.map(({ label, value: targetRes }) => {
              const dims = computeUpscaleDimensions(sourceWidth, sourceHeight, targetRes);
              return {
                label,
                resolution: targetRes,
                ...dims,
                disabled:
                  targetRes <= maxDimension! ||
                  Math.max(dims.width, dims.height) > MAX_OUTPUT_RESOLUTION,
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
        // When the source image changes, validate that the current selection is still valid.
        // If the selection is now disabled, reset to the first available option.
        transform: (
          value: UpscaleSelection,
          ctx: { images?: { width: number; height: number }[] }
        ) => {
          const img = ctx.images?.[0];
          if (!img?.width || !img?.height) return value;

          // Check if current selection produces valid dimensions
          const target = resolveSelectionTarget(value, img.width, img.height);
          const dims = computeUpscaleDimensions(img.width, img.height, target);
          const isValid = Math.max(dims.width, dims.height) <= MAX_OUTPUT_RESOLUTION;

          // For resolution selections, also check that the resolution exceeds the source
          if (value.type === 'resolution') {
            const maxDim = Math.max(img.width, img.height);
            if (value.resolution <= maxDim || !isValid) {
              return defaultValue ?? value;
            }
          }

          if (!isValid) return defaultValue ?? value;
          return value;
        },
        meta: {
          sourceWidth,
          sourceHeight,
          maxOutputResolution: MAX_OUTPUT_RESOLUTION,
          multiplierOptions,
          resolutionOptions,
          canUpscale,
        } satisfies UpscaleSelectionMeta,
      };
    },
    ['images']
  )
  // Computed target dimensions from images + upscaleSelection
  .computed(
    'targetDimensions',
    (ctx) => {
      const image = ctx.images?.[0];
      if (!image?.width || !image?.height) return undefined;
      const selection = ctx.upscaleSelection;
      if (!selection) return undefined;

      const target = resolveSelectionTarget(selection, image.width, image.height);
      return computeUpscaleDimensions(image.width, image.height, target);
    },
    ['images', 'upscaleSelection']
  );

/** Type helper for the image upscale graph context */
export type ImageUpscaleGraphCtx = ReturnType<typeof imageUpscaleGraph.init>;
