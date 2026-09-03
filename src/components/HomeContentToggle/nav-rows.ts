import { navRegistry } from '~/components/HomeContentToggle/nav-registry';
import type { NavPlacement } from '~/components/HomeContentToggle/nav-registry';
import { resolveNavZones } from '~/components/HomeContentToggle/resolve-nav-items';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { NavKey } from '~/shared/constants/nav.constants';

export type NavRow = { key: NavKey; placement: NavPlacement };

/**
 * The settings modal's rows, from the SAME merge the nav renders. React-free so the node project
 * can pin the two against each other.
 *
 * 🔴 Do not reimplement the merge here. An earlier cut did, skipped the retired-flag seed the nav
 * applies, and so showed Posts as Hidden to a user who had it in their bar — deleting it on their
 * next save, with the account switch already gone.
 */
export function seedRows(settings: UserContentSettings | null | undefined): NavRow[] {
  const zones = resolveNavZones(navRegistry, settings?.navigation, {
    postsNavItem: settings?.features?.postsNavItem,
    eventsNavItem: settings?.features?.eventsNavItem,
  });
  return (['bar', 'more', 'hidden'] as const).flatMap((placement) =>
    zones[placement].map((key) => ({ key, placement }))
  );
}
