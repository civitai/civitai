import type Konva from 'konva';
import type { DrawingElement, DrawingLineInput } from './drawing.types';
import z from 'zod';
import { defaultCatch } from '~/utils/zod-helpers';
import { fetchBlobAsFile } from '~/utils/file-utils';
import { ExifParser, encodeMetadata } from '~/utils/metadata';
import {
  createExifSegmentFromTags,
  encodeUserCommentUTF16BE,
  isEncoded,
} from '~/utils/encoding-helpers';

// #region ID Generation

let elementIdCounter = 0;

/**
 * Generate a unique ID for drawing elements
 */
export function generateElementId(): string {
  elementIdCounter += 1;
  return `element-${Date.now()}-${elementIdCounter}`;
}

// #endregion

/**
 * Check if an element is transformable (can be selected, moved, resized, rotated)
 * Eraser strokes are NOT transformable as they create holes in the drawing
 */
export function isTransformableElement(el: DrawingElement): boolean {
  if (el.type === 'line' && el.tool === 'eraser') {
    return false;
  }
  return true;
}

// #region Normalization

/**
 * Normalize legacy DrawingLine (without 'type' field) to DrawingLineElement
 * Also ensures all elements have an ID
 */
export function normalizeElement(input: DrawingLineInput): DrawingElement {
  // If already has 'type', it's a new format element (DrawingElement or DrawingElementSchema)
  if ('type' in input) {
    // Ensure it has an ID - always spread to guarantee id is set
    const id = input.id || generateElementId();
    return { ...input, id } as DrawingElement;
  }
  // Legacy format - convert to new format with type discriminator and ID
  return {
    type: 'line',
    id: generateElementId(),
    tool: input.tool,
    points: input.points,
    color: input.color,
    strokeWidth: input.strokeWidth,
  };
}

/**
 * Normalize array of inputs (handles both legacy and new formats)
 */
export function normalizeElements(inputs: DrawingLineInput[]): DrawingElement[] {
  return inputs.map(normalizeElement);
}

// #endregion

/** Preset colors for drawing guidance (Mantine default theme colors) */
export const DRAWING_COLORS = [
  { color: '#fa5252', label: 'Red' },
  { color: '#40c057', label: 'Green' },
  { color: '#228be6', label: 'Blue' },
  { color: '#fab005', label: 'Yellow' },
  { color: '#000000', label: 'Black' },
  { color: '#ffffff', label: 'White' },
] as const;

/** Extended color swatches for the ColorPicker dropdown (Mantine theme colors) */
export const EXTENDED_COLOR_SWATCHES = [
  '#fa5252',
  '#e64980',
  '#be4bdb',
  '#7950f2',
  '#4c6ef5',
  '#228be6',
  '#15aabf',
  '#12b886',
  '#40c057',
  '#82c91e',
  '#fab005',
  '#fd7e14',
];

export const DEFAULT_BRUSH_SIZE = 10;
export const MIN_BRUSH_SIZE = 5;
export const MAX_BRUSH_SIZE = 50;
export const DEFAULT_BRUSH_COLOR = DRAWING_COLORS[0].color;

/**
 * Export the entire stage (background + drawing) as a composite JPEG blob with EXIF metadata
 * This creates a complete image with the original and all drawings merged
 *
 * @param stage - The Konva stage to export
 * @param canvasWidth - The display canvas width
 * @param canvasHeight - The display canvas height
 * @param originalWidth - The original image width (for full resolution export)
 * @param originalHeight - The original image height (for full resolution export)
 * @param sourceImageUrl - The source image URL to extract EXIF metadata from
 */
export async function exportDrawingToBlob(
  stage: Konva.Stage | null,
  canvasWidth: number,
  canvasHeight: number,
  originalWidth?: number,
  originalHeight?: number,
  sourceImageUrl?: string
): Promise<Blob> {
  if (!stage) {
    throw new Error('Stage is not available');
  }

  // Calculate pixelRatio to export at original image resolution
  // If original dimensions provided, scale up from canvas size to original size
  const pixelRatio = originalWidth && originalHeight ? originalWidth / canvasWidth : 1;

  // Get stage as canvas for JPEG conversion
  const stageCanvas = stage.toCanvas({
    pixelRatio,
    width: canvasWidth,
    height: canvasHeight,
  });

  // If source URL provided, extract EXIF and return JPEG with metadata
  if (sourceImageUrl) {
    try {
      const file = await fetchBlobAsFile(sourceImageUrl);
      if (file) {
        const parser = await ExifParser(file);

        let userComment =
          parser.exif.userComment && isEncoded(parser.exif.userComment)
            ? parser.exif.userComment
            : undefined;

        if (!userComment) {
          const meta = await parser.getMetadata();
          if (Object.keys(meta).length > 0) {
            userComment = encodeUserCommentUTF16BE(encodeMetadata(meta));
          }
        }

        // Create JPEG with EXIF
        const dataUrl = stageCanvas.toDataURL('image/jpeg', 0.95);
        const exifSegment = createExifSegmentFromTags({
          artist: parser.exif.Artist,
          userComment,
          software: parser.exif.Software,
        });

        const jpegBytes = Buffer.from(dataUrl.split(',')[1], 'base64');
        const soi = Uint8Array.prototype.slice.call(jpegBytes, 0, 2);
        const rest = Uint8Array.prototype.slice.call(jpegBytes, 2);
        const newJpegBytes = new Uint8Array(soi.length + exifSegment.length + rest.length);

        newJpegBytes.set(soi, 0);
        newJpegBytes.set(exifSegment, soi.length);
        newJpegBytes.set(rest, soi.length + exifSegment.length);

        return new Blob([newJpegBytes], { type: 'image/jpeg' });
      }
    } catch (error) {
      console.error('Failed to extract EXIF metadata:', error);

      if (error instanceof Error) throw error;
      throw new Error('An unknown error occurred while extracting EXIF metadata.');
    }
  }

  // Fallback: return JPEG without metadata
  const dataUrl = stageCanvas.toDataURL('image/jpeg', 0.95);
  const response = await fetch(dataUrl);
  return response.blob();
}

/**
 * Calculate canvas dimensions that fit within container while maintaining aspect ratio
 */
export function calculateCanvasDimensions(
  imageWidth: number,
  imageHeight: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number; scale: number } {
  const aspectRatio = imageWidth / imageHeight;

  let width = maxWidth;
  let height = maxWidth / aspectRatio;

  if (height > maxHeight) {
    height = maxHeight;
    width = maxHeight * aspectRatio;
  }

  const scale = width / imageWidth;

  return { width, height, scale };
}

export const imageAnnotationsSchema = defaultCatch(
  z
    .array(
      z.object({
        originalUrl: z.string(),
        originalWidth: z.number(),
        originalHeight: z.number(),
        compositeUrl: z.string(),
        lines: z.array(
          z.discriminatedUnion('type', [
            // Line element (brush/eraser)
            z.object({
              type: z.literal('line'),
              id: z.string().optional(),
              tool: z.enum(['brush', 'eraser']),
              points: z.array(z.number()),
              color: z.string(),
              strokeWidth: z.number(),
            }),
            // Rectangle element
            z.object({
              type: z.literal('rectangle'),
              id: z.string().optional(),
              x: z.number(),
              y: z.number(),
              width: z.number(),
              height: z.number(),
              color: z.string(),
              strokeWidth: z.number(),
              rotation: z.number().optional(),
            }),
            // Circle/ellipse element
            z.object({
              type: z.literal('circle'),
              id: z.string().optional(),
              x: z.number(),
              y: z.number(),
              radiusX: z.number(),
              radiusY: z.number(),
              color: z.string(),
              strokeWidth: z.number(),
              rotation: z.number().optional(),
            }),
            // Arrow element
            z.object({
              type: z.literal('arrow'),
              id: z.string().optional(),
              points: z.array(z.number()),
              color: z.string(),
              strokeWidth: z.number(),
              rotation: z.number().optional(),
            }),
            // Text element
            z.object({
              type: z.literal('text'),
              id: z.string().optional(),
              x: z.number(),
              y: z.number(),
              text: z.string(),
              fontSize: z.number(),
              color: z.string(),
              strokeWidth: z.number(),
              rotation: z.number().optional(),
              scaleX: z.number().optional(),
              scaleY: z.number().optional(),
              width: z.number().optional(),
            }),
          ])
        ),
      })
    )
    .nullable(),
  null
);
