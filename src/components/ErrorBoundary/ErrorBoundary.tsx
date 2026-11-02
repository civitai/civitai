import Router, { useRouter } from 'next/router';
import { useSyncExternalStore } from 'react';
import UserErrorBoundary from '~/components/ErrorBoundary/UserErrorBoundary';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

// The window's own location as well as Next's asPath: routed dialogs (image
// detail) push through the browser router, which leaves asPath alone, and its
// provider sits inside this boundary — once the fallback shows, nothing of it is
// mounted to hear a Back.
const subscribe = (onChange: () => void) => {
  // A Back onto a Next entry for a different page is Next's to report through
  // asPath once it has swapped the page; hearing it here would reset early and
  // throw (and report) again under the old page. A Back onto the entry under a
  // routed dialog has the same asPath, so Next moves nothing and this is the
  // only signal.
  const onPopState = (event: PopStateEvent) => {
    if (event.state?.__N && event.state.as !== Router.asPath) return;
    onChange();
  };
  window.addEventListener('popstate', onPopState);
  window.addEventListener('locationchange', onChange);
  return () => {
    window.removeEventListener('popstate', onPopState);
    window.removeEventListener('locationchange', onChange);
  };
};
const windowLocation = () => window.location.pathname + window.location.search;

export function ErrorBoundary({ children }: { children: React.ReactNode }) {
  const features = useFeatureFlags();
  const router = useRouter();
  // The server snapshot matches what the client reads, so hydration does not
  // move the key.
  const location = useSyncExternalStore(
    subscribe,
    windowLocation,
    () => router.asPath.split('#')[0]
  );

  return (
    <UserErrorBoundary features={features} resetKey={`${router.asPath}|${location}`}>
      {children}
    </UserErrorBoundary>
  );
}
