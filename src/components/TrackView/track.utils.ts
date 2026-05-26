import { useCallback } from 'react';
import { trpc } from '~/utils/trpc';
import type {
  TrackActionInput,
  TrackSearchInput,
  TrackShareInput,
} from '~/server/schema/track.schema';

export const useTrackEvent = () => {
  const { mutateAsync: trackShare } = trpc.track.trackShare.useMutation();
  const { mutateAsync: trackAction } = trpc.track.addAction.useMutation();
  const { mutateAsync: trackSearch } = trpc.track.trackSearch.useMutation();

  // React Query keeps `mutateAsync` identity stable across renders via
  // internal refs, so these `useCallback` wrappers actually stabilize the
  // returned handle for consumers. Downstream `useCallback` hooks that
  // include `trackAction` in their deps (e.g. ImagesCard.handleRemixClick)
  // won't re-invalidate every render. (Verify by checking React Query's
  // mutation source if the assumption changes — useMutation returns
  // mutateAsync bound to a ref, not a fresh closure per render.)
  const handleTrackShare = useCallback(
    (data: TrackShareInput) => trackShare(data),
    [trackShare]
  );

  const handleTrackAction = useCallback(
    (data: TrackActionInput) => trackAction(data),
    [trackAction]
  );

  const handleTrackSearch = useCallback(
    (data: TrackSearchInput) => trackSearch(data),
    [trackSearch]
  );

  return {
    trackShare: handleTrackShare,
    trackAction: handleTrackAction,
    trackSearch: handleTrackSearch,
  };
};
