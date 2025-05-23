import { nprogress, NavigationProgress } from '@mantine/nprogress';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

export function RouterTransition() {
  useIsChangingLocation();

  return <NavigationProgress />;
}

export const useIsChangingLocation = () => {
  const router = useRouter();
  const [isTransitioning, setIsTransitioning] = useState(false);

  useEffect(() => {
    const handleStart = (url: string) => {
      if (url !== router.asPath) {
        setIsTransitioning(true);
        nprogress.start();
      }
    };
    const handleComplete = () => {
      setIsTransitioning(false);
      nprogress.complete();
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
