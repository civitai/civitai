import type { NavLink } from '$lib/server/access';

/**
 * Queue ownership: who is accountable for keeping a queue covered. It is not page access (who may open
 * it) and not claiming (reports are a shared pool). Owners are stored per queue path in the moderator
 * database (`apps/moderator/queue-owners/schema.sql`), so this file holds only the pure decisions both
 * sides share.
 *
 * In `$lib`, not `$lib/server`: the dashboard filters its own nav with `navOwnedBy`.
 */

export type OwnableQueue = { path: string; label: string; section: string };

/**
 * The queues an owner can be assigned to, derived from the nav tree rather than kept as a list of its
 * own, so a queue added there shows up on `/admin/queue-owners` as unowned with no other change.
 *
 * A queue is a counted leaf: a link with a path and a `countKey`, and no children. Groups are not queues
 * (a tabs group is several, one per tab); uncounted pages are tools, not work that piles up; an
 * informational count is one nobody works through; a shortcut is a second listing of a queue that is
 * owned where it lives; an external link is not this app's.
 */
export function ownableQueues(nav: NavLink[]): OwnableQueue[] {
  const out: OwnableQueue[] = [];
  const seen = new Set<string>();
  const walk = (links: NavLink[], section: string) => {
    for (const link of links) {
      if (link.shortcut || link.external) continue;
      if (link.children) {
        walk(link.children, section || link.label);
        continue;
      }
      if (!link.path || !link.countKey || link.informational || seen.has(link.path)) continue;
      seen.add(link.path);
      out.push({ path: link.path, label: link.label, section: section || 'Pages' });
    }
  };
  walk(nav, '');
  return out;
}

/**
 * `nav` narrowed to the queues in `owned`, for the dashboard's My Tasks view. A group stays while any
 * queue under it is owned, and keeps only those, so a tabs group counts and opens on the owned tabs
 * alone. Everything else drops, pages without a count included: My Tasks is a list of queues.
 */
export function navOwnedBy(nav: NavLink[], owned: ReadonlySet<string>): NavLink[] {
  const out: NavLink[] = [];
  for (const link of nav) {
    if (link.children) {
      const children = navOwnedBy(link.children, owned);
      if (children.length) out.push({ ...link, children });
    } else if (link.path && owned.has(link.path)) out.push(link);
  }
  return out;
}

/** The queues with nobody covering them. */
export const unownedQueues = (
  queues: OwnableQueue[],
  owners: Record<string, readonly number[]>
): OwnableQueue[] => queues.filter((q) => !owners[q.path]?.length);

/**
 * Stored owner rows for a path that is no longer a queue — renamed or removed from the nav. They cover
 * nothing, so `/admin/queue-owners` lists them to remove rather than dropping them silently.
 */
export const retiredQueuePaths = (
  queues: OwnableQueue[],
  owners: Record<string, readonly number[]>
): string[] => {
  const live = new Set(queues.map((q) => q.path));
  return Object.keys(owners)
    .filter((path) => !live.has(path) && owners[path].length)
    .sort();
};

/** Order-blind: an owner list's order means nothing. */
export const sameOwners = (a: readonly number[], b: readonly number[]): boolean => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
};

export type DashboardView = 'mine' | 'all';

/** Per browser: the view a moderator last picked survives a reload. */
export const DASHBOARD_VIEW_KEY = 'moderator.dashboard.view';

/**
 * The view to open on: the one this browser last picked, else My Tasks for an owner of anything and
 * Everything for anyone else. A moderator who owns nothing, or whose ownership could not be read, opens
 * on Everything whatever was stored: My Tasks would be an empty list that reads as "all clear".
 */
export function initialDashboardView(
  owned: readonly string[] | null,
  stored: string | null
): DashboardView {
  if (!owned?.length) return 'all';
  return stored === 'all' ? 'all' : 'mine';
}
