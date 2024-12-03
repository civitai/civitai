import React from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';

import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';

export function AdUnitRenderable({
  browsingLevel: browsingLevelOverride,
  children,
  hideOnBlocked,
}: {
  browsingLevel?: number;
  children?: React.ReactElement;
  hideOnBlocked?: boolean;
}) {
  const { adsEnabled, adsBlocked } = useAdsContext();
  const browsingLevel = useBrowsingLevelDebounced();
  const nsfw = !getIsSafeBrowsingLevel(browsingLevelOverride ?? browsingLevel);

  if (!adsEnabled || nsfw) return null;
  if (hideOnBlocked && adsBlocked) return null;
  return children ?? null;
}
