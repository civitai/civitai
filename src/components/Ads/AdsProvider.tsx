import React, { createContext, useContext, useEffect, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import Script from 'next/script';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { isProd } from '~/env/other';
import { ImpressionTracker } from '~/components/Ads/ImpressionTracker';
import { Router } from 'next/router';
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

  // derived value from browsingMode and nsfwOverride
  const isMember = currentUser?.isMember ?? false;
  const allowAds = useBrowsingSettings((x) => x.allowAds);
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
          <Script src="https://cmp.uniconsent.com/v2/a635bd9830/cmp.js" async />
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
                          script.src = '//dsh7ky7308k4b.cloudfront.net/publishers/civitaicom.min.js';
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
              {/* {currentUser?.email && <AdsIdentity />} */}
              {/* <TcfapiSuccess
                onSuccess={(success) => {
                  if (success !== undefined) setAdsBlocked(!success);
                }}
              /> */}
              <GoogletagManager />
              <ImpressionTracker />
            </>
          )}
          <div id="uniconsent-config" />
        </>
      )}
    </AdsContext.Provider>
  );
}

// function AdsIdentity() {
//   const currentUser = useCurrentUser();
//   useEffect(() => {
//     const pgHB = window.pgHB;
//     const email = currentUser?.email;
//     if (pgHB && email) {
//       pgHB.que.push(function () {
//         pgHB.setUserAudienceData({ email });
//       });
//     }
//   }, [currentUser?.email]);

//   return null;
// }

// function TcfapiSuccess({ onSuccess }: { onSuccess: (success: boolean) => void }) {
//   useEffect(() => {
//     const callback = (data: any, success: boolean) => {
//       onSuccess(success);
//     };
//     if (!window.__tcfapi) onSuccess(false);

//     window.__tcfapi('addEventListener', 2, callback);
//     return () => {
//       window.__tcfapi('removeEventListener', 2, callback);
//     };
//   }, []);

//   return null;
// }

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
    __tcfapi: (command: string, version: number, callback: (...args: any[]) => void) => void;
    pgHB: {
      que: Array<() => void>;
      requestWebRewardedAd?: (args: unknown) => void;
      setUserAudienceData: (args: { email: string }) => void;
    };
    googletag: any;
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
