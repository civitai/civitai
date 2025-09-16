import React, { createContext, useContext, useEffect, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import Script from 'next/script';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { isProd } from '~/env/other';
import { Router } from 'next/router';
import { create } from 'zustand';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { useDeviceFingerprint } from '~/providers/ActivityReportingProvider';
import { devtools } from 'zustand/middleware';
import type { AdConfig } from '~/components/Ads/Old/ads.utils';
import { getAdConfig } from '~/components/Ads/Old/ads.utils';
import { useUserSettings } from '~/providers/UserSettingsProvider';
// const isProd = true;

type AdProvider = 'ascendeum' | 'exoclick' | 'adsense' | 'pubgalaxy';
const adProviders: AdProvider[] = ['pubgalaxy'];

const AdsContext = createContext<{
  adsBlocked?: boolean;
  adsEnabled: boolean;
  username?: string;
  isMember: boolean;
  providers: readonly string[];
} | null>(null);

export function useAdsContext() {
  const context = useContext(AdsContext);
  if (!context) throw new Error('missing AdsProvider');
  return context;
}

export function AdsProvider({ children }: { children: React.ReactNode }) {
  const [adsBlocked, setAdsBlocked] = useState<boolean | undefined>(!isProd ? true : undefined);
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const config = getAdConfig();

  // derived value from browsingMode and nsfwOverride
  const isMember = currentUser?.isMember ?? false;
  const allowAds = useUserSettings((x) => x.allowAds);
  const adsEnabled = features.adsEnabled && (allowAds || !isMember);
  // const [cmpLoaded, setCmpLoaded] = useState(false);

  // const readyRef = useRef<boolean>();
  // useEffect(() => {
  //   if (!readyRef.current && adsEnabled) {
  //     readyRef.current = true;
  //     if (!isProd) setAdsBlocked(true);
  //     else {
  //       checkAdsBlocked((blocked) => {
  //         setAdsBlocked(blocked);
  //       });
  //     }
  //   }
  // }, [adsEnabled]);

  function handleCmpLoaded() {
    // setCmpLoaded(true);
    if (isProd) setAdsBlocked(false);
  }

  function handleCmpError() {
    if (isProd) setAdsBlocked(true);
  }

  useEffect(() => {
    const listener = ((e: CustomEvent) => {
      const success = e.detail;
      if (success !== undefined) setAdsBlocked(!success);
    }) as EventListener;
    window.addEventListener('tcfapi-success', listener);
    return () => {
      window.removeEventListener('tcfapi-success', listener);
    };
  }, []);

  return (
    <AdsContext.Provider
      value={{
        adsBlocked: adsBlocked,
        adsEnabled: adsEnabled,
        username: currentUser?.username,
        providers: adProviders,
        isMember,
      }}
    >
      {children}
      {adsEnabled && isProd && (
        <>
          <Script
            src="https://cmp.uniconsent.com/v2/stub.min.js"
            onLoad={handleCmpLoaded}
            onError={handleCmpError}
          />
          <Script src={config.cmpScript} async />
          {adsBlocked === false && (
            <>
              <Script
                id="ads-start"
                type="text/javascript"
                dangerouslySetInnerHTML={{
                  __html: `
                window.googletag = window.googletag || {};
                window.googletag.cmd = window.googletag.cmd || [];
                window.googletag.cmd.push(function () {
                  window.googletag.pubads().enableAsyncRendering();
                  window.googletag.pubads().disableInitialLoad();
                });
                (adsbygoogle = window.adsbygoogle || []).pauseAdRequests = 1;
              `,
                }}
              />
              <Script
                id="ads-init"
                type="text/javascript"
                dangerouslySetInnerHTML={{
                  __html: `
                    __tcfapi?.("addEventListener", 2, function(tcData, success) {
                      dispatchEvent(new CustomEvent('tcfapi-success', {detail: success}));
                      if (success && tcData.unicLoad  === true) {
                        if(!window._initAds) {
                          window._initAds = true;

                          var script = document.createElement('script');
                          script.async = true;
                          script.src = '${config.adScript}';
                          document.head.appendChild(script);

                          var script = document.createElement('script');
                          script.async = true;
                          script.src = '//btloader.com/tag?o=5184339635601408&upapi=true';
                          document.head.appendChild(script);
                        }
                      }
                    });
                  `,
                }}
              />
              <Script
                id="ads-custom"
                type="text/javascript"
                dangerouslySetInnerHTML={{
                  __html: `
                  window.pgHB = window.pgHB || { que: [] }
                  window.googletag.cmd.push(function () {
                    googletag.pubads().addEventListener("impressionViewable", (event) => {
                      dispatchEvent(new CustomEvent('civitai-ad-impression', {detail: event.slot}));
                    });
                  });
                `,
                }}
              />
              <GoogletagManager />
              <ImpressionTracker config={config} />
            </>
          )}
          <div id="uniconsent-config" />
        </>
      )}
    </AdsContext.Provider>
  );
}

function GoogletagManager() {
  useEffect(() => {
    if (!window.googletag) return;
    function handleRouteChangeStart() {
      window.googletag?.destroySlots?.();
    }
    Router.events.on('routeChangeStart', handleRouteChangeStart);
    return () => {
      Router.events.off('routeChangeStart', handleRouteChangeStart);
    };
  }, []);

  return null;
}

declare global {
  interface Window {
    // __tcfapi: (command: string, version: number, callback: (...args: any[]) => void) => void;
    pgHB: {
      que: Array<() => void>;
      requestWebRewardedAd?: (args: unknown) => void;
      setUserAudienceData: (args: { email: string }) => void;
    };
    // googletag: any;
  }
}

// const REQUEST_URL = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
// const checkAdsBlocked = (callback: (blocked: boolean) => void) => {
//   fetch(REQUEST_URL, {
//     method: 'HEAD',
//     mode: 'no-cors',
//   })
//     // ads are blocked if request is redirected
//     // (we assume the REQUEST_URL doesn't use redirections)
//     .then((response) => {
//       callback(response.redirected);
//     })
//     // ads are blocked if request fails
//     // (we do not consider connction problems)
//     .catch(() => {
//       callback(true);
//     });
// };

export const useAdUnitLoadedStore = create<Record<string, boolean>>()(
  devtools(() => ({}), { name: 'adunits-loaded' })
);

function ImpressionTracker({ config }: { config: AdConfig }) {
  const currentUser = useCurrentUser();
  const { adsEnabled, adsBlocked } = useAdsContext();
  const { worker } = useSignalContext();
  const { fingerprint } = useDeviceFingerprint();

  useEffect(() => {
    const availableAdunitIds = Object.values(config.adunits);
    const listener = ((e: CustomEvent) => {
      if (!adsEnabled || adsBlocked) return;

      const slot = e.detail;
      const elemId = slot.getSlotElementId();
      const adunitId = elemId.split('-')[0];
      if (!adunitId || !availableAdunitIds.includes(adunitId)) return;

      const outOfPage = slot.getOutOfPage();
      const elem = document.getElementById(elemId);
      const exists = !!elem;

      useAdUnitLoadedStore.setState({ [elemId]: true });

      if (worker && exists && currentUser && !outOfPage) {
        const now = Date.now();
        const impressions = impressionsDictionary[elemId] ?? [];
        const lastImpression = impressions[impressions.length - 1];
        if (!lastImpression || now - lastImpression >= 10 * 1000) {
          impressionsDictionary[elemId] = [...impressions, now];

          worker.send('recordAdImpression', {
            userId: currentUser.id,
            fingerprint,
            adId: elemId.split('-')[0],
          });
        }
      }
    }) as EventListener;

    window.addEventListener('civitai-ad-impression', listener);
    return () => {
      window.removeEventListener('civitai-ad-impression', listener);
    };
  }, [adsEnabled, fingerprint, worker, adsBlocked, currentUser]);

  return null;
}

const impressionsDictionary: Record<string, number[]> = {};
