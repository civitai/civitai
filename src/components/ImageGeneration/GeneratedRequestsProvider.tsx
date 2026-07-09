import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';
import { useRegisterOrder } from '~/components/ImageGeneration/utils/generationImage.select';
import {
  matchesMarkerTags,
  useGetTextToImageRequests,
} from '~/components/ImageGeneration/utils/generationRequestHooks';

type GeneratedRequests = ReturnType<typeof useGetTextToImageRequests>;

const GeneratedRequestsContext = createContext<GeneratedRequests | null>(null);

/**
 * Owns the generation workflow query for the Queue/Feed views and passes it down, so
 * the two views share one fetch and one infinite-scroll cursor instead of each calling
 * the hook. It also registers the single flat selection order (across all workflows, in
 * render order) — the same order both views display — so shift-click range selection is
 * consistent whether you're looking at the Queue or the Feed.
 */
export function GeneratedRequestsProvider({ children }: { children: ReactNode }) {
  const result = useGetTextToImageRequests();
  const { data, markerTags } = result;

  useRegisterOrder(
    'generated',
    useMemo(
      () =>
        data.flatMap((request) =>
          request.succeededOutput.filter((img) => matchesMarkerTags(img, markerTags))
        ),
      [data, markerTags]
    )
  );

  return (
    <GeneratedRequestsContext.Provider value={result}>{children}</GeneratedRequestsContext.Provider>
  );
}

export function useGeneratedRequestsContext() {
  const ctx = useContext(GeneratedRequestsContext);
  if (!ctx)
    throw new Error('useGeneratedRequestsContext must be used within a GeneratedRequestsProvider');
  return ctx;
}
