import { error } from '@sveltejs/kit';
import { listAppRoles } from '@civitai/db-queries/page-access';
import { APP, SUPER_ROLE, type Role } from './access';
import { dbRead } from './db';

/**
 * The roles `/admin` may grant, read from the auth hub's catalogue rather than a list kept here — a role
 * created in the hub has to appear on this screen without a deploy.
 *
 * Read per request instead of cached: only `/admin` calls it, and a stale catalogue on the one screen
 * that edits grants is exactly the staleness the page already refuses (see `readPageAccessGrants`).
 */
export async function grantableRoles(): Promise<Role[]> {
  const all = await listAppRoles(dbRead, APP);
  // The hub always holds at least the super role, so an empty catalogue means the read is wrong, not that
  // there is nothing to grant. Refusing is the point: `pageAccessState` filters stored grants to this
  // list, so rendering an empty one would blank every checkbox and offer a Save that wipes them all.
  if (!all.length) error(503, 'Could not read the role list from the auth hub. Try again shortly.');
  return all.filter((role) => role !== SUPER_ROLE);
}
