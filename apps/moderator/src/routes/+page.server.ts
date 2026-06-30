import type { PageServerLoad } from './$types';
import { appRoles } from '@civitai/auth';
import { APP, featuresForUser } from '$lib/server/features';

export const load: PageServerLoad = ({ locals }) => {
  return {
    roles: appRoles(locals.user, APP),
    features: [...featuresForUser(locals.user)],
  };
};
