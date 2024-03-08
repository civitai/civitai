import {
  startNavigationProgress,
  completeNavigationProgress,
  NavigationProgress,
} from '@mantine/nprogress';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

export function RouterTransition() {
  useIsChangingLocation();

  return <NavigationProgress autoReset />;
}

export const useIsChangingLocation = () => {
  const router = useRouter();
  const [isTransitioning, setIsTransitioning] = useState(false);

  useEffect(() => {
    const handleStart = (url: string) => {
      if (url !== router.asPath) {
        setIsTransitioning(true);
        startNavigationProgress();
      }
    };
    const handleComplete = () => {
      setIsTransitioning(false);
      completeNavigationProgress();
    };

    router.events.on('routeChangeStart', handleStart);
    router.events.on('routeChangeComplete', handleComplete);
    router.events.on('routeChangeError', handleComplete);

    return () => {
      router.events.off('routeChangeStart', handleStart);
      router.events.off('routeChangeComplete', handleComplete);
      router.events.off('routeChangeError', handleComplete);
    };
  }, [router.asPath, router.events]);

  return isTransitioning;
};
