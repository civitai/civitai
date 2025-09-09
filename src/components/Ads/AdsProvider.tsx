import { useRouter } from 'next/router';
import Script from 'next/script';
import React, { createContext, useContext, useEffect } from 'react';
import { create } from 'zustand';
import { adUnitsLoaded } from '~/components/Ads/ads.utils';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { env } from '~/env/client';
import { isDev } from '~/env/other';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useDeviceFingerprint } from '~/providers/ActivityReportingProvider';
import { useAppContext } from '~/providers/AppProvider';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';

declare global {
  interface Window {
    googletag: any;
    adngin: any;
    ramp: any;
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

const useAdProviderStore = create<{
  ready: boolean;
  adsBlocked: boolean;
}>(() => ({
  ready: false,
  adsBlocked: true,
}));

const blockedUrls: string[] = [
  '/collections/6503138',
  '/collections/7514194',
  '/collections/7514211',
  '/moderator',
];

export function AdsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { domain } = useAppContext();
  const ready = useAdProviderStore((state) => state.ready);
  const adsBlocked = useAdProviderStore((state) => state.adsBlocked);
  const currentUser = useCurrentUser();

  // derived value from browsingMode and nsfwOverride
  const isMember = currentUser?.isMember ?? false;
  const allowAds = useBrowsingSettings((x) => x.allowAds);
  const adsEnabled = isDev
    ? true
    : domain !== 'green' &&
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
      // window.__tcfapi('addEventListener', 2, function (tcData: any, success: boolean) {
      //   if (['tcloaded', 'useractioncomplete'].includes(tcData.eventStatus)) {
      //     window.__tcfapi('removeEventListener', 2, null, tcData.listenerId);
      //     // AdConsent finished asking for consent, do something that is dependend on user consent ...
      //     if (!success) useAdProviderStore.setState({ adsBlocked: true });
      //     else useAdProviderStore.setState({ ready: true });
      //   }
      // });

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
        adsEnabled,
        username: currentUser?.username,
        isMember,
      }}
    >
      {children}
      {adsEnabled &&
        env.NEXT_PUBLIC_PLAYWIRE_PUBLISHER_ID &&
        env.NEXT_PUBLIC_PLAYWIRE_WEBSITE_ID && (
          <>
            <Script
              id="playwire-onramp"
              type="text/javascript"
              data-cfasync="false"
              dangerouslySetInnerHTML={{
                __html: `
                  window.ramp = window.ramp || {};
                  window.ramp.que = window.ramp.que || [];
                  window.ramp.passiveMode = true;

                  window.ramp.que.push(() => {
                    console.log('ramp ready')
                    // TODO - set up impression tracking
                    // TODO - check consent status
                  })
                `,
              }}
            />
            <Script
              defer
              src={`//cdn.intergient.com/${env.NEXT_PUBLIC_PLAYWIRE_PUBLISHER_ID}/${env.NEXT_PUBLIC_PLAYWIRE_WEBSITE_ID}/ramp.js`}
              data-cfasync="false"
              onError={handleLoadedError}
              onLoad={handleLoaded}
            />
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
