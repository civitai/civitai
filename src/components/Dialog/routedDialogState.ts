/**
 * Safari/iOS null-`history.state` guard for the routed-dialog effect.
 *
 * Safari (and iOS WebViews) deliver a `null` `history.state` on some
 * back/forward navigations and back-forward-cache restores (the same class of
 * crash fixed in BrowserRouterProvider/ClientHistoryStore). The routed-dialog
 * effect runs on that nav and, on a `?dialog=…` URL, read the nested props off
 * `history.state.state` to spread into the opened dialog — an unguarded
 * `history.state.state` threw `TypeError: null is not an object`.
 *
 * Degrade to an empty object when the nested state is missing/not an object, so
 * the dialog opens with no extra props instead of crashing. Mirrors
 * `resolveLocationChangeState`'s `?? {}` fallback.
 */
export function getRoutedDialogState(historyState: unknown): Record<string, any> {
  if (historyState && typeof historyState === 'object') {
    const nested = (historyState as { state?: unknown }).state;
    if (nested && typeof nested === 'object') return nested as Record<string, any>;
  }
  return {};
}
