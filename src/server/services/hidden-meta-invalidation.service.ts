import { purgeCache } from '~/server/cloudflare/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { bustImageDeliveryMetadataCache } from '~/server/services/image-delivery.service';
import { getImageEdgePurgeUrls } from '~/server/services/image-edge-purge';
import { IMAGE_CACHER_WAIT_MS } from '~/server/services/image-cacher-retraction';
import type { MediaType } from '~/shared/utils/prisma/enums';

type HiddenMetaImage = {
  id: number;
  url: string;
  name?: string | null;
  type?: MediaType | null;
};

/**
 * Clear an image's cached copies after its owner hides its metadata, so they re-derive under the
 * new setting. Keyed by url, so it also covers other rows that share the url.
 *
 * Only the delivery-cache bust is awaited: the cache service can take about a minute to purge, so
 * the rest runs detached from the save. The CDN is purged only after the cache service answers (or
 * the wait runs out), since the CDN refills from the cache service. Never throws.
 */
export async function invalidateHiddenImageMetadata(image: HiddenMetaImage) {
  await bustImageDeliveryMetadataCache(image.url);
  void purgeCachedCopies(image);
}

async function purgeCachedCopies(image: HiddenMetaImage) {
  try {
    // Lazy: post.service imports this module, and a static edge would join the image.service cycle.
    const { purgeResizeCache } = await import('~/server/services/image.service');
    // 🔴 Scoped: the image stays live, and only the variants derived before the flip are stale.
    // A full purge would also drop the variants the page is serving right now.
    await purgeResizeCache({
      url: image.url,
      scope: 'hidden-meta-orphans',
      waitForInvalidationMs: IMAGE_CACHER_WAIT_MS,
    });
    await purgeCache({ urls: getImageEdgePurgeUrls(image) });
  } catch (error) {
    await logToAxiom({
      type: 'warning',
      name: 'hidden-meta-invalidation',
      message: 'hidden-meta cache invalidation failed',
      imageKey: image.url,
      error: safeError(error),
    }).catch(() => {
      // swallow — best effort logging
    });
  }
}
