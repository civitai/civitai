import React, { createContext, useContext, useState, useRef, useEffect, useCallback } from 'react';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';
import { useGenerationStore } from '~/store/generation.store';
import { isProd } from '~/env/other';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { env } from '~/env/client.mjs';

const AscendeumAdsContext = createContext<{
  ready: boolean;
  adsBlocked: boolean;
  nsfw: boolean;
  showAds: boolean;
  username?: string;
} | null>(null);

export function useAscendeumAdsContext() {
  const context = useContext(AscendeumAdsContext);
  if (!context) throw new Error('missing AscendumAdsProvider');
  return context;
}
export function AscendeumAdsProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [adsBlocked, setAdsBlocked] = useState(false);
  const currentUser = useCurrentUser();
  const showAds = env.NEXT_PUBLIC_ADS && !currentUser?.subscriptionId;

  const readyRef = useRef(false);
  useEffect(() => {
    if (!readyRef.current && showAds) {
      readyRef.current = true;

      // if (isProd) {
      checkAdsBlocked((blocked) => {
        setAdsBlocked(blocked);
        if (blocked) setReady(true);
      });

      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = 'https://ads.civitai.com/asc.civitai.js';
      script.onload = () => {
        setReady(true);
      };
      document.body.appendChild(script);
      // } else setAdsBlocked(true);
    }
  }, [showAds]);

  // keep track of generation panel views that are considered nsfw
  const nsfwOverride = useGenerationStore(({ view, opened }) => {
    if (!opened) return;
    else if (view === 'queue' || view === 'feed') return true;
  });

  // derived value from browsingMode and nsfwOverride
  const nsfw = useFiltersContext(
    useCallback((state) => nsfwOverride ?? state.browsingMode !== BrowsingMode.SFW, [nsfwOverride])
  );

  return (
    <AscendeumAdsContext.Provider
      value={{ ready, adsBlocked, nsfw, showAds, username: currentUser?.username }}
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
