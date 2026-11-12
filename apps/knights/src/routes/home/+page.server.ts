import { fail, redirect } from '@sveltejs/kit';
import { findRecap, getDailyStatus } from '$lib/server/daily/daily.service';
import { db } from '$lib/server/db';
import { joinOrder } from '$lib/server/join.service';
import { getPlayerStatus } from '$lib/server/player-status';
import { queueDeps } from '$lib/server/queue/runtime';
import { railFor } from '$lib/server/rail-runtime';
import { requireMember } from '$lib/server/membership';
import { dismissWhatsNew, readNotices } from '$lib/server/seen';
import { seenStore } from '$lib/server/seen-runtime';
import { isReturningPlayer, whatsNewCopy } from '$lib/whats-new';
import type { Actions, PageServerLoad } from './$types';

// The recap card and the fervor position are extras: a failed read leaves them out instead of failing the home page.
const optional = <T>(what: string, read: () => Promise<T>): Promise<T | null> =>
  Promise.resolve()
    .then(read)
    .catch((error) => {
      console.error(`knights: could not read the ${what} for the home page`, { error });
      return null;
    });

export const load: PageServerLoad = async ({ locals }) => {
  const player = await db
    .selectFrom('NewOrderPlayer')
    .select(['rankType', 'exp', 'startAt'])
    .where('userId', '=', locals.user.id)
    .executeTakeFirst();

  // The status and the Watch streak also feed the header's stat pills through page data.
  const status = player ? await getPlayerStatus(db, locals.user.id) : null;
  const now = queueDeps.now();
  const playerId = locals.user.id;
  // The recap card replaces the daily popup: yesterday's verdicts, read whether or not they were already seen. The page marks
  // today's recap seen once it shows (a load that only prefetched must not).
  // Only "What's new" is read here; /play shows the guide and progress notices, which stay unrecorded until it does.
  const [daily, recap, rail, seen] = status
    ? await Promise.all([
        getDailyStatus(db, { playerId, rank: status.rank, now }),
        optional('recap', () => findRecap(db, { playerId, now })),
        optional('rail', () => railFor(playerId, now, status.fervor)),
        readNotices(seenStore, playerId, status),
      ])
    : [null, null, null, null];

  return {
    username: locals.user.username ?? null,
    player: player ? { ...player, startAt: player.startAt.toISOString() } : null,
    status,
    daily,
    recap,
    fervorPosition: rail?.standing?.position ?? null,
    whatsNew: status && seen?.whatsNew ? whatsNewCopy(isReturningPlayer(status)) : null,
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

  dismissWhatsNew: async ({ locals }) => {
    const status = await requireMember(db, locals.user.id);
    if (!(await dismissWhatsNew(seenStore, locals.user.id, status))) {
      return fail(500, { message: 'Could not close this. Try again.', whatsNewFailed: true });
    }
  },
} satisfies Actions;
