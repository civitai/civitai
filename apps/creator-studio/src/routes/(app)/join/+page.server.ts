import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getCreatorScore } from '$lib/server/creator-score';
import { getGetPaidEstimate } from '$lib/server/creator-program';
import { callMainApp } from '$lib/server/main-app';

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

// Join the Creator Program — written through the main app (it owns eligibility + the session refresh), forwarding
// the shared session cookie. On success the session now has CP membership, so the load above redirects home.
export const actions: Actions = {
  join: async ({ request }) => {
    const result = await callMainApp(
      '/api/v1/creator-program/join',
      request.headers.get('cookie') ?? '',
      {
        method: 'POST',
        parse: false,
        unreachable: 'Could not reach the membership service. Please try again.',
      }
    );

    if (result.ok) redirect(303, '/join/welcome');
    return fail(result.status, { error: result.error });
  },
};
