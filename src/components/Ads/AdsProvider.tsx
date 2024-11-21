import React, { createContext, useContext, useEffect, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import Script from 'next/script';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { useDeviceFingerprint } from '~/providers/ActivityReportingProvider';
import { adUnitsLoaded } from '~/components/Ads/ads.utils';
import { create } from 'zustand';

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
} | null>(null);

export function useAdsContext() {
  const context = useContext(AdsContext);
  if (!context) throw new Error('missing AdsProvider');
  return context;
}

const useAdProviderStore = create<{ ready: boolean; adsBlocked: boolean }>(() => ({
  ready: false,
  adsBlocked: false,
}));

export function AdsProvider({ children }: { children: React.ReactNode }) {
  // const [ready, setReady] = useState(false);
  const ready = useAdProviderStore((state) => state.ready);
  const adsBlocked = useAdProviderStore((state) => state.adsBlocked);
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  // derived value from browsingMode and nsfwOverride
  const isMember = currentUser?.isMember ?? false;
  const allowAds = useBrowsingSettings((x) => x.allowAds);
  const adsEnabled = features.adsEnabled && (allowAds || !isMember);

  function handleLoadedError() {
    useAdProviderStore.setState({ adsBlocked: true });
  }

  useEffect(() => {
    function callback() {
      // check for cmp consent
      window.__tcfapi('addEventListener', 2, function (tcData: any, success: boolean) {
        console.log({ tcData, success });
        if (['tcloaded', 'useractioncomplete'].includes(tcData.eventStatus)) {
          window.__tcfapi('removeEventListener', 2, null, tcData.listenerId);
          // AdConsent finished asking for consent, do something that is dependend on user consent ...
          console.log('This code is triggered only once', tcData);
          if (!success) useAdProviderStore.setState({ adsBlocked: true });
          else useAdProviderStore.setState({ ready: true });
        }
      });

      window.googletag.cmd.push(function () {
        window.googletag.pubads().addEventListener('impressionViewable', function (event: any) {
          const slot = event.slot;
          const adUnit = slot.getAdUnitPath()?.split('/')?.reverse()?.[0];
          console.log('Ad visible in slot: ', adUnit);
          if (adUnit) dispatchEvent(new CustomEvent('civitai-ad-impression', { detail: adUnit }));
        });
      });
    }

    window.addEventListener('adnginLoaderReady', callback);
    return () => {
      window.removeEventListener('adnginLoaderReady', callback);
    };
  }, []);

  return (
    <AdsContext.Provider
      value={{
        ready,
        adsBlocked,
        adsEnabled,
        username: currentUser?.username,
        isMember,
      }}
    >
      {children}
      {adsEnabled && (
        <>
          <Script
            id="snigel-config"
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
                // END OF domain spoofing.

                window.snigelPubConf = {
                  "adengine": {
                    "activeAdUnits": ["incontent_1", "outstream", "side_1", "side_2", "side_3", "top"]
                  }
                }
              `,
            }}
          ></Script>

          <Script
            async
            src="https://cdn.snigelweb.com/adengine/civitai.com/loader.js"
            onError={handleLoadedError}
          />

          {/* Cleanup old ad tags */}
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
          ></Script>

          <ImpressionTracker />
        </>
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
        console.log('recording ad impression:', adUnit);
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
