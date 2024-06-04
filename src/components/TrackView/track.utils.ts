import { trpc } from '~/utils/trpc';
import {
  TrackActionInput,
  TrackPlayInput,
  TrackSearchInput,
  TrackShareInput,
} from '~/server/schema/track.schema';
import { useCallback } from 'react';

export const useTrackEvent = () => {
  const { mutateAsync: trackShare } = trpc.track.trackShare.useMutation();
  const { mutateAsync: trackAction } = trpc.track.addAction.useMutation();
  const { mutateAsync: trackSearch } = trpc.track.trackSearch.useMutation();
  const { mutateAsync: trackPlay } = trpc.track.trackPlay.useMutation();

  const handleTrackShare = useCallback((data: TrackShareInput) => trackShare(data), [trackShare]);

  const handleTrackAction = useCallback(
    (data: TrackActionInput) => trackAction(data),
    [trackAction]
  );

  const handleTrackSearch = useCallback(
    (data: TrackSearchInput) => trackSearch(data),
    [trackSearch]
  );

  const handleTrackPlay = useCallback((data: TrackPlayInput) => trackPlay(data), [trackPlay]);

  return {
    trackShare: handleTrackShare,
    trackAction: handleTrackAction,
    trackSearch: handleTrackSearch,
    trackPlay: handleTrackPlay,
  };
};
