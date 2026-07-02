import type { PageServerLoad } from './$types';
import { appRoles } from '@civitai/auth';
import { APP } from '$lib/server/access';

export const load: PageServerLoad = ({ locals }) => ({
  roles: appRoles(locals.user, APP),
});
