import { useEffect } from 'react';
import { installMediaOverlapDetector } from '~/components/EdgeMedia/media-overlap-detector';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export function MediaOverlapDetectorMount() {
  const isModerator = useCurrentUser()?.isModerator ?? false;
  const { mutate } = trpc.track.mediaOverlap.useMutation();

  useEffect(() => {
    if (!isModerator) return;
    return installMediaOverlapDetector({ report: (report) => mutate(report) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `mutate` is stable
  }, [isModerator]);

  return null;
}
