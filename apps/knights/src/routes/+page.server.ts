import { db } from '$lib/server/db';
import type { PageServerLoad } from './$types';

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
