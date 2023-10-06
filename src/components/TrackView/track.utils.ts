import { trpc } from '~/utils/trpc';
import { TrackActionInput, TrackShareInput } from '~/server/schema/track.schema';

export const useTrackEvent = () => {
  const { mutateAsync: trackShare } = trpc.track.trackShare.useMutation();
  const { mutateAsync: trackAction } = trpc.track.addAction.useMutation();

  const handleTrackShare = (data: TrackShareInput) => {
    return trackShare(data);
  };

  const handleTrackAction = (data: TrackActionInput) => {
    return trackAction(data);
  };

  return { trackShare: handleTrackShare, trackAction: handleTrackAction };
};
