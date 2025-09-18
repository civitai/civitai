import { useDidUpdate } from '@mantine/hooks';
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
    PageOS: any;
  }
}

const AdsContext = createContext<{
  ready: boolean;
  adsBlocked?: boolean;
  adsEnabled: boolean;
} | null>(null);

export function useAdsContext() {
  const context = useContext(AdsContext);
  if (!context) throw new Error('missing AdsProvider');
  return context;
}

const useAdProviderStore = create<{
  ready: boolean;
  scriptReady: boolean;
  adsBlocked: boolean;
}>(() => ({
  ready: false,
  scriptReady: false,
  adsBlocked: true,
}));

const blockedUrls: string[] = [
  '/collections/6503138',
  '/collections/7514194',
  '/collections/7514211',
  '/moderator',
];

const publisherId = env.NEXT_PUBLIC_PLAYWIRE_PUBLISHER_ID;
const websiteId = env.NEXT_PUBLIC_PLAYWIRE_WEBSITE_ID;
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
    useAdProviderStore.setState({ adsBlocked: true, ready: true });
  }

  useEffect(() => {
    function callback() {
      useAdProviderStore.setState({ adsBlocked: false, ready: true });

      // check for cmp consent
      if (window.__tcfapi) {
        window.__tcfapi('addEventListener', 2, function (tcData: any, success: boolean) {
          // TODO - need to test this
          if (['tcloaded', 'useractioncomplete'].includes(tcData.eventStatus)) {
            window.__tcfapi('removeEventListener', 2, null, tcData.listenerId);
            console.log({ __tcfapi: success });
            // AdConsent finished asking for consent, do something that is dependend on user consent ...
            if (!success) useAdProviderStore.setState({ adsBlocked: true });
          }
        });
      }

      window.googletag.cmd.push(function () {
        window.googletag.pubads().addEventListener('impressionViewable', function (event: any) {
          const slot = event.slot;
          const type = slot.getSlotElementId();
          console.log('adunit impression', type, slot);
          if (type) dispatchEvent(new CustomEvent('civitai-ad-impression', { detail: type }));
        });
      });
    }

    window.addEventListener('ramp-ready', callback);
    return () => {
      window.removeEventListener('ramp-ready', callback);
    };
  }, []);

  useDidUpdate(() => {
    if (ready && !adsBlocked) {
      window.ramp.que.push(() => {
        window.PageOS.newPageView();
      });
    }
  }, [router.pathname]);

  return (
    <AdsContext.Provider
      value={{
        ready,
        adsBlocked,
        adsEnabled,
      }}
    >
      {children}
      {adsEnabled && publisherId && websiteId && (
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
                    dispatchEvent(new CustomEvent('ramp-ready'));
                  })
                `,
            }}
          />
          <Script
            defer
            src={`//cdn.intergient.com/${publisherId}/${websiteId}/ramp.js`}
            data-cfasync="false"
            onError={handleLoadedError}
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
