import type {
  RemixGalleryCardEntry,
  SparkStorylineCardEntry,
} from '~/server/services/remix-gallery.service';
import { useRemixGalleryBatch } from '~/components/RemixGallery/RemixGalleryBatchProvider';

export type RemixCardData = {
  count: number;
  entries: RemixGalleryCardEntry[];
  storylines: { count: number; entries: SparkStorylineCardEntry[] };
  /** Remixes or storylines: whether the card wears the frame and has a strip to open. */
  any: boolean;
};

const NO_STORYLINES: RemixCardData['storylines'] = { count: 0, entries: [] };
const NONE: RemixCardData = { count: 0, entries: [], storylines: NO_STORYLINES, any: false };

/**
 * What a card knows about its remixes and the storylines started from it.
 *
 * One resolver rather than a read at each call site, because the frame and the
 * hover strip have to agree — a card wearing a frame that opens an empty panel
 * is worse than a card with neither, and they are decided in different files.
 */
export function useRemixCardData(imageId: number): RemixCardData {
  const summary = useRemixGalleryBatch(imageId);
  if (!summary) return NONE;
  const storylines = summary.storylines ?? NO_STORYLINES;
  return { ...summary, storylines, any: summary.count > 0 || storylines.count > 0 };
}
