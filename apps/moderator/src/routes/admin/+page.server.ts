import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { isModeratorAdmin, FEATURES, ROLE_FEATURES } from '$lib/server/features';

export const load: PageServerLoad = ({ locals }) => {
  if (!isModeratorAdmin(locals.user)) error(403, 'Requires the moderator:admin role.');

  return {
    features: Object.entries(FEATURES).map(([key, def]) => ({ key, ...def })),
    roles: Object.entries(ROLE_FEATURES).map(([role, features]) => ({ role, features })),
  };
};
