import { useMemo } from 'react';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { getEdgeUrl, resolveEdgeUrl, type EdgeUrlProps } from '~/client-utils/edge-url';

// The pure URL builder now lives in `~/client-utils/edge-url` (React-free, so server
// modules can resolve a delivery URL without pulling hooks/providers into their import
// graph). Re-exported here so every existing consumer of this module is unaffected.
export {
  COMMON_IMAGE_WIDTHS,
  MAX_EDGE_WIDTH,
  SRCSET_DPR,
  getEdgeUrl,
  getEdgeUrlSrcSet,
  getInferredMediaType,
  resolveOptimized,
  resolvesToOriginal,
  snapWidthToCommonSize,
} from '~/client-utils/edge-url';
export type { EdgeUrlProps } from '~/client-utils/edge-url';

/** @param hiDpi also emit a variant sized for a 2x display. */
export function useEdgeUrl(
  src: string,
  options: Omit<EdgeUrlProps, 'src'> | undefined,
  hiDpi?: boolean
) {
  // Pure; it lives in `edge-url` so code outside React can compute the same URL.
  return resolveEdgeUrl(src, options, hiDpi);
}

export function useGetEdgeUrl(src?: string | null, options: Omit<EdgeUrlProps, 'src'> = {}) {
  const autoplayGifs = useBrowsingSettings((x) => x.autoplayGifs);
  if (!options.anim && !autoplayGifs) options.anim = false;
  return useMemo(() => (src ? getEdgeUrl(src, options) : undefined), [autoplayGifs, src]);
}
