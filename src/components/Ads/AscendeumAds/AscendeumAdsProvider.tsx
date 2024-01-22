import React, { createContext, useContext, useState, useRef, useEffect, useCallback } from 'react';
import { isProd } from '~/env/other';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';
import { useGenerationStore } from '~/store/generation.store';

const AscendeumAdsContext = createContext<{
  ready: boolean;
  adsBlocked: boolean;
  nsfw: boolean;
} | null>(null);

export function useAscendeumAdsContext() {
  const context = useContext(AscendeumAdsContext);
  if (!context) throw new Error('missing AscendumAdsProvider');
  return context;
}
export function AscendeumAdsProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [adsBlocked, setAdsBlocked] = useState(false);

  const readyRef = useRef(false);
  useEffect(() => {
    if (!readyRef.current) {
      readyRef.current = true;

      checkAdsBlocked((blocked) => {
        setAdsBlocked(blocked);
        if (blocked) setReady(true);
      });

      // if (isProd) {
      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = 'https://ads.civitai.com/asc.civitai.js';
      script.onload = () => {
        setReady(true);
      };
      document.body.appendChild(script);
      // }
    }
  }, []);

  const canView = useGenerationStore(({ view, opened }) => {
    if (!opened) return true;
    else return view === 'generate';
  });

  const nsfw = useFiltersContext(
    useCallback(
      (state) => {
        if (!canView) return true;
        else return state.browsingMode !== BrowsingMode.SFW;
      },
      [canView]
    )
  );

  return (
    <AscendeumAdsContext.Provider value={{ ready, adsBlocked, nsfw }}>
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
