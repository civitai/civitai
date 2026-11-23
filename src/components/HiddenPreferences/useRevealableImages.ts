import { useMemo } from 'react';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';

/**
 * Of the `served` images the viewer's hidden preferences did not keep, the ones only their own
 * hidden users, images or tags took out (see `withoutViewerHidden`).
 */
export function useRevealableImages<T extends { id: number }>(served: T[], kept: { id: number }[]) {
  const hidden = useMemo(() => {
    const keptIds = new Set(kept.map((image) => image.id));
    return served.filter((image) => !keptIds.has(image.id));
  }, [served, kept]);
  return useApplyHiddenPreferences({
    type: 'images',
    data: hidden as never,
    ignoreViewerHidden: true,
  }).items as unknown as T[];
}
