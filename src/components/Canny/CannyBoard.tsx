import { Alert, useMantineColorScheme } from '@mantine/core';
import { env } from 'process';
import { useEffect } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';

declare global {
  interface Window {
    Canny: any;
    attachEvent: any;
  }
}

/*
let initialized = false;
const useCanny = ({ boardToken, basePath }: { boardToken?: string; basePath?: string }) => {
  const { colorScheme: theme } = useMantineColorScheme();
  const currentUser = useCurrentUser();
  const ssoToken = currentUser?.cannyToken;

  useEffect(() => {
    if (!boardToken) return;

    (function (w: Window, d: Document, i: string, s: string) {
      if (initialized) return;
      initialized = true;
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

    window.Canny('render', { boardToken, basePath, theme, ssoToken });

    return () => {
      document.getElementById('canny-iframe')?.remove();
    };
  }, [theme, ssoToken]);
};
*/

export function CannyBoard({ boardToken, basePath }: { boardToken?: string; basePath?: string }) {
  return <Alert color="yellow">Canny has been disabled.</Alert>;
  // useCanny({ boardToken, basePath });
  // if (!boardToken) return <Alert color="yellow">Canny has not been configured.</Alert>;
  // return <div data-canny></div>;
}
