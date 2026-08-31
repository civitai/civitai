import Router from 'next/router';
import { useEffect } from 'react';

type Props = {
  unsavedChanges?: boolean;
  message?: string;
  eval?: () => boolean;
  /**
   * Live, synchronous escape hatch. A caller trips it (synchronously) right before its OWN
   * programmatic `router.push` so the guard never blocks the redirect it intends, without
   * depending on the `unsavedChanges` effect having re-run first (the
   * effect-cleanup-vs-microtask race). Optional and backward-compatible: callers that omit it
   * keep the exact prior behaviour.
   *
   * `true` bypasses every navigation while it is set. Prefer a **url string**, which bypasses
   * only that one destination: the pages router cancels an in-flight `change()` by setting a
   * flag rather than settling its promise, and emits the new `routeChangeStart` before the old
   * push rejects — so with a bare `true` any navigation the user starts during an awaited push
   * also skips the prompt.
   */
  bypassRef?: { current: boolean | string | null };
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
      const bypass = bypassRef?.current;
      if (bypass === true) return;
      if (typeof bypass === 'string' && bypass === url) return;

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
