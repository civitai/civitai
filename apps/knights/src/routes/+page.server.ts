import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { joinOrder } from '$lib/server/join.service';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const player = await db
    .selectFrom('NewOrderPlayer')
    .select(['rankType', 'exp', 'fervor', 'startAt'])
    .where('userId', '=', locals.user.id)
    .executeTakeFirst();

  return {
    username: locals.user.username ?? null,
    player: player ? { ...player, startAt: player.startAt.toISOString() } : null,
  };
};

export const actions: Actions = {
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
};
