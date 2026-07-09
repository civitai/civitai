import type { PageServerLoad } from './$types';
import { requireAccess, roleHierarchy } from '$lib/server/access';

export const load: PageServerLoad = ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);
  return { hierarchy: roleHierarchy() };
};
