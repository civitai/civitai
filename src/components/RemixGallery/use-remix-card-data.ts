import { useMemo } from 'react';
import type { RemixGalleryCardEntry } from '~/server/services/remix-gallery.service';
import {
  demoRemixCount,
  demoRemixEntries,
  useRemixDemoDensity,
  useRemixPeelStore,
} from '~/components/RemixGallery/remix-card-demo';
import { useRemixGalleryBatch } from '~/components/RemixGallery/RemixGalleryBatchProvider';

export type RemixCardData = { count: number; entries: RemixGalleryCardEntry[] };

/**
 * What a card knows about its remixes: the real batched summary, or the
 * stand-in when `?remixdemo=` asks for it.
 *
 * One resolver rather than a branch at each call site, because the frame and the
 * hover strip have to agree — a card wearing a frame that opens an empty panel
 * is worse than a card with neither, and they are decided in different files.
 *
 * The demo is opt-in now that the real query exists. It stays because production
 * has 237 host images with any approved entry, so a review pass on real data
 * would scroll past nothing at all.
 */
export function useRemixCardData(imageId: number): RemixCardData {
  const batch = useRemixGalleryBatch(imageId);
  const modulus = useRemixDemoDensity();
  const demo = useRemixPeelStore((state) => state.demoActive);

  return useMemo(() => {
    if (!demo) return batch ?? { count: 0, entries: [] };
    const count = demoRemixCount(imageId, modulus);
    return { count, entries: demoRemixEntries(imageId, Math.min(count, 4)) };
  }, [batch, demo, imageId, modulus]);
}
