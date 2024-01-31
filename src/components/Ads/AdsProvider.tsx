import React, { createContext, useContext, useState, useRef, useEffect, useCallback } from 'react';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';
import { useGenerationStore } from '~/store/generation.store';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { env } from '~/env/client.mjs';
import { isProd } from '~/env/other';
import { useScript } from '~/hooks/useScript';

type AdProvider = 'ascendeum' | 'exoclick';
const AscendeumAdsContext = createContext<{
  adsBlocked: boolean;
  nsfw: boolean;
  nsfwOverride?: boolean;
  adsEnabled: boolean;
  username?: string;
  isMember: boolean;
  enabled: boolean;
  ascendeumReady: boolean;
  cmpDeclined: boolean;
  adSenseReady: boolean;
  available: AdProvider[];
  exoclickReady: boolean;
} | null>(null);

export function useAdsContext() {
  const context = useContext(AscendeumAdsContext);
  if (!context) throw new Error('missing AscendumAdsProvider');
  return context;
}
export function AdsProvider({ children }: { children: React.ReactNode }) {
  const [adsBlocked, setAdsBlocked] = useState(false);
  const [available, setAvailable] = useState<AdProvider[]>(['exoclick']);
  const currentUser = useCurrentUser();
  const isMember = !!currentUser?.subscriptionId;
  const enabled = env.NEXT_PUBLIC_ADS;
  const adsEnabled = enabled && !isMember;
  const ascendeumReady = useScript({
    src: 'https://ads.civitai.com/asc.civitai.js',
    canLoad: adsEnabled,
    onLoad: () => setAvailable((ready) => [...new Set<AdProvider>([...ready, 'ascendeum'])]),
  });

  // keep track of generation panel views that are considered nsfw
  const nsfwOverride = useGenerationStore(({ view, opened }) => {
    if (!opened) return;
    else if (view === 'queue' || view === 'feed') return true;
  });

  // derived value from browsingMode and nsfwOverride
  const nsfw = useFiltersContext(
    useCallback((state) => nsfwOverride ?? state.browsingMode !== BrowsingMode.SFW, [nsfwOverride])
  );

  const adSenseReady = useScript({
    src: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6320044818993728',
    canLoad: adsEnabled,
  });
  // const exoclickReady = useScript('https://a.magsrv.com/ad-provider.js', {
  //   canLoad: showAds && nsfw,
  // });
  const exoclickReady = true;

  const readyRef = useRef(false);
  useEffect(() => {
    if (!readyRef.current && adsEnabled) {
      readyRef.current = true;
      checkAdsBlocked((blocked) => {
        setAdsBlocked(blocked);
        // setAdsBlocked(!isProd ? true : blocked);
      });
    }
  }, [adsEnabled]);

  return (
    <AscendeumAdsContext.Provider
      value={{
        adsBlocked,
        nsfw,
        adsEnabled: adsEnabled,
        username: currentUser?.username,
        ascendeumReady,
        exoclickReady,
        cmpDeclined: false,
        nsfwOverride,
        adSenseReady,
        isMember,
        enabled,
        available,
      }}
    >
      {children}
    </AscendeumAdsContext.Provider>
  );
}

const REQUEST_URL = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
const checkAdsBlocked = (callback: (blocked: boolean) => void) => {
  fetch(REQUEST_URL, {
    method: 'HEAD',
    mode: 'no-cors',
  })
    // ads are blocked if request is redirected
    // (we assume the REQUEST_URL doesn't use redirections)
    .then((response) => {
      callback(response.redirected);
    })
    // ads are blocked if request fails
    // (we do not consider connction problems)
    .catch(() => {
      callback(true);
    });
};
