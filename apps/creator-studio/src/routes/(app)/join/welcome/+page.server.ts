import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The success landing after a creator joins the program (the /join action redirects here). Only members have
// something to celebrate — send a non-member back to the join pitch (also guards a direct visit).
export const load: PageServerLoad = async ({ parent }) => {
  const { membership } = await parent();
  if (!membership.isCreatorProgramMember) redirect(303, '/join');
  return {};
};
