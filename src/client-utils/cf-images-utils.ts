import { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import {
  getEdgeUrl,
  getEdgeUrlSrcSet,
  getInferredMediaType,
  resolveOptimized,
  type EdgeUrlProps,
} from '~/client-utils/edge-url';

// The pure URL builder now lives in `~/client-utils/edge-url` (React-free, so server
// modules can resolve a delivery URL without pulling hooks/providers into their import
// graph). Re-exported here so every existing consumer of this module is unaffected.
export {
  COMMON_IMAGE_WIDTHS,
  OPTIMIZED_WIDTH_THRESHOLD,
  SRCSET_DPR,
  getEdgeUrl,
  getEdgeUrlSrcSet,
  getInferredMediaType,
  resolveOptimized,
  shouldForceOptimized,
  snapWidthToCommonSize,
} from '~/client-utils/edge-url';
export type { EdgeUrlProps } from '~/client-utils/edge-url';

/** @param hiDpi emit a 2x `srcSet` variant, and force the optimized format — see `resolveOptimized`. */
export function useEdgeUrl(
  src: string,
  options: Omit<EdgeUrlProps, 'src'> | undefined,
  hiDpi?: boolean
) {
  const currentUser = useCurrentUser();
  const inferredType = getInferredMediaType(src, options);
  let type = options?.type ?? inferredType;

  if (!src || src.startsWith('http') || src.startsWith('blob'))
    return { url: src, srcSet: undefined, type: inferredType };

  let { anim, transcode } = options ?? {};

  if (inferredType === 'video' && type === 'image') {
    transcode = true;
    anim = false;
  } else if (type === 'video') {
    transcode = true;
    anim = anim ?? true;
  }

  if (!anim) type = 'image';
  // Decided in `edge-url` so anything that has to reproduce this outside React (the
  // announcement banner health monitor) cannot drift from it.
  const optimized = resolveOptimized({
    optimized: options?.optimized,
    width: options?.width,
    hiDpi,
    imageFormat: currentUser?.filePreferences?.imageFormat,
  });

  const resolved = {
    ...options,
    anim,
    transcode,
    type,
    optimized: optimized ? true : undefined,
  };

  return {
    url: getEdgeUrl(src, resolved),
    srcSet: hiDpi ? getEdgeUrlSrcSet(src, resolved) : undefined,
    type,
  };
}

export function useGetEdgeUrl(src?: string | null, options: Omit<EdgeUrlProps, 'src'> = {}) {
  const autoplayGifs = useBrowsingSettings((x) => x.autoplayGifs);
  if (!options.anim && !autoplayGifs) options.anim = false;
  return useMemo(() => (src ? getEdgeUrl(src, options) : undefined), [autoplayGifs, src]);
}
