import Router from 'next/router';
import { useEffect } from 'react';

type Props = { unsavedChanges?: boolean; message?: string; eval?: () => boolean };
// TODO.posts - props for hook to know only to catch navigation when leaving the site
// TODO.posts - eval prop to that takes a method that returns a boolean

export function useCatchNavigation({ unsavedChanges = false }: Props) {
  // Display alert when closing tab/window or navigating out,
  // if there are unsaved changes
  useEffect(() => {
    const warningMessage = 'All unsaved changes will be lost. Are you sure you want to exit?';
    function handleWindowClose(event: BeforeUnloadEvent) {
      if (!unsavedChanges) return;
      event.preventDefault();

      return (event.returnValue = warningMessage);
    }

    function handleBrowsingAway() {
      if (!unsavedChanges) return;
      if (window.confirm(warningMessage)) return;
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
  }, [unsavedChanges]);
}
