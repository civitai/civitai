import { Alert, useMantineColorScheme } from '@mantine/core';
import { useEffect } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { env } from '~/env/client.mjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';

declare global {
  interface Window {
    Canny: any;
    attachEvent: any;
  }
}

let initialized = false;
export function CannyIdentityProvider() {
  const currentUser = useCurrentUser();

  useEffect(() => {
    if (!currentUser || !env.NEXT_PUBLIC_CANNY_APP_ID || initialized) return;
    initialized = true;

    (function (w: Window, d: Document, i: string, s: string) {
      function l() {
        if (!d.getElementById(i)) {
          const f = d.getElementsByTagName(s)[0];
          const e = d.createElement(s) as HTMLScriptElement;
          e.type = 'text/javascript';
          e.async = true;
          e.src = 'https://canny.io/sdk.js';
          f.parentNode && f.parentNode.insertBefore(e, f);
        }
      }
      if (typeof w.Canny !== 'function') {
        const c: any = function (...args: any[]) {
          c.q.push(args);
        };
        c.q = [];
        w.Canny = c;
        if (d.readyState === 'complete') {
          l();
        } else if (w.attachEvent) {
          w.attachEvent('onload', l);
        } else {
          w.addEventListener('load', l, false);
        }
      }
    })(window, document, 'canny-jssdk', 'script');

    window.Canny('identify', {
      appID: env.NEXT_PUBLIC_CANNY_APP_ID,
      user: {
        email: currentUser.email,
        name: currentUser.username,
        id: currentUser.id,
        avatarUrl: currentUser.image ? getEdgeUrl(currentUser.image, { width: 96 }) : undefined,
        created: currentUser.createdAt,
      },
    });
  }, [currentUser]);

  return null;
}
