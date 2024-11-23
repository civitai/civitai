import { useSession } from 'next-auth/react';
import React from 'react';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import FourOhFour from '~/pages/404';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function FeatureLayout({
  children,
  conditional,
}: {
  children: React.ReactElement;
  conditional?: (features: ReturnType<typeof useFeatureFlags>) => boolean;
}) {
  const session = useSession();
  const features = useFeatureFlags();

  if (conditional) {
    if (session.status === 'loading') return <PageLoader />;
    else if (!conditional(features)) return <FourOhFour />;
  }

  return children;
}
