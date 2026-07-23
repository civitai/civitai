import { useRouter } from 'next/router';
import { useEffect } from 'react';

/**
 * Block navigation while `active` (an approve/reject mutation is in flight).
 *
 * On the review PAGE there is no `<Modal>` shell, so the modal's `busyRef`
 * close-refusal has no analogue — a mod could click a nav link (or hit the
 * browser back button, or close the tab) mid-mutation and lose the in-flight
 * action's context. This installs the pages-router equivalent while `active`:
 *
 *  - `routeChangeStart` — throwing from the handler is the documented Next.js
 *    pages-router idiom to CANCEL a client-side navigation (there is no
 *    promise-returning veto). We emit `routeChangeError` first to clear the
 *    NProgress/loading indicator, then throw a sentinel the router swallows.
 *  - `beforePopState` — returns `false` to veto browser back/forward (which does
 *    not go through `routeChangeStart`).
 *  - `beforeunload` — the browser-native guard for a tab close / hard reload.
 *
 * All three are torn down when `active` flips false (or on unmount), so a settled
 * mutation immediately releases navigation. Idempotent: mounting with
 * `active === false` registers nothing.
 */
export function useReviewNavigationGuard(active: boolean, message = 'A review action is still in progress.') {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;

    const abortRouteChange = () => {
      // Clear the loading indicator the router already started, then abort.
      router.events.emit('routeChangeError');
      // The router catches this to cancel the navigation (documented pattern).
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw `Route change aborted: ${message}`;
    };

    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers require returnValue to be set to show the prompt.
      e.returnValue = message;
      return message;
    };

    router.events.on('routeChangeStart', abortRouteChange);
    router.beforePopState(() => false);
    window.addEventListener('beforeunload', beforeUnload);

    return () => {
      router.events.off('routeChangeStart', abortRouteChange);
      // Reset the popstate veto so history navigation works again.
      router.beforePopState(() => true);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [active, message, router]);
}
