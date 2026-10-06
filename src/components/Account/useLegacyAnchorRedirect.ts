import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { resolveLegacyAnchorRedirect } from '~/components/Account/account-sections';

export function useLegacyAnchorRedirect() {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;

    const redirect = () => {
      // Read the URL rather than `router.query`: that one carries the route's own `section` param
      // and goes stale inside this closure.
      const target = resolveLegacyAnchorRedirect(window.location);
      if (target) router.replace(target);
    };

    redirect();
    // A link to `/user/account#creator-score` from a page already on `/user/account` changes only
    // the fragment, so the browser navigates within the same document and nothing remounts. Mount
    // alone would leave those in-app anchors dead while the same URL worked on a cold load.
    window.addEventListener('hashchange', redirect);
    return () => window.removeEventListener('hashchange', redirect);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);
}
