import { trpc } from '~/utils/trpc';
import { TrackActionInput, TrackSearchInput, TrackShareInput } from '~/server/schema/track.schema';

export const useTrackEvent = () => {
  const { mutateAsync: trackShare } = trpc.track.trackShare.useMutation();
  const { mutateAsync: trackAction } = trpc.track.addAction.useMutation();
  const { mutateAsync: trackSearch } = trpc.track.trackSearch.useMutation();

  const handleTrackShare = (data: TrackShareInput) => {
    return trackShare(data);
  };

  const handleTrackAction = (data: TrackActionInput) => {
    return trackAction(data);
  };

  const handleTrackSearch = (data: TrackSearchInput) => {
    return trackSearch(data);
  };

  return {
    trackShare: handleTrackShare,
    trackAction: handleTrackAction,
    trackSearch: handleTrackSearch,
  };
};
