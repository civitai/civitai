import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import Head from 'next/head';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import Script from 'next/script';
// import { isProd } from '~/env/other';
const isProd = true;

type AdProvider = 'ascendeum' | 'exoclick' | 'adsense' | 'pubgalaxy';
const adProviders: AdProvider[] = ['pubgalaxy'];

const AdsContext = createContext<{
  adsBlocked?: boolean;
  adsEnabled: boolean;
  username?: string;
  isMember: boolean;
  providers: readonly string[];
} | null>(null);

export function useAdsContext() {
  const context = useContext(AdsContext);
  if (!context) throw new Error('missing AdsProvider');
  return context;
}

export function AdsProvider({ children }: { children: React.ReactNode }) {
  const [adsBlocked, setAdsBlocked] = useState<boolean>();
  const currentUser = useCurrentUser();

  // derived value from browsingMode and nsfwOverride
  const browsingLevel = useBrowsingLevelDebounced();
  const nsfw = browsingLevel > sfwBrowsingLevelsFlag;
  const isMember = currentUser?.isMember ?? false;
  const adsEnabled = currentUser?.allowAds || !isMember;
  const [cmpLoaded, setCmpLoaded] = useState(false);

  const readyRef = useRef<boolean>();
  useEffect(() => {
    if (!readyRef.current && adsEnabled) {
      readyRef.current = true;
      if (!isProd) setAdsBlocked(true);
      else {
        checkAdsBlocked((blocked) => {
          setAdsBlocked(blocked);
        });
      }
    }
  }, [adsEnabled]);

  function handleCmpLoaded() {
    console.log('loaded');
    setCmpLoaded(true);
  }

  return (
    <AdsContext.Provider
      value={{
        adsBlocked: adsBlocked || !cmpLoaded,
        adsEnabled: adsEnabled && !nsfw,
        username: currentUser?.username,
        providers: adProviders,
        isMember,
      }}
    >
      {children}
      {adsEnabled && isProd && (
        <>
          <Script src="https://cmp.uniconsent.com/v2/stub.min.js" onLoad={handleCmpLoaded} />
          <Script src="https://cmp.uniconsent.com/v2/a635bd9830/cmp.js" async />
          {cmpLoaded && (
            <>
              <Script
                id="ads-start"
                type="text/javascript"
                dangerouslySetInnerHTML={{
                  __html: `
                window.googletag = window.googletag || {};
                window.googletag.cmd = window.googletag.cmd || [];
                window.googletag.cmd.push(function () {
                  window.googletag.pubads().enableAsyncRendering();
                  window.googletag.pubads().disableInitialLoad();
                });
                (adsbygoogle = window.adsbygoogle || []).pauseAdRequests = 1;
              `,
                }}
              />
              <Script
                id="ads-init"
                type="text/javascript"
                dangerouslySetInnerHTML={{
                  __html: `
              __tcfapi("addEventListener", 2, function(tcData, success) {
                if (success && tcData.unicLoad  === true) {
                  if(!window._initAds) {
                    window._initAds = true;

                    var script = document.createElement('script');
                    script.async = true;
                    script.src = '//dsh7ky7308k4b.cloudfront.net/publishers/civitaicom.min.js';
                    document.head.appendChild(script);

                    var script = document.createElement('script');
                    script.async = true;
                    script.src = '//btloader.com/tag?o=5184339635601408&upapi=true';
                    document.head.appendChild(script);
                  }
                }
              });
            `,
                }}
              />
            </>
          )}
          <div id="uniconsent-config" />
        </>
      )}
    </AdsContext.Provider>
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
