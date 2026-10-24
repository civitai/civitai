import { COMMON_IMAGE_WIDTHS, getEdgeUrl, resolveOptimized } from '~/client-utils/edge-url';
import { purgeCache } from '~/server/cloudflare/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { bustImageDeliveryMetadataCache } from '~/server/services/image-delivery.service';
import { purgeResizeCache } from '~/server/services/image.service';
import { MediaType } from '~/shared/utils/prisma/enums';

type HiddenMetaImage = { url: string; name?: string | null; type?: MediaType | null };

/**
 * The CDN urls a client can have requested for this image: the original and every width on the
 * ladder, under both names it is served as (its own name and its key), as `getEdgeUrl` spells them.
 */
export function getHiddenMetaPurgeUrls({ url, name, type }: HiddenMetaImage): string[] {
  const types = [...new Set([type ?? MediaType.image, MediaType.image])];
  const names = [...new Set([name ?? undefined, undefined])];
  const urls = new Set<string>();
  for (const t of types) {
    for (const n of names) {
      urls.add(getEdgeUrl(url, { name: n, type: t, original: true }));
      for (const width of COMMON_IMAGE_WIDTHS) {
        const optimized = resolveOptimized({ width }) ? true : undefined;
        for (const anim of [undefined, false]) {
          urls.add(getEdgeUrl(url, { name: n, type: t, width, anim }));
          urls.add(getEdgeUrl(url, { name: n, type: t, width, anim, optimized }));
        }
      }
    }
  }
  return [...urls];
}

/**
 * Invalidate every cached copy that may still carry an image's metadata after its owner hid it.
 * Keyed by url, so it also covers other rows that share the url.
 *
 * The order matters: each layer refills from the one after it, so clearing the CDN before the
 * cache service has dropped its copies would let the CDN refill from those copies. Never throws:
 * the caller is the user's save.
 */
export async function invalidateHiddenImageMetadata(image: HiddenMetaImage) {
  await bustImageDeliveryMetadataCache(image.url);
  try {
    // 🔴 Scoped: the image stays live, and only the variants derived before the flip are stale.
    // A full purge would also drop the variants the page is serving right now.
    await purgeResizeCache({
      url: image.url,
      scope: 'hidden-meta-orphans',
      waitForInvalidation: true,
    });
    await purgeCache({ urls: getHiddenMetaPurgeUrls(image) });
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
