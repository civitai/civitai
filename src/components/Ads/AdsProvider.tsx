import React, { createContext, useContext, useState } from 'react';

import { NsfwLevel } from '~/server/common/enums';
import { useGenerationStore } from '~/store/generation.store';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { env } from '~/env/client.mjs';
import { isProd } from '~/env/other';
import Script from 'next/script';
import { useConsentManager } from '~/components/Ads/ads.utils';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';

type AdProvider = 'ascendeum' | 'exoclick' | 'adsense';
const adProviders: AdProvider[] = ['ascendeum'];
const AscendeumAdsContext = createContext<{
  adsBlocked: boolean;
  nsfw: boolean;
  nsfwOverride?: boolean;
  adsEnabled: boolean;
  username?: string;
  isMember: boolean;
  enabled: boolean;
  providers: readonly string[];
  cookieConsent: boolean;
} | null>(null);

export function useAdsContext() {
  const context = useContext(AscendeumAdsContext);
  if (!context) throw new Error('missing AscendumAdsProvider');
  return context;
}

export function AdsProvider({ children }: { children: React.ReactNode }) {
  const [adsBlocked, setAdsBlocked] = useState(false);
  const currentUser = useCurrentUser();
  const isMember = !!currentUser?.isMember;
  // const enabled = env.NEXT_PUBLIC_ADS;
  const enabled = false;
  const adsEnabled = enabled && !isMember;
  // const { targeting: cookieConsent = false } = useConsentManager();
  const cookieConsent = true;

  // keep track of generation panel views that are considered nsfw
  const nsfwOverride = useGenerationStore(({ view, opened }) => {
    if (!opened) return;
    else if (view === 'queue' || view === 'feed') return true;
  });

  // derived value from browsingMode and nsfwOverride
  const browsingLevel = useBrowsingLevelDebounced();
  const nsfw = browsingLevel > NsfwLevel.PG;

  // const readyRef = useRef(false);
  // useEffect(() => {
  //   if (!readyRef.current && adsEnabled && cookieConsent) {
  //     readyRef.current = true;
  //     checkAdsBlocked((blocked) => {
  //       // setAdsBlocked(blocked);
  //       setAdsBlocked(!isProd ? true : blocked);
  //     });
  //   }
  // }, [adsEnabled, cookieConsent]);

  return (
    <AscendeumAdsContext.Provider
      value={{
        adsBlocked,
        nsfw,
        adsEnabled: adsEnabled,
        username: currentUser?.username,
        nsfwOverride,
        isMember,
        enabled,
        cookieConsent,
        providers: adProviders,
      }}
    >
      {adsEnabled &&
        cookieConsent &&
        adProviders.map((provider) => (
          <LoadProviderScript
            key={provider}
            provider={provider}
            onError={() => setAdsBlocked(true)}
          />
        ))}
      {children}
    </AscendeumAdsContext.Provider>
  );
}

function LoadProviderScript({ provider, onError }: { provider: AdProvider; onError: () => void }) {
  switch (provider) {
    case 'ascendeum':
      return <Script src="https://ads.civitai.com/asc.civitai.js" onError={onError} />;
    case 'adsense':
      return (
        <Script
          src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6320044818993728"
          onError={onError}
        />
      );
    case 'exoclick':
    default:
      return null;
  }
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
