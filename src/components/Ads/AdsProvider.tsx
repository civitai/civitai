import { useRouter } from 'next/router';
import Script from 'next/script';
import React, { createContext, useContext, useEffect } from 'react';
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
  consent: boolean;
  adsBlocked?: boolean;
  adsEnabled: boolean;
  useDirectAds: boolean;
  username?: string;
  isMember: boolean;
} | null>(null);

export function useAdsContext() {
  const context = useContext(AdsContext);
  if (!context) throw new Error('missing AdsProvider');
  return context;
}

const useAdProviderStore = create<{
  ready: boolean;
  adsBlocked: boolean;
  consent: boolean;
  browserBlocked: boolean;
}>(() => ({
  ready: false,
  adsBlocked: true,
  consent: true,
  browserBlocked: false,
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
  const consent = useAdProviderStore((state) => state.consent);
  const browserBlocked = useAdProviderStore((state) => state.browserBlocked);
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  // derived value from browsingMode and nsfwOverride
  const isMember = currentUser?.isMember ?? false;
  const allowAds = useBrowsingSettings((x) => x.allowAds);
  // .com (isGreen) → Snigel programmatic ads. .red (isRed) → CivitaiAdUnit direct ads only.
  // adsEnabled is domain-agnostic; useDirectAds chooses which ad system to render.
  const useDirectAds = features.isRed;
  // Some browsers (e.g. Brave) cosmetic-filter our ad elements even when the
  // Snigel loader succeeds, so `onError` never fires and we can't rely on
  // `adsBlocked` alone. Disable ads entirely when the browser is known to
  // silently block — no Snigel script, no interleaved slots.
  const adsEnabled = isDev
    ? true
    : !browserBlocked &&
      (allowAds || !isMember) &&
      !blockedUrls.some((url) => router.asPath.includes(url)) &&
      !router.asPath.split('?')[0].endsWith('/edit');

  function handleLoadedError() {
    useAdProviderStore.setState({ adsBlocked: true });
  }

  function handleLoaded() {
    useAdProviderStore.setState({ adsBlocked: false });
  }

  // For direct ads (.red), probe the ad server to detect adblockers.
  // Snigel's onLoad/onError callbacks don't fire since the script isn't loaded.
  useEffect(() => {
    if (!useDirectAds || !adsEnabled) return;
    const url = isDev ? 'http://localhost:5173' : 'https://advertising.civitai.com';
    fetch(`${url}/api/v1/serve?placement=probe&name=footer&container=1531&browsingLevel=1`, {
      credentials: 'include',
    })
      .then(() => useAdProviderStore.setState({ adsBlocked: false }))
      .catch(() => useAdProviderStore.setState({ adsBlocked: true }));
  }, [useDirectAds, adsEnabled]);

  useEffect(() => {
    const nav = navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } };
    if (typeof nav.brave?.isBrave === 'function') {
      nav.brave.isBrave().then((isBrave) => {
        if (isBrave) useAdProviderStore.setState({ browserBlocked: true });
      });
    }
  }, []);

  useEffect(() => {
    function callback() {
      // check for cmp consent
      window.__tcfapi('addEventListener', 2, function (tcData: any, success: boolean) {
        if (['tcloaded', 'useractioncomplete'].includes(tcData.eventStatus)) {
          window.__tcfapi('removeEventListener', 2, null, tcData.listenerId);
          // AdConsent finished asking for consent, do something that is dependend on user consent ...
          if (!success) useAdProviderStore.setState({ consent: false });
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

  return (
    <AdsContext.Provider
      value={{
        ready,
        adsBlocked,
        consent,
        adsEnabled,
        useDirectAds,
        username: currentUser?.username,
        isMember,
      }}
    >
      {children}
      {adsEnabled && !useDirectAds && isDev && (
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
      {adsEnabled && !useDirectAds && (
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
      {adsEnabled && !useDirectAds && (
        <Script
          defer
          src="https://cdn.snigelweb.com/adengine/civitai.com/loader.js"
          onError={handleLoadedError}
          onLoad={handleLoaded}
        />
      )}
      {/* Cleanup old ad tags */}
      {adsEnabled && !useDirectAds && (
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
      {adsEnabled && !useDirectAds && <ImpressionTracker />}
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
