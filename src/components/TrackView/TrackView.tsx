import { useEffect, useRef } from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
// import { useAdsContext } from '~/components/Ads/AdsProvider';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import type { AddViewSchema } from '~/server/schema/track.schema';
import { trpc } from '~/utils/trpc';

export function TrackView({
  type,
  entityType,
  entityId,
  details,
  nsfw: nsfwOverride,
  nsfwLevel,
}: AddViewSchema) {
  const trackMutation = trpc.track.addView.useMutation();
  const observedEntityId = useRef<number | null>(null);
  const { adsEnabled, adsBlocked } = useAdsContext();

  const nsfw = useBrowsingSettings((x) => x.showNsfw);
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
          ads: adsBlocked ? 'Blocked' : adsEnabled ? 'Served' : 'Off',
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

// function useAdViewSatus() {
//   const { isMember, enabled, adsBlocked } = useAdsContext();
//   if (isMember) return 'Member';
//   if (!enabled) return 'Off';
//   if (adsBlocked) return 'Blocked';
//   return 'Served';
// }
