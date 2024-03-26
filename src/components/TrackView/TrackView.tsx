import { useEffect, useRef } from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { AddViewSchema } from '~/server/schema/track.schema';
import { trpc } from '~/utils/trpc';

export function TrackView({
  type,
  entityType,
  entityId,
  details,
  nsfw: nsfwOverride,
  nsfwLevel,
}: AddViewSchema) {
  const currentUser = useCurrentUser();
  const trackMutation = trpc.track.addView.useMutation();
  const observedEntityId = useRef<number | null>(null);

  const status = useAdViewSatus();
  const nsfw = currentUser?.showNsfw ?? false;
  const browsingLevel = useBrowsingLevelDebounced();

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (entityId !== observedEntityId.current) {
        observedEntityId.current = entityId;
        trackMutation.mutate({
          type,
          entityType,
          entityId,
          details,
          ads: status,
          nsfw: nsfwOverride ?? nsfw,
          browsingLevel,
          nsfwLevel,
        });
      }
    }, 1000);
    return () => {
      clearTimeout(timeout);
    };
  }, [entityId, type, entityType, details]);

  return null;
}

function useAdViewSatus() {
  const { isMember, enabled, adsBlocked } = useAdsContext();
  if (isMember) return 'Member';
  if (!enabled) return 'Off';
  if (adsBlocked) return 'Blocked';
  return 'Served';
}
