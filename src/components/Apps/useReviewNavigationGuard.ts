import { useCallback, useRef } from 'react';
import { useCatchNavigation } from '~/hooks/useCatchNavigation';

/**
 * Block navigation while `active` (an approve/reject mutation is in flight) on the
 * review PAGE. On the page there is no `<Modal>` shell, so the modal's `busyRef`
 * close-refusal has no analogue — a mod could click a nav link (or hit the browser
 * back button, or close the tab) mid-mutation and lose the in-flight action's
 * context.
 *
 * This is a THIN wrapper over the repo's existing `useCatchNavigation`, which
 * already implements the correct pages-router pattern: a `beforeunload` guard for
 * tab-close/reload, a `routeChangeStart` throw-to-cancel for client navigations
 * (browser back/forward included — pages-router routes those through
 * `routeChangeStart` too), the browser-history RESYNC (`history.pushState` back to
 * the current path so the URL doesn't desync on a vetoed back-button), and a
 * same-URL skip. Crucially it does NOT touch `router.beforePopState` — that setter
 * is a single global slot owned by the app's `RoutedDialogProvider`, and the prior
 * hand-rolled guard clobbered it (breaking app-wide routed-dialog back/forward
 * after any approve/reject).
 *
 * Returns a `bypass()` callback the caller trips SYNCHRONOUSLY immediately before
 * its own success-redirect (`router.push('/apps/review')`). Without it the guard
 * would block its OWN intended redirect — the guard is still armed at redirect time
 * because the disarm is a scheduled effect-cleanup that runs a microtask too late —
 * stranding the mod on the detail page. A genuine user-initiated navigation while a
 * mutation is in flight still prompts; only the programmatic redirect bypasses.
 */
export function useReviewNavigationGuard(
  active: boolean,
  message = 'A review decision is still being submitted. Leave the page anyway?'
) {
  const bypassRef = useRef(false);
  useCatchNavigation({ unsavedChanges: active, message, bypassRef });
  return useCallback(() => {
    bypassRef.current = true;
  }, []);
}
