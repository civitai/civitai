import Router from 'next/router';
import { useEffect } from 'react';

type Props = {
  unsavedChanges?: boolean;
  message?: string;
  eval?: () => boolean;
  /**
   * Live, synchronous escape hatch. When this ref reads `true` at navigation
   * time, the guard lets the navigation through WITHOUT prompting — even while
   * `unsavedChanges` is still true. A caller trips it (synchronously) right
   * before its OWN programmatic `router.push` so the guard never blocks the
   * redirect it intends, without depending on the `unsavedChanges` effect having
   * re-run first (the effect-cleanup-vs-microtask race). Optional and
   * backward-compatible: callers that omit it keep the exact prior behaviour.
   */
  bypassRef?: { current: boolean };
};

export function useCatchNavigation({
  unsavedChanges = false,
  message = 'All unsaved changes will be lost. Are you sure you want to exit?',
  bypassRef,
}: Props) {
  // Display alert when closing tab/window or navigating out,
  // if there are unsaved changes
  useEffect(() => {
    function handleWindowClose(event: BeforeUnloadEvent) {
      if (!unsavedChanges) return;
      event.preventDefault();

      return (event.returnValue = message);
    }

    function handleBrowsingAway(url: string) {
      // Live escape hatch — a caller-owned programmatic redirect (which trips
      // this synchronously just before router.push) is never treated as an
      // unsaved-changes navigation, so the guard doesn't block its own redirect.
      if (bypassRef?.current) return;

      const currentUrl = window.location.pathname;
      const nextUrl = url.split('?')[0];

      if (currentUrl === nextUrl) return;
      if (!unsavedChanges) return;
      if (window.confirm(message)) return;
      Router.events.emit('routeChangeError');

      // Push state, because browser back action changes link and changes history state
      // but we stay on the same page
      if (Router.asPath !== window.location.pathname) {
        window.history.pushState('', '', Router.asPath);
      }

      // Throw to prevent navigation
      throw 'routeChange aborted.';
    }

    // Should only be set when form is dirty to avoid hit on performance
    // @see https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event#usage_notes
    if (unsavedChanges) {
      window.addEventListener('beforeunload', handleWindowClose);
      Router.events.on('routeChangeStart', handleBrowsingAway);
    } else {
      window.removeEventListener('beforeunload', handleWindowClose);
      Router.events.off('routeChangeStart', handleBrowsingAway);
    }

    return () => {
      window.removeEventListener('beforeunload', handleWindowClose);
      Router.events.off('routeChangeStart', handleBrowsingAway);
    };
  }, [message, unsavedChanges, bypassRef]);
}
