import { fail, redirect } from '@sveltejs/kit';
import { restartCareer } from '$lib/server/career/restart.service';
import { forgetLegacyCounters } from '$lib/server/career/runtime';
import { db } from '$lib/server/db';
import { getPlayerStatus } from '$lib/server/player-status';
import { queueDeps } from '$lib/server/queue/runtime';
import { rulesFacts } from '$lib/server/rules';
import { getStanding, mutedFailure } from '$lib/server/standing';
import { judgesNeeded } from '$lib/server/yesno/items';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const [facts, player] = await Promise.all([
    judgesNeeded(db).then(rulesFacts),
    db
      .selectFrom('NewOrderPlayer')
      .select('exp')
      .where('userId', '=', locals.user.id)
      .executeTakeFirst(),
  ]);
  // Only a player has a career to restart. It is not `status`, which would also fill the header's stat pills here.
  const status = player ? await getPlayerStatus(db, locals.user.id) : null;
  return { facts, career: status && player ? { status, exp: player.exp } : null };
};

export const actions = {
  restart: async ({ request, locals }) => {
    // Restarting clears smites, so it counts as judging.
    if ((await getStanding(db, locals.user.id)).muted) return mutedFailure({ restartFailed: true });
    const form = await request.formData();
    if (form.get('confirmed') !== 'yes') {
      return fail(400, {
        message: 'Confirm that you want to restart your career.',
        restartFailed: true,
      });
    }

    let outcome: { reset: boolean };
    try {
      outcome = await restartCareer(db, locals.user.id, queueDeps.now());
    } catch (error) {
      console.error('knights: career restart failed', { error });
      return fail(500, {
        message: 'Your career could not be restarted. Try again in a moment.',
        restartFailed: true,
      });
    }
    if (!outcome.reset) redirect(303, '/');

    // The career is already reset; the original game's counters are caches it rebuilds on a miss.
    await forgetLegacyCounters(locals.user.id).catch((error) =>
      console.error('knights: could not clear the original game counters', { error })
    );
    redirect(303, '/play');
  },
} satisfies Actions;
