import React from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import ContentErrorBoundary from '~/components/ErrorBoundary/ContentErrorBoundary';

export function AdUnitRenderable({
  children,
  hideOnBlocked,
}: {
  children: React.ReactElement;
  hideOnBlocked?: boolean;
}) {
  const { adsEnabled, adsBlocked } = useAdsContext();

  if (!adsEnabled) return null;
  if (hideOnBlocked && adsBlocked) return null;
  return <ContentErrorBoundary>{children}</ContentErrorBoundary>;
}
