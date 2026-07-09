/**
 * Safari (and iOS WebViews) deliver a `null` `history.state` / popstate
 * `e.state` on some back/forward navigations and back-forward-cache restores,
 * where Chrome keeps the Next.js-populated state object. Reading `.key` off that
 * null threw `TypeError: null is not an object` and broke client-side back
 * navigation for iOS users. Resolve the key defensively: return `undefined`
 * when there is no usable string key so callers degrade to "no key for this
 * entry" (skip index bookkeeping) instead of crashing.
 */
export function getHistoryStateKey(state: unknown): string | undefined {
  if (state && typeof state === 'object') {
    const key = (state as { key?: unknown }).key;
    if (typeof key === 'string') return key;
  }
  return undefined;
}
