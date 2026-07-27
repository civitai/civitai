import { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import {
  getEdgeUrl,
  getInferredMediaType,
  shouldForceOptimized,
  type EdgeUrlProps,
} from '~/client-utils/edge-url';

// The pure URL builder now lives in `~/client-utils/edge-url` (React-free, so server
// modules can resolve a delivery URL without pulling hooks/providers into their import
// graph). Re-exported here so every existing consumer of this module is unaffected.
export {
  COMMON_IMAGE_WIDTHS,
  OPTIMIZED_WIDTH_THRESHOLD,
  getEdgeUrl,
  getInferredMediaType,
  shouldForceOptimized,
  snapWidthToCommonSize,
} from '~/client-utils/edge-url';
export type { EdgeUrlProps } from '~/client-utils/edge-url';

export function useEdgeUrl(src: string, options: Omit<EdgeUrlProps, 'src'> | undefined) {
  const currentUser = useCurrentUser();
  const inferredType = getInferredMediaType(src, options);
  let type = options?.type ?? inferredType;

  if (!src || src.startsWith('http') || src.startsWith('blob'))
    return { url: src, type: inferredType };

  let { anim, transcode } = options ?? {};

  if (inferredType === 'video' && type === 'image') {
    transcode = true;
    anim = false;
  } else if (type === 'video') {
    transcode = true;
    anim = anim ?? true;
  }

  if (!anim) type = 'image';
  // Threshold lives in `edge-url` so anything that has to reproduce this decision
  // outside React (the announcement banner health monitor) cannot drift from it.
  const shouldOptimize = shouldForceOptimized(options?.width);
  const optimized =
    options?.optimized ||
    shouldOptimize ||
    currentUser?.filePreferences?.imageFormat === 'optimized';

  return {
    url: getEdgeUrl(src, {
      ...options,
      anim,
      transcode,
      type,
      optimized: optimized ? true : undefined,
    }),
    type,
  };
}

export function useGetEdgeUrl(src?: string | null, options: Omit<EdgeUrlProps, 'src'> = {}) {
  const autoplayGifs = useBrowsingSettings((x) => x.autoplayGifs);
  if (!options.anim && !autoplayGifs) options.anim = false;
  return useMemo(() => (src ? getEdgeUrl(src, options) : undefined), [autoplayGifs, src]);
}
