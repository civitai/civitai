import { kyselyWrite } from '~/server/db/kyselyDb';

// The moderator app's permission model, read from the main app so an endpoint can hold a moderator to
// the same grant the moderator app does. Mirrors `resolvePermissions` in
// `apps/moderator/src/lib/server/access.ts`: `moderator:admin` holds every permission without a row;
// anyone else only through a role listed on the `grant:<id>` row that `/admin` writes. A missing row
// is nobody.
const SUPER_ROLE = 'moderator:admin';

/** Grant ids this module can check; declared in `apps/moderator/src/lib/permissions.ts`. */
export type ModeratorGrantId =
  | 'user.deleteAccount'
  | 'user.personalDataExport.queue'
  | 'user.personalDataExport.release'
  | 'user.purge'
  | 'user.removeReactions'
  | 'user.membership.code'
  | 'user.membership.gift'
  | 'user.membership.gift.comp'
  | 'user.membership.extend'
  | 'user.membership.cancel'
  | 'user.creatorScore.grant'
  | 'user.creatorScore.grantLarge'
  | 'user.creatorProgram.ban'
  | 'creatorServices.resolveDispute'
  | 'creatorServices.reviewDispute'
  | 'image.removal.confirm'
  | 'csam.report.file'
  | 'user.ban'
  | 'user.strike'
  | 'user.message.asCivitai'
  | 'labelStore.submitPrediction'
  | 'apps.buzz.refund'
  | 'apps.buzz.refund.large'
  | 'training.retrain'
  | 'feedback.status.set'
  | 'tickets.escalate';

/** Whether `user` holds a role on the moderator app's `AppPageAccess` row `path`; admin always. */
async function holdsModeratorRow(user: { roles?: string[] }, path: string): Promise<boolean> {
  const roles = user.roles ?? [];
  if (roles.includes(SUPER_ROLE)) return true;
  if (roles.length === 0) return false;

  // The primary, not a replica: a revoked grant must stop working on the next request.
  const row = await kyselyWrite
    .selectFrom('AppPageAccess')
    .select('roles')
    .where('app', '=', 'moderator')
    .where('path', '=', path)
    .executeTakeFirst();
  return (row?.roles ?? []).some((role) => roles.includes(role));
}

/**
 * Whether the moderator app lets this user open `path`, by the page grant `/admin` writes (the
 * `AppPageAccess` row keyed by the path itself). Only for a page granted by its own path: a queue under
 * a shared section (`sharedAccess` in the app's `NAVIGATION`) is granted by the section's path.
 */
export const hasModeratorPageAccess = (user: { roles?: string[] }, path: string) =>
  holdsModeratorRow(user, path);

export const hasModeratorGrant = (user: { roles?: string[] }, id: ModeratorGrantId) =>
  holdsModeratorRow(user, `grant:${id}`);
