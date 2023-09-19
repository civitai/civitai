import { trpc } from '~/utils/trpc';
import { TrackEventInput, TrackShareInput } from '~/server/schema/track.schema';

export const useTrackEvent = () => {
  const { mutateAsync: trackShare } = trpc.track.trackShare.useMutation();
  const { mutateAsync: trackEvent } = trpc.track.addEvent.useMutation();

  const handleTrackShare = async (data: TrackShareInput) => {
    await trackShare(data);
  };

  const handleTrackEvent = async (data: TrackEventInput) => {
    await trackEvent(data);
  };

  return { trackShare: handleTrackShare, trackEvent: handleTrackEvent };
};
