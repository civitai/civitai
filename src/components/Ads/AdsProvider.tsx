import React, { createContext, useContext, useState, useRef, useEffect, useCallback } from 'react';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';
import { useGenerationStore } from '~/store/generation.store';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { env } from '~/env/client.mjs';
import { useScript } from '~/hooks/useScript';

enum Test {
  Member,
  AdsBlocked,
  Ads,
}

const AscendeumAdsContext = createContext<{
  adsBlocked: boolean;
  nsfw: boolean;
  showAds: boolean;
  username?: string;
  isMember: boolean;
  enabled: boolean;
  ascendeumReady: boolean;
  exoclickReady: boolean;
} | null>(null);

export function useAdsContext() {
  const context = useContext(AscendeumAdsContext);
  if (!context) throw new Error('missing AscendumAdsProvider');
  return context;
}
export function AdsProvider({ children }: { children: React.ReactNode }) {
  const [adsBlocked, setAdsBlocked] = useState(false);
  const currentUser = useCurrentUser();
  const isMember = !!currentUser?.subscriptionId;
  const enabled = env.NEXT_PUBLIC_ADS;
  const showAds = enabled && !isMember;

  // keep track of generation panel views that are considered nsfw
  const nsfwOverride = useGenerationStore(({ view, opened }) => {
    if (!opened) return;
    else if (view === 'queue' || view === 'feed') return true;
  });

  // derived value from browsingMode and nsfwOverride
  const nsfw = useFiltersContext(
    useCallback((state) => nsfwOverride ?? state.browsingMode !== BrowsingMode.SFW, [nsfwOverride])
  );

  const ascendeumReady = useScript('https://ads.civitai.com/asc.civitai.js', {
    canLoad: showAds && !nsfw,
  });
  const exoclickReady = useScript('https://a.magsrv.com/ad-provider.js', {
    canLoad: showAds && nsfw,
  });

  const readyRef = useRef(false);
  useEffect(() => {
    if (!readyRef.current && showAds) {
      readyRef.current = true;
      checkAdsBlocked((blocked) => {
        setAdsBlocked(blocked);
      });
    }
  }, [showAds]);

  return (
    <AscendeumAdsContext.Provider
      value={{
        adsBlocked,
        nsfw,
        showAds,
        username: currentUser?.username,
        ascendeumReady,
        exoclickReady,
        isMember,
        enabled,
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
