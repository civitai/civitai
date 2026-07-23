import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getCreatorScore } from '$lib/server/creator-score';
import { getGetPaidEstimate } from '$lib/server/creator-program';

// The Studio gates monetization on Creator Program membership (B1), so a CP member has nothing to join here —
// send them home. Non-CP members (incl. paying members who haven't cleared the score bar) still see the pitch,
// with their current creator score against the requirement + a "your Buzz could be worth $X" estimate (868ke4941).
export const load: PageServerLoad = async ({ parent, locals }) => {
  const { membership } = await parent();
  if (membership.isCreatorProgramMember) redirect(303, '/dashboard');
  const [creatorScore, estimate] = await Promise.all([
    getCreatorScore(locals.user.id),
    // Degrades independently — a ClickHouse/buzz-service hiccup shouldn't blank the whole join page.
    getGetPaidEstimate(locals.user.id).catch(() => null),
  ]);
  return { creatorScore, estimate };
};
