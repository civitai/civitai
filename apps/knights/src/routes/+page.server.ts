import { fail, redirect } from '@sveltejs/kit';
import { restartCareer } from '$lib/server/career/restart.service';
import { forgetLegacyCounters } from '$lib/server/career/runtime';
import { getDailyStatus } from '$lib/server/daily/daily.service';
import { db } from '$lib/server/db';
import { joinOrder } from '$lib/server/join.service';
import { getPlayerStatus } from '$lib/server/player-status';
import { queueDeps } from '$lib/server/queue/runtime';
import { getStanding, mutedFailure } from '$lib/server/standing';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const player = await db
    .selectFrom('NewOrderPlayer')
    .select(['rankType', 'exp', 'startAt'])
    .where('userId', '=', locals.user.id)
    .executeTakeFirst();

  // The status and the Watch streak also feed the header's stat pills through page data.
  const status = player ? await getPlayerStatus(db, locals.user.id) : null;
  const daily = status
    ? await getDailyStatus(db, {
        playerId: locals.user.id,
        rank: status.rank,
        now: queueDeps.now(),
      })
    : null;

  return {
    username: locals.user.username ?? null,
    player: player ? { ...player, startAt: player.startAt.toISOString() } : null,
    status,
    daily,
  };
};

export const actions = {
  join: async ({ request, locals }) => {
    const form = await request.formData();
    if (form.get('accepted') !== 'yes') {
      return fail(400, { message: 'You must accept the content warning to join.' });
    }

    try {
      await joinOrder(db, locals.user.id);
    } catch (error) {
      console.error('knights: join failed', { error });
      return fail(500, { message: 'You could not be sworn in. Try again in a moment.' });
    }
    redirect(303, '/play');
  },
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
