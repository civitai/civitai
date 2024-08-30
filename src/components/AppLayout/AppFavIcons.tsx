import Head from 'next/head';
import { useMemo } from 'react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export default function AppFavIcons() {
  const featureFlags = useFeatureFlags();
  const { isGreen } = featureFlags;
  const iconProps = useMemo(() => {
    if (isGreen) {
      return {
        href: '/favicon-green.png',
        type: 'image/png',
        size: '50x50',
      };
    }

    return {
      href: '/favicon-blue.ico',
      type: 'image/x-icon',
      size: 'any',
    };
  }, [isGreen]);

  return (
    <Head>
      <link rel="icon" {...iconProps} />
    </Head>
  );
}
