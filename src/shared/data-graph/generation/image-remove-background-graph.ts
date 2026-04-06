/**
 * Image Remove Background Graph
 *
 * Graph for background removal workflow (img2img:remove-background).
 * This workflow has no ecosystem support - it operates on existing images
 * to remove backgrounds using AI segmentation.
 *
 * Note: This graph defines its own 'images' node since it doesn't use ecosystemGraph.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { imagesNode } from './common';

// =============================================================================
// Image Remove Background Graph
// =============================================================================

/**
 * Image remove background graph definition.
 *
 * Nodes:
 * - images: Source image (max 1)
 *
 * This is a simple workflow - no additional parameters are needed
 * for background removal.
 */
export const imageRemoveBackgroundGraph = new DataGraph<Record<never, never>, GenerationCtx>().node(
  'images',
  () => imagesNode(),
  []
);

/** Type helper for the image remove background graph context */
export type ImageRemoveBackgroundGraphCtx = ReturnType<typeof imageRemoveBackgroundGraph.init>;
