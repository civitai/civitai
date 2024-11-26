import React from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';

import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';

export function AdUnitRenderable({
  browsingLevel: browsingLevelOverride,
  children,
}: {
  browsingLevel?: number;
  children?: React.ReactElement;
}) {
  const { adsEnabled } = useAdsContext();
  const browsingLevel = useBrowsingLevelDebounced();
  const nsfw = !getIsSafeBrowsingLevel(browsingLevelOverride ?? browsingLevel);

  if (!adsEnabled || nsfw) return null;
  return children ?? null;
}
