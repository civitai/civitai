import type { AppsStoreFeatureFlags } from '~/shared/utils/app-blocks-access';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';

/**
 * Whether a profile shows its "Apps" tab — and whether `/user/<name>/apps` renders: only to a
 * viewer who can see the app store (the shared `hasAppsStoreAccess`, the same rule as `/apps`),
 * and never on a banned account's profile. One predicate for the tab and the page, so the two
 * cannot drift. `user` is absent while the profile loads; the tab shows then, like its siblings.
 */
export function canShowProfileAppsTab(
  features: AppsStoreFeatureFlags,
  user: { bannedAt?: Date | string | null } | null | undefined
): boolean {
  return hasAppsStoreAccess(features) && !user?.bannedAt;
}
