import Router from 'next/router';
import { useEffect } from 'react';

type Props = { unsavedChanges?: boolean; message?: string; eval?: () => boolean };

export function useCatchNavigation({
  unsavedChanges = false,
  message = 'All unsaved changes will be lost. Are you sure you want to exit?',
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
  }, [message, unsavedChanges]);
}
