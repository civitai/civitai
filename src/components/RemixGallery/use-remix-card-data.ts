import { useMemo } from 'react';
import type { RemixGalleryCardEntry } from '~/server/services/remix-gallery.service';
import {
  demoRemixCount,
  demoRemixEntries,
  useRemixDemoDensity,
  useRemixPeelStore,
} from '~/components/RemixGallery/remix-card-demo';
import { useRemixGalleryBatch } from '~/components/RemixGallery/RemixGalleryBatchProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

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
  const features = useFeatureFlags();
  const batch = useRemixGalleryBatch(imageId);
  const modulus = useRemixDemoDensity();
  // 🔴 Behind the same flag as the feature, not just behind the query string.
  // `demoActive` is set from `window.location.search` alone, and this hook is
  // called unconditionally by every image card — so without this an anonymous
  // visitor appending `?remixdemo=2` to any feed saw golden "this was remixed"
  // frames on half the cards, with thumbnails attributed by username to real
  // people who had nothing to do with those images. The demo branch also returns
  // before the batch is consulted, so it needed no provider and no flag: it was
  // the one path around the gate the rest of the feature sits behind.
  const demo = useRemixPeelStore((state) => state.demoActive) && !!features.remixGallery;

  return useMemo(() => {
    if (!demo) return batch ?? { count: 0, entries: [] };
    const count = demoRemixCount(imageId, modulus);
    return { count, entries: demoRemixEntries(imageId, Math.min(count, 4)) };
  }, [batch, demo, imageId, modulus]);
}
