import { navRegistry } from '~/components/HomeContentToggle/nav-registry';
import type { NavGroup } from '~/components/HomeContentToggle/nav-registry';
import { resolveNavLayout } from '~/components/HomeContentToggle/resolve-nav-items';
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { NavKey } from '~/shared/constants/nav.constants';

export type NavRow = { key: NavKey; group: NavGroup; hidden: boolean; locked: boolean };

/**
 * The settings modal's rows, from the SAME merge the nav renders. React-free so the node project
 * can pin the two against each other.
 *
 * 🔴 Do not reimplement the merge here. An earlier cut did, skipped the retired-flag seed the nav
 * applies, and so showed Posts as Hidden to a user who had it in their bar — deleting it on their
 * next save, with the account switch already gone.
 */
export function seedRows(settings: UserContentSettings | null | undefined): NavRow[] {
  const locked = new Set(navRegistry.filter((entry) => entry.locked).map((entry) => entry.key));
  const { groups, hidden } = resolveNavLayout(navRegistry, settings?.navigation, {
    postsNavItem: settings?.features?.postsNavItem,
    eventsNavItem: settings?.features?.eventsNavItem,
  });

  return (['bar', 'more'] as const).flatMap((group) =>
    groups[group].map((key) => ({
      key,
      group,
      hidden: hidden.has(key),
      locked: locked.has(key),
    }))
  );
}

/** What the modal saves. Every group, every time — the write replaces the key outright. */
export function rowsToConfig(rows: NavRow[], showLabels: boolean) {
  return {
    bar: rows.filter((row) => row.group === 'bar').map((row) => row.key),
    more: rows.filter((row) => row.group === 'more').map((row) => row.key),
    hidden: rows.filter((row) => row.hidden).map((row) => row.key),
    showLabels,
  };
}
