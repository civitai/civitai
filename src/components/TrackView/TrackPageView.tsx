import { useEffect, useRef } from 'react';
import { adUnitsLoaded } from '~/components/Ads/ads.utils';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { removeEmpty } from '~/utils/object-helpers';

export function TrackPageView() {
  const browserRouter = useBrowserRouter();
  const pathname = browserRouter.asPath.split('?')[0];

  const timeRef = useRef<{ visible: number; hidden?: number }[]>([{ visible: Date.now() }]);
  const durationRef = useRef(0);
  const ref = useRef<{ value: string; prev: string | null }>({
    value: pathname,
    prev: null,
  });

  useEffect(() => {
    const pushState = history.pushState;
    const replaceState = history.replaceState;

    function getDuration() {
      return timeRef.current.reduce(
        (acc, { visible, hidden = Date.now() }) => acc + (hidden - visible),
        0
      );
    }

    function updateRef(value: string) {
      const current = ref.current.value;
      if (value !== current) {
        durationRef.current = getDuration();
        timeRef.current = [{ visible: Date.now() }];
        ref.current = {
          value: value,
          prev: current,
        };
      }
    }

    function updateRefFromHistoryAction(url: string | URL | null | undefined) {
      if (!url) return;
      const obj = new URL(url, location.origin);
      updateRef(obj.pathname);
    }

    function popstate() {
      updateRef(location.pathname);
    }

    function visibilityChange() {
      if (document.visibilityState === 'visible') timeRef.current.push({ visible: Date.now() });
      else timeRef.current[timeRef.current.length - 1].hidden = Date.now();
    }

    function beforeUnload() {
      trackPageView({
        path: location.pathname,
        duration: getDuration(),
      });
    }

    document.addEventListener('visibilitychange', visibilityChange);
    window.addEventListener('popstate', popstate);
    window.addEventListener('beforeunload', beforeUnload);
    history.replaceState = function (data, unused, url) {
      updateRefFromHistoryAction(url);
      return replaceState.apply(history, [data, unused, url]);
    };
    history.pushState = function (data, unused, url) {
      updateRefFromHistoryAction(url);
      return pushState.apply(history, [data, unused, url]);
    };

    return function () {
      history.pushState = pushState;
      history.replaceState = replaceState;
      window.removeEventListener('popstate', popstate);
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('visibilitychange', visibilityChange);
    };
  }, []);

  useEffect(() => {
    const path = ref.current.prev;
    if (path) trackPageView({ path, duration: durationRef.current });
  }, [pathname]);

  return null;
}

function trackPageView({ path, duration }: { path: string; duration: number }) {
  if (duration < 1000) return;

  const ads = Object.keys(adUnitsLoaded).length > 0;

  fetch('/api/page-view', {
    method: 'post',
    keepalive: true,
    body: JSON.stringify(
      removeEmpty({
        duration,
        ads: ads ? true : undefined,
        path,
        windowWidth: window.outerWidth,
        windowHeight: window.outerHeight,
      })
    ),
  });

  for (const key in adUnitsLoaded) {
    delete adUnitsLoaded[key];
  }
}
