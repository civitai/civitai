import { useRouter } from 'next/router';
import Script from 'next/script';
import React, { createContext, useContext, useEffect, useRef } from 'react';
import { create } from 'zustand';
import { adUnitsLoaded } from '~/components/Ads/ads.utils';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { isDev } from '~/env/other';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useDeviceFingerprint } from '~/providers/ActivityReportingProvider';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

declare global {
  interface Window {
    __tcfapi: (...args: any[]) => void;
    googletag: any;
    adngin: any;
  }
}

const AdsContext = createContext<{
  ready: boolean;
  adsBlocked?: boolean;
  adsEnabled: boolean;
  username?: string;
  isMember: boolean;
  kontextReady: boolean;
  kontextAvailable: boolean;
} | null>(null);

export function useAdsContext() {
  const context = useContext(AdsContext);
  if (!context) throw new Error('missing AdsProvider');
  return context;
}

const useAdProviderStore = create<{
  ready: boolean;
  adsBlocked: boolean;
  kontextReady: boolean;
  kontextAvailable: boolean;
}>(() => ({
  ready: false,
  adsBlocked: true,
  kontextReady: false,
  kontextAvailable: false,
}));

const blockedUrls: string[] = [
  '/collections/6503138',
  '/collections/7514194',
  '/collections/7514211',
  '/moderator',
];

