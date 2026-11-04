import { fail, redirect } from '@sveltejs/kit';
import { getDailyStatus } from '$lib/server/daily/daily.service';
import { db } from '$lib/server/db';
import { joinOrder } from '$lib/server/join.service';
import { getPlayerStatus } from '$lib/server/player-status';
import { queueDeps } from '$lib/server/queue/runtime';
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
} satisfies Actions;
