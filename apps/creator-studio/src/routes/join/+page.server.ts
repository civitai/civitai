import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getCreatorScore } from '$lib/server/creator-score';

// The Studio gates monetization on Creator Program membership (B1), so a CP member has nothing to join here —
// send them home. Non-CP members (incl. paying members who haven't cleared the score bar) still see the pitch,
// with their current creator score against the requirement.
export const load: PageServerLoad = async ({ parent, locals }) => {
  const { membership } = await parent();
  if (membership.isCreatorProgramMember) redirect(303, '/');
  const creatorScore = await getCreatorScore(locals.user.id);
  return { creatorScore };
};
