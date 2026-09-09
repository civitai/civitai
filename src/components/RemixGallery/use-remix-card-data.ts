import type { RemixGalleryCardEntry } from '~/server/services/remix-gallery.service';
import { useRemixGalleryBatch } from '~/components/RemixGallery/RemixGalleryBatchProvider';

export type RemixCardData = { count: number; entries: RemixGalleryCardEntry[] };

const NONE: RemixCardData = { count: 0, entries: [] };

/**
 * What a card knows about its remixes.
 *
 * One resolver rather than a read at each call site, because the frame and the
 * hover strip have to agree — a card wearing a frame that opens an empty panel
 * is worse than a card with neither, and they are decided in different files.
 */
export function useRemixCardData(imageId: number): RemixCardData {
  return useRemixGalleryBatch(imageId) ?? NONE;
}
