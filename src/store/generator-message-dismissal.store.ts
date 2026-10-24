/**
 * Dismissed generator messages.
 *
 * The ids are generated, not declared: a message id plus a fingerprint of its
 * copy (see `messageDismissId`), so an edited message mints a new id and
 * orphans the old one. One localStorage slot holds them all and is pruned to
 * what still exists — `DismissibleAlert`'s one-key-per-alert scheme grows
 * without bound and nothing collects it.
 *
 * Deliberately NOT `User.settings.dismissedAlerts`: that set is for
 * registry-declared notices and is required to stay enumerable (see
 * `notice-registry.ts`), so dynamic ids would grow a JSONB array on the User row
 * that every `getSettings` read carries.
 */

import { createDismissalStore, localStorageDismissalStorage } from '~/store/dismissal-store';

const STORAGE_KEY = 'generation-message-dismissed';
const BUCKET = 'generation';

/**
 * Orphans from the two previous dismissal schemes. Every key here is an id no
 * other `DismissibleAlert` uses, so the sweep can't delete a live dismissal.
 */
const LEGACY_KEYS = ['generation-experimental-dismissed'];
const LEGACY_PREFIXES = ['alert-dismissed-eco:', 'alert-dismissed-wf:', 'alert-dismissed-mv:'];

function removeLegacyKeys() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const stale = Object.keys(window.localStorage).filter(
      (key) => LEGACY_KEYS.includes(key) || LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix))
    );
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {
    // A full or blocked localStorage must not break the generator.
  }
}

export const generatorMessageDismissals = createDismissalStore<string, typeof BUCKET>({
  storage: localStorageDismissalStorage({
    key: STORAGE_KEY,
    buckets: [BUCKET],
    isId: (value): value is string => typeof value === 'string',
    onRead: removeLegacyKeys,
  }),
  defaultBucket: BUCKET,
});
