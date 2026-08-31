/**
 * Dismissed experimental warnings.
 *
 * These ids are generated, not declared: a target plus a fingerprint of the
 * message, so editing copy mints a new id and orphans the old one. Written the
 * way `DismissibleAlert` writes (`alert-dismissed-<id>`, one localStorage key per
 * alert, no expiry) that grows without bound and nothing collects it — hence the
 * shared dismissal store, which holds one slot and prunes to what still exists.
 *
 * Deliberately NOT `User.settings.dismissedAlerts`: that set is for
 * registry-declared notices and is required to stay enumerable (see
 * `notice-registry.ts`), so dynamic ids would grow a JSONB array on the User row
 * that every `getSettings` read carries.
 */

import { createDismissalStore, localStorageDismissalStorage } from '~/store/dismissal-store';

const STORAGE_KEY = 'generation-experimental-dismissed';
const BUCKET = 'generation';

/** Keys written by the previous one-key-per-warning scheme. */
const LEGACY_PREFIXES = ['alert-dismissed-eco:', 'alert-dismissed-wf:', 'alert-dismissed-mv:'];

/**
 * Sweep the orphans that scheme left in existing users' storage. Scoped to its
 * three prefixes, which no other `DismissibleAlert` id uses.
 */
function removeLegacyKeys() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const stale = Object.keys(window.localStorage).filter((key) =>
      LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix))
    );
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {
    // A full or blocked localStorage must not break the generator.
  }
}

export const experimentalDismissals = createDismissalStore<string, typeof BUCKET>({
  storage: localStorageDismissalStorage({
    key: STORAGE_KEY,
    buckets: [BUCKET],
    isId: (value): value is string => typeof value === 'string',
    onRead: removeLegacyKeys,
  }),
  defaultBucket: BUCKET,
});
