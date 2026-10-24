import { COMMON_IMAGE_WIDTHS, getEdgeUrl, resolveOptimized } from '~/client-utils/edge-url';
import { purgeCache } from '~/server/cloudflare/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { bustImageDeliveryMetadataCache } from '~/server/services/image-delivery.service';
import { MediaType } from '~/shared/utils/prisma/enums';

type HiddenMetaImage = {
  id: number;
  url: string;
  name?: string | null;
  type?: MediaType | null;
};

const CACHER_WAIT_MS = 70_000;

/** As a browser sends it: spaces and non-ASCII percent-encoded. That is the CDN's cache key. */
function asRequested(url: string) {
  try {
    return new URL(url).href;
  } catch {
    return encodeURI(url);
  }
}

/**
 * The CDN urls a client can have requested for this image: the original and every width on the
 * ladder, under each name it is served as (its own name, its id as the cards and detail page fall
 * back to, and its key), as `getEdgeUrl` spells them.
 */
export function getHiddenMetaPurgeUrls({ id, url, name, type }: HiddenMetaImage): string[] {
  const types = [...new Set([type ?? MediaType.image, MediaType.image])];
  const names = [...new Set([name ?? undefined, String(id), undefined])];
  const urls = new Set<string>();
  for (const t of types) {
    for (const n of names) {
      for (const anim of [undefined, false]) {
        urls.add(getEdgeUrl(url, { name: n, type: t, anim, original: true }));
        for (const width of COMMON_IMAGE_WIDTHS) {
          const optimized = resolveOptimized({ width }) ? true : undefined;
          urls.add(getEdgeUrl(url, { name: n, type: t, width, anim }));
          urls.add(getEdgeUrl(url, { name: n, type: t, width, anim, optimized }));
        }
      }
    }
  }
  return [...urls].map(asRequested);
}

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
      waitForInvalidationMs: CACHER_WAIT_MS,
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
