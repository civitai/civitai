import { z } from 'zod';
import { defineGraph } from 'form-graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { imagesDef, resourceSchema, resourceInputSchema, type ResourceData } from '../defs';

/**
 * Image upscale (img2img:upscale), ported from `image-upscale-graph.ts`.
 * Standalone — no ecosystem. Batch of up to 10 images; each image is
 * adaptively assigned the best usable multiplier, and the selection resets
 * to the default when the current one stops being useful for every image in
 * the batch (v1's transform, here a `correct` policy).
 */

// ---- copied from image-upscale-graph.ts, which dies with the data-graph engine

const MAX_OUTPUT_RESOLUTION = 4096;
const MAX_UPSCALE_IMAGES = 10;
const UPSCALE_MULTIPLIERS = [1.5, 2, 2.5, 3] as const;
const UPSCALE_RESOLUTIONS = [
  { label: '2K', value: 2048 },
  { label: '4K', value: 3840 },
] as const;

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

function isMultiplierValid(sourceWidth: number, sourceHeight: number, multiplier: number): boolean {
  const target = Math.max(sourceWidth, sourceHeight) * multiplier;
  const dims = computeUpscaleDimensions(sourceWidth, sourceHeight, target);
  return Math.max(dims.width, dims.height) <= MAX_OUTPUT_RESOLUTION;
}

function findEffectiveMultiplier(
  sourceWidth: number,
  sourceHeight: number,
  selectedMultiplier: number
): number | null {
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

const upscaleSelectionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('multiplier'), multiplier: z.number() }),
  z.object({ type: z.literal('resolution'), resolution: z.number() }),
]);

// ---- end of image-upscale-graph.ts copies -----------------------------------

/** v1's `upscalerNode`: an Upscaler-type resource with a pinned default. */
const UPSCALER = {
  input: resourceInputSchema.optional(),
  output: resourceSchema,
  default: { id: 164821, model: { type: 'Upscaler' } } as ResourceData,
  meta: (value: ResourceData | undefined) => ({
    options: {
      canGenerate: true,
      resources: [{ type: 'Upscaler' }],
      excludeIds: value ? [value.id] : [],
    },
  }),
};

export const imageUpscale = defineGraph<GenerationCtx>()
  .field('images', imagesDef({ min: 1, max: MAX_UPSCALE_IMAGES }))
  .field('upscaler', UPSCALER)
  .field('upscaleSelection', ({ images }) => {
    const batch = images ?? [];
    const firstImage = batch[0];
    const sourceWidth = firstImage?.width;
    const sourceHeight = firstImage?.height;

    const multiplierOptions: UpscaleMultiplierOption[] =
      sourceWidth && sourceHeight
        ? UPSCALE_MULTIPLIERS.map((multiplier) => {
            const target = Math.max(sourceWidth, sourceHeight) * multiplier;
            const dims = computeUpscaleDimensions(sourceWidth, sourceHeight, target);
            const disabled =
              batch.length > 0
                ? batch.every((img) => {
                    if (!img.width || !img.height) return true;
                    return !isMultiplierValid(img.width, img.height, multiplier);
                  })
                : true;
            return { label: `x${multiplier}`, multiplier, ...dims, disabled };
          })
        : [];

    const resolutionOptions: UpscaleResolutionOption[] =
      sourceWidth && sourceHeight
        ? UPSCALE_RESOLUTIONS.map(({ label, value: targetRes }) => {
            const dims = computeUpscaleDimensions(sourceWidth, sourceHeight, targetRes);
            const disabled =
              batch.length > 0
                ? batch.every((img) => {
                    if (!img.width || !img.height) return true;
                    const maxDim = Math.max(img.width, img.height);
                    if (maxDim >= targetRes) return true;
                    const imgDims = computeUpscaleDimensions(img.width, img.height, targetRes);
                    return Math.max(imgDims.width, imgDims.height) > MAX_OUTPUT_RESOLUTION;
                  })
                : true;
            return { label, resolution: targetRes, ...dims, disabled };
          })
        : [];

    const defaultMultiplier = multiplierOptions.find((o) => !o.disabled);
    const defaultValue: UpscaleSelection | undefined = defaultMultiplier
      ? { type: 'multiplier', multiplier: defaultMultiplier.multiplier }
      : undefined;

    const canUpscale =
      multiplierOptions.some((o) => !o.disabled) || resolutionOptions.some((o) => !o.disabled);

    /** Is the selection still useful for at least one image in the batch? */
    const isUseful = (value: UpscaleSelection): boolean => {
      if (batch.length === 0) return true;
      if (value.type === 'multiplier') {
        return batch.some(
          (img) =>
            img.width &&
            img.height &&
            findEffectiveMultiplier(img.width, img.height, value.multiplier) !== null
        );
      }
      return batch.some((img) => {
        if (!img.width || !img.height) return false;
        const maxDim = Math.max(img.width, img.height);
        if (maxDim >= value.resolution) return false;
        const dims = computeUpscaleDimensions(img.width, img.height, value.resolution);
        return Math.max(dims.width, dims.height) <= MAX_OUTPUT_RESOLUTION;
      });
    };

    return {
      input: upscaleSelectionSchema.optional(),
      output: upscaleSelectionSchema,
      default: defaultValue,
      // v1's transform: a selection that stopped being useful for every image
      // in the batch resets to the first available option
      correct: (value: UpscaleSelection) =>
        defaultValue && !isUseful(value)
          ? { value: defaultValue, reason: 'selection_useless_for_batch' }
          : undefined,
      meta: {
        sourceWidth,
        sourceHeight,
        maxOutputResolution: MAX_OUTPUT_RESOLUTION,
        multiplierOptions,
        resolutionOptions,
        canUpscale,
        imageCount: batch.length,
      } satisfies UpscaleSelectionMeta,
    };
  })
  .computed('targetDimensions', ({ images, upscaleSelection }) => {
    const batch = images ?? [];
    const selection = upscaleSelection;
    if (!selection || batch.length === 0) return [];

    return batch.map(
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

        const effective = findEffectiveMultiplier(image.width, image.height, selection.multiplier);
        if (effective === null) return null;
        const target = Math.max(image.width, image.height) * effective;
        const dims = computeUpscaleDimensions(image.width, image.height, target);
        return { ...dims, effectiveMultiplier: effective };
      }
    );
  })
  .computed('annotations', ({ images, upscaleSelection }): (ImageAnnotation | null)[] => {
    const batch = images ?? [];
    const selection = upscaleSelection;
    if (!selection || batch.length === 0) return [];

    return batch.map((image) => {
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
        return { label: `${dims.width}x${dims.height}`, color: 'green' as const };
      }

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
  });
