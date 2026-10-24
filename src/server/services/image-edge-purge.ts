import { COMMON_IMAGE_WIDTHS, getEdgeUrl, resolveOptimized } from '~/client-utils/edge-url';
import { MediaType } from '~/shared/utils/prisma/enums';

export type ImageEdgePurgeTarget = {
  url: string;
  id?: number | null;
  name?: string | null;
  type?: MediaType | null;
};

const RELATIVE_BASE = 'https://relative.invalid';

/**
 * As a browser sends it, which is how the CDN keys it: parsed the way a browser parses an `src`, so
 * a space in a name is `%20` and a fragment is never sent.
 */
function asRequested(url: string) {
  const parsed = new URL(url, RELATIVE_BASE);
  parsed.hash = '';
  if (parsed.origin !== RELATIVE_BASE) return parsed.href;
  // Only without a configured image host (tests, local): keep the url relative.
  const path = parsed.pathname + parsed.search;
  return url.startsWith('/') ? path : path.slice(1);
}

/**
 * The CDN urls a client can have requested for this image: the original and every width on the
 * ladder, under each name it is served as (its key, its id, which clients use when it has no
 * name, and its own name), as `getEdgeUrl` spells them. Key-named urls come first: they are the
 * ones no owner input shapes.
 */
export function getImageEdgePurgeUrls({ url, id, name, type }: ImageEdgePurgeTarget): string[] {
  const types = [...new Set([MediaType.image, type ?? MediaType.image])];
  const names = [...new Set([undefined, id == null ? undefined : String(id), name ?? undefined])];
  const urls = new Set<string>();
  const add = (options: Parameters<typeof getEdgeUrl>[1]) =>
    urls.add(asRequested(getEdgeUrl(url, options)));
  for (const n of names) {
    for (const t of types) {
      add({ name: n, type: t, original: true });
      add({ name: n, type: t, original: true, anim: false });
      for (const width of COMMON_IMAGE_WIDTHS) {
        const optimized = resolveOptimized({ width }) ? true : undefined;
        for (const anim of [undefined, false]) {
          add({ name: n, type: t, width, anim });
          add({ name: n, type: t, width, anim, optimized });
        }
        // A video's still frame.
        if (t === MediaType.video) {
          add({ name: n, type: t, width, anim: false, transcode: true });
          add({ name: n, type: t, width, anim: false, transcode: true, optimized });
        }
      }
    }
  }
  // A name can spell a path (`../`), and the url it resolves to is then some other image's. Only
  // this image's urls are purged.
  const first = [...urls][0];
  const prefix = first.slice(0, first.indexOf(`${url}/`) + url.length + 1);
  return [...urls].filter((x) => x.startsWith(prefix));
}
