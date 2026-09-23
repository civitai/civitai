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
 * 🔴 Do not reimplement the merge here. An earlier cut did and diverged from it, showing a user's
 * own bar back to them wrong and persisting that on their next save.
 */
export function seedRows(settings: UserContentSettings | null | undefined): NavRow[] {
  const locked = new Set(navRegistry.filter((entry) => entry.locked).map((entry) => entry.key));
  const { groups, hidden } = resolveNavLayout(navRegistry, settings?.navigation);

  return (['bar', 'more'] as const).flatMap((group) =>
    groups[group].map((key) => ({
      key,
      group,
      hidden: hidden.has(key),
      locked: locked.has(key),
    }))
  );
}

/**
 * True when these rows are exactly what the user would get with no saved config at all.
 *
 * Opening the modal and pressing Save without changing anything otherwise persists all four
 * fields — ~300 bytes, on a column that is Redis-cached per user and serialised into the HTML of
 * every logged-in SSR render. Writing nothing instead also leaves them tracking future defaults.
 */
export function matchesDefaults(rows: NavRow[], showLabels: boolean): boolean {
  if (!showLabels) return false;
  const defaults = seedRows(undefined);
  return (
    rows.length === defaults.length &&
    rows.every((row, i) => {
      const other = defaults[i];
      return row.key === other.key && row.group === other.group && row.hidden === other.hidden;
    })
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
