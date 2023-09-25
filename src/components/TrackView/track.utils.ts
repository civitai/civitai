import { trpc } from '~/utils/trpc';
import { TrackEventInput, TrackShareInput } from '~/server/schema/track.schema';

export const useTrackEvent = () => {
  const { mutateAsync: trackShare } = trpc.track.trackShare.useMutation();
  const { mutateAsync: trackEvent } = trpc.track.addEvent.useMutation();

  const handleTrackShare = (data: TrackShareInput) => {
    return trackShare(data);
  };

  const handleTrackEvent = (data: TrackEventInput) => {
    return trackEvent(data);
  };

  return { trackShare: handleTrackShare, trackEvent: handleTrackEvent };
};