export function AdsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const ready = useAdProviderStore((state) => state.ready);
  const adsBlocked = useAdProviderStore((state) => state.adsBlocked);
  const kontextReady = useAdProviderStore((state) => state.kontextReady);
  const kontextAvailable = useAdProviderStore((state) => state.kontextAvailable);
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  // derived value from browsingMode and nsfwOverride
  const isMember = currentUser?.isMember ?? false;
  const allowAds = useBrowsingSettings((x) => x.allowAds);
  const adsEnabled = isDev
    ? true
    : !features.isGreen &&
      features.isBlue &&
      (allowAds || !isMember) &&
      !blockedUrls.some((url) => router.asPath.includes(url));

  function handleLoadedError() {
    useAdProviderStore.setState({ adsBlocked: true });
  }

  function handleLoaded() {
    useAdProviderStore.setState({ adsBlocked: false });
  }

  useEffect(() => {
    function callback() {
      // check for cmp consent
      window.__tcfapi('addEventListener', 2, function (tcData: any, success: boolean) {
        if (['tcloaded', 'useractioncomplete'].includes(tcData.eventStatus)) {
          window.__tcfapi('removeEventListener', 2, null, tcData.listenerId);
          // AdConsent finished asking for consent, do something that is dependend on user consent ...
          if (!success) useAdProviderStore.setState({ adsBlocked: true });
          else useAdProviderStore.setState({ ready: true });
        }
      });

      window.googletag.cmd.push(function () {
        window.googletag.pubads().addEventListener('impressionViewable', function (event: any) {
          const slot = event.slot;
          const adUnit = slot.getAdUnitPath()?.split('/')?.reverse()?.[0];
          if (adUnit) dispatchEvent(new CustomEvent('civitai-ad-impression', { detail: adUnit }));
        });
      });
    }

    window.addEventListener('adnginLoaderReady', callback);
    return () => {
      window.removeEventListener('adnginLoaderReady', callback);
    };
  }, []);

  useEffect(() => {
    if (!!window.fetchKontextAd) return;

    function callback() {
      useAdProviderStore.setState({ kontextReady: true });
    }

    window.addEventListener('kontext-ad-script-loaded', callback);
    return () => {
      window.removeEventListener('kontext-ad-script-loaded', callback);
    };
  }, []);

  const kontextAvailableCheckedRef = useRef(false);
  useEffect(() => {
    if (!kontextAvailableCheckedRef.current) {
      kontextAvailableCheckedRef.current = true;
      kontextPrecheck().then((kontextAvailable) =>
        useAdProviderStore.setState({ kontextAvailable })
      );
    }
  }, []);

  return (
    <AdsContext.Provider
      value={{
        ready,
        adsBlocked,
        adsEnabled,
        username: currentUser?.username,
        isMember,
        kontextReady,
        kontextAvailable,
      }}
    >
      {children}
      {adsEnabled && isDev && (
        <Script
          id="snigel-ads-domain-spoof"
          data-cfasync="false"
          type="text/javascript"
          dangerouslySetInnerHTML={{
            __html: `
                // Spoofing domain to 'civitai.com' --> ONLY FOR TESTING PURPOSES.
                // This is required when the test environment domain differs from the production domain.
                window.addEventListener("adnginLoaderReady", function () {
                  adngin.queue.push(function () {
                    googletag.cmd.push(function () {
                      googletag.pubads().set("page_url", "civitai.com");
                    });
                  });
                });
              `,
          }}
        />
      )}
      {adsEnabled && (
        <Script
          id="snigel-config"
          data-cfasync="false"
          type="text/javascript"
          dangerouslySetInnerHTML={{
            __html: `

                window.snigelPubConf = {
                  "adengine": {
                    "activeAdUnits": ["incontent_1", "outstream", "side_1", "side_2", "side_3", "top", "adhesive"]
                  }
                }
              `,
          }}
        />
      )}
      {adsEnabled && (
        <Script
          async
          src="https://cdn.snigelweb.com/adengine/civitai.com/loader.js"
          onError={handleLoadedError}
          onLoad={handleLoaded}
        />
      )}
      {/* Cleanup old ad tags */}
      {adsEnabled && (
        <Script
          id="ad-cleanup"
          type="text/javascript"
          dangerouslySetInnerHTML={{
            __html: `
                // GPT
                window.googletag = window.googletag || {cmd: []};
                googletag.cmd.push(function() {
                  googletag.pubads().disableInitialLoad();
                  googletag.pubads().enableSingleRequest();
                  googletag.enableServices();
                });

                // adsense
                (window.adsbygoogle = window.adsbygoogle || []).pauseAdRequests = 1
              `,
          }}
        />
      )}
      {adsEnabled && <ImpressionTracker />}

      {features.kontextAds && (
        <Script
          id="kontext-ad-script"
          async
          type="module"
          dangerouslySetInnerHTML={{
            __html: `
          import('https://server.megabrain.co/sdk/js').then(({fetchAd, markAdAsViewed}) => {
            window.fetchKontextAd = fetchAd
            dispatchEvent(new CustomEvent('kontext-ad-script-loaded'))
          })

          `,
          }}
        />
      )}
    </AdsContext.Provider>
  );
}

function ImpressionTracker() {
  const currentUser = useCurrentUser();
  const { worker } = useSignalContext();
  const { fingerprint } = useDeviceFingerprint();

  useEffect(() => {
    const listener = ((e: CustomEvent) => {
      const adUnit = e.detail;
      adUnitsLoaded[adUnit] = true;
      if (worker && currentUser) {
        worker.send('recordAdImpression', {
          userId: currentUser.id,
          fingerprint,
          adId: adUnit,
        });
      }
    }) as EventListener;

    window.addEventListener('civitai-ad-impression', listener);
    return () => {
      window.removeEventListener('civitai-ad-impression', listener);
    };
  }, [fingerprint, worker, currentUser]);

  return null;
}

type KontextPrecheckResponse = {
  canShowAds: boolean;
};
async function kontextPrecheck() {
  if (isDev) return true;
  const response = await fetch('https://server.megabrain.co/api/v1/precheck', {
    method: 'POST',
    body: JSON.stringify({ publisherToken: isDev ? 'civitai-dev' : 'civitai-b9c3s0xx6u' }),
  });

  if (!response.ok) return false;
  const json: KontextPrecheckResponse = await response.json();
  return json.canShowAds;
}
