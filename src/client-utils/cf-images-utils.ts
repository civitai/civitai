import { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import {
  getEdgeUrl,
  getEdgeUrlSrcSet,
  getInferredMediaType,
  resolveOptimized,
  resolveOptimizedLegacy,
  type EdgeUrlProps,
} from '~/client-utils/edge-url';
import { useMediaQuality } from '~/hooks/useMediaQuality';

// The pure URL builder now lives in `~/client-utils/edge-url` (React-free, so server
// modules can resolve a delivery URL without pulling hooks/providers into their import
// graph). Re-exported here so every existing consumer of this module is unaffected.
export {
  COMMON_IMAGE_WIDTHS,
  SRCSET_DPR,
  getEdgeUrl,
  getEdgeUrlSrcSet,
  getInferredMediaType,
  resolveOptimized,
  resolveOptimizedLegacy,
  resolvesToOriginal,
  snapWidthToCommonSize,
  toMediaQuality,
} from '~/client-utils/edge-url';
export type { EdgeUrlProps, MediaQuality } from '~/client-utils/edge-url';

/** @param hiDpi also emit a variant sized for a 2x display. The format is the viewer's. */
export function useEdgeUrl(
  src: string,
  options: Omit<EdgeUrlProps, 'src'> | undefined,
  hiDpi?: boolean
) {
  const currentUser = useCurrentUser();
  const { enabled: mediaQualityEnabled, quality } = useMediaQuality();
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
  const optimized = mediaQualityEnabled
    ? resolveOptimized({
        optimized: options?.optimized,
        width: options?.width,
        height: options?.height,
        original: options?.original,
        // Video is transcoded to an MP4/WebM for everyone, so lossless has nothing to buy here —
        // keyed off the SOURCE media, which also covers the still poster frame a video renders
        // through `type: 'image'`. Letting it through would only fork the cache key.
        quality: inferredType === 'video' ? 'compressed' : quality,
      })
    : resolveOptimizedLegacy({
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
