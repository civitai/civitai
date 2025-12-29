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
 * Export the drawing layer from Konva stage to a PNG blob
 * Only exports the drawing layer, not the background image
 */
export async function exportDrawingToBlob(
  stage: Konva.Stage | null,
  width: number,
  height: number
): Promise<Blob> {
  if (!stage) {
    throw new Error('Stage is not available');
  }

  // Get the drawing layer (second layer, index 1)
  const layers = stage.getLayers();
  const drawingLayer = layers[1];
  if (!drawingLayer) {
    throw new Error('Drawing layer not found');
  }

  // Export only the drawing layer as PNG with transparency
  const dataUrl = drawingLayer.toDataURL({
    pixelRatio: 1,
    mimeType: 'image/png',
    width,
    height,
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
