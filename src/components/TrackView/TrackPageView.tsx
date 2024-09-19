/*
  TODO -
  1. determine if ads are loaded on the page
  2. determine page visit duration
*/

import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { useAdUnitLoadedStore } from '~/components/Ads/AdsProvider';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';

export function TrackPageView() {
  const router = useRouter();
  const browserRouter = useBrowserRouter();
  const pathname = browserRouter.asPath.split('?')[0];

  useEffect(() => {
    useAdUnitLoadedStore.setState({});
    const mountTime = Date.now();
    function trackPageView() {
      const duration = Date.now() - mountTime;
      if (duration < 1000) return;

      const ads = Object.keys(useAdUnitLoadedStore.getState()).length > 0;

      fetch('/api/page-view', {
        method: 'post',
        keepalive: true,
        body: JSON.stringify({ duration, ads }),
      });
    }

    window.addEventListener('beforeunload', trackPageView);
    return () => {
      trackPageView();
      window.removeEventListener('beforeunload', trackPageView);
    };
    //
  }, [router.pathname, pathname]);

  return null;
}
