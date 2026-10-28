import type { PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';

export const load: PageServerLoad = ({ locals, url }) => requireAccess(locals.user, url.pathname);
