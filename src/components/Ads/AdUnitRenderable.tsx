import React, { createContext, useContext } from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';

import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import ContentErrorBoundary from '~/components/ErrorBoundary/ContentErrorBoundary';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';

const AdunitRenderableContext = createContext<{ nsfw: boolean; browsingLevel: number }>({
  nsfw: false,
  browsingLevel: 3,
});
export function useAdunitRenderableContext() {
  return useContext(AdunitRenderableContext);
}

export function AdUnitRenderable({
  browsingLevel: browsingLevelOverride,
  children,
  hideOnBlocked,
}: {
  browsingLevel?: number;
  children: React.ReactElement;
  hideOnBlocked?: boolean;
}) {
  const { adsEnabled, adsBlocked } = useAdsContext();
  const browsingLevel = useBrowsingLevelDebounced();
  const nsfw = !getIsSafeBrowsingLevel(browsingLevelOverride ?? browsingLevel);

  if (!adsEnabled) return null;
  if (hideOnBlocked && adsBlocked) return null;
  return (
    <AdunitRenderableContext.Provider
      value={{ nsfw, browsingLevel: browsingLevelOverride ?? browsingLevel }}
    >
      <ContentErrorBoundary>{children}</ContentErrorBoundary>
    </AdunitRenderableContext.Provider>
  );
}
