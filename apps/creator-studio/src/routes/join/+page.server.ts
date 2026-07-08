import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// A member has nothing to buy here.
export const load: PageServerLoad = async ({ parent }) => {
  const { membership } = await parent();
  if (membership.isMember) redirect(303, '/');
  return {};
};
