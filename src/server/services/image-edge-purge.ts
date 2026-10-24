import { COMMON_IMAGE_WIDTHS, getEdgeUrl, resolveOptimized } from '~/client-utils/edge-url';
import { MediaType } from '~/shared/utils/prisma/enums';

export type ImageEdgePurgeTarget = { url: string; name?: string | null; type?: MediaType | null };

/**
 * The CDN urls a client can have requested for this image: the original and every width on the
 * ladder, under both names it is served as (its own name and its key), as `getEdgeUrl` spells them.
 */
export function getImageEdgePurgeUrls({ url, name, type }: ImageEdgePurgeTarget): string[] {
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
