import React from 'react';
import FourOhFour from '~/pages/404';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function FeatureLayout({
  children,
  conditional,
}: {
  children: React.ReactElement;
  conditional?: (features: ReturnType<typeof useFeatureFlags>) => boolean;
}) {
  const features = useFeatureFlags();

  if (conditional && !conditional(features)) return <FourOhFour />;

  return children;
}
