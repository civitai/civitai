import { trpc } from '~/utils/trpc';
import { TrackShareInput } from '~/server/schema/track.schema';

export const useTrackShare = () => {
  const { mutateAsync } = trpc.track.trackShare.useMutation();

  const handleTrackShare = async (data: TrackShareInput) => {
    await mutateAsync(data);
  };

  return { trackShare: handleTrackShare };
};
