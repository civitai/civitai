// Temporary: remove after the Knights v2 launch import
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Explicit check: being admitted to the app is not enough to run an import. */
function assertModerator(user: { isModerator?: boolean } | undefined): void {
  if (user?.isModerator !== true) error(403, 'Moderators only.');
}

export const load: PageServerLoad = ({ locals }) => {
  assertModerator(locals.user);
  return {};
};
