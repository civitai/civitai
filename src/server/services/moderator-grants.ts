import { kyselyWrite } from '~/server/db/kyselyDb';

// The moderator app's permission model, read from the main app so an endpoint can hold a moderator to
// the same grant the moderator app does. Mirrors `resolvePermissions` in
// `apps/moderator/src/lib/server/access.ts`: `moderator:admin` holds every permission without a row;
// anyone else only through a role listed on the `grant:<id>` row that `/admin` writes. A missing row
// is nobody.
const SUPER_ROLE = 'moderator:admin';

/** Grant ids this module can check; declared in `apps/moderator/src/lib/permissions.ts`. */
export type ModeratorGrantId = 'user.deleteAccount';

export async function hasModeratorGrant(
  user: { roles?: string[] },
  id: ModeratorGrantId
): Promise<boolean> {
  const roles = user.roles ?? [];
  if (roles.includes(SUPER_ROLE)) return true;
  if (roles.length === 0) return false;

  // The primary, not a replica: a revoked grant must stop working on the next request.
  const row = await kyselyWrite
    .selectFrom('AppPageAccess')
    .select('roles')
    .where('app', '=', 'moderator')
    .where('path', '=', `grant:${id}`)
    .executeTakeFirst();
  return (row?.roles ?? []).some((role) => roles.includes(role));
}
