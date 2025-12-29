import type Konva from 'konva';

/** Preset colors for drawing guidance (ControlNet scribble-style) */
export const DRAWING_COLORS = [
  { color: '#FF0000', label: 'Red' },
  { color: '#00FF00', label: 'Green' },
  { color: '#0000FF', label: 'Blue' },
  { color: '#FFFF00', label: 'Yellow' },
  { color: '#000000', label: 'Black' },
  { color: '#FFFFFF', label: 'White' },
] as const;

export const DEFAULT_BRUSH_SIZE = 15;
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
