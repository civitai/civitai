import type Konva from 'konva';
import type { DrawingElement, DrawingLineElement, DrawingLineInput } from './drawing.types';

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
 * Check if an element type is transformable (can be moved/resized)
 * Lines are NOT transformable as they are freehand drawings
 */
export function isTransformableElement(el: DrawingElement): boolean {
  return el.type !== 'line';
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
  '#fa5252', '#e64980', '#be4bdb', '#7950f2', '#4c6ef5', '#228be6',
  '#15aabf', '#12b886', '#40c057', '#82c91e', '#fab005', '#fd7e14',
];

export const DEFAULT_BRUSH_SIZE = 10;
export const MIN_BRUSH_SIZE = 5;
export const MAX_BRUSH_SIZE = 50;
export const DEFAULT_BRUSH_COLOR = DRAWING_COLORS[0].color;

/**
 * Export the entire stage (background + drawing) as a composite PNG blob
 * This creates a complete image with the original and all drawings merged
 *
 * @param stage - The Konva stage to export
 * @param canvasWidth - The display canvas width
 * @param canvasHeight - The display canvas height
 * @param originalWidth - The original image width (for full resolution export)
 * @param originalHeight - The original image height (for full resolution export)
 */
export async function exportDrawingToBlob(
  stage: Konva.Stage | null,
  canvasWidth: number,
  canvasHeight: number,
  originalWidth?: number,
  originalHeight?: number
): Promise<Blob> {
  if (!stage) {
    throw new Error('Stage is not available');
  }

  // Calculate pixelRatio to export at original image resolution
  // If original dimensions provided, scale up from canvas size to original size
  const pixelRatio = originalWidth && originalHeight ? originalWidth / canvasWidth : 1;

  // Export entire stage (all layers) as PNG - creates composite image
  const dataUrl = stage.toDataURL({
    pixelRatio,
    mimeType: 'image/png',
    width: canvasWidth,
    height: canvasHeight,
  });

  // Convert data URL to blob
  const response = await fetch(dataUrl);
  const blob = await response.blob();

  return blob;
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