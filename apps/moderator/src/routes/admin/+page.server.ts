import type { PageServerLoad } from './$types';
import { requireAccess, ROLE_HIERARCHY } from '$lib/server/access';

export const load: PageServerLoad = ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);
  return { hierarchy: ROLE_HIERARCHY };
};
