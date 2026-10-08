import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import type { PageServerLoad } from './$types';
import { postPlannerEnabled } from '$lib/server/post-planner';

export const load: PageServerLoad = async ({ locals }) => {
  if (!(await postPlannerEnabled(locals.user))) error(404, 'Not found');
  const user = locals.user;
  if (!env.PUBLIC_IMAGE_LOCATION) error(500, 'PUBLIC_IMAGE_LOCATION is not configured');
  return {
    userId: user.id,
    imageLocation: env.PUBLIC_IMAGE_LOCATION,
    browsingLevel: user.browsingLevel,
    showMature: user.showNsfw && !user.blurNsfw,
  };
};
