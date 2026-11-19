import { json } from '@sveltejs/kit';
import { restartLosses } from '$lib/chrome';
import { restartCareer } from '$lib/server/career/restart.service';
import { forgetLegacyCounters } from '$lib/server/career/runtime';
import { spendableOf } from '$lib/server/conversion/balance';
import { db } from '$lib/server/db';
import { getPlayerStatus } from '$lib/server/player-status';
import { queueDeps } from '$lib/server/queue/runtime';
import { MUTED_MESSAGE, getStanding } from '$lib/server/standing';
import type { RequestHandler } from './$types';

/** What a restart would take from this player, for the account menu's confirmation. `null` when there is no career. */
export const GET: RequestHandler = async ({ locals }) => {
  const player = await db
    .selectFrom('NewOrderPlayer')
    .select(['exp', 'goldEarned', 'goldConverted'])
    .where('userId', '=', locals.user.id)
    .executeTakeFirst();
  const status = player ? await getPlayerStatus(db, locals.user.id) : null;
  if (!player || !status) return json({ losses: null });
  return json({
    losses: restartLosses({ ...status, exp: player.exp, goldUnspent: spendableOf(player) }),
  });
};

const refuse = (status: number, message: string) => json({ ok: false, message }, { status });

/** Restarts the career. Answers `{ ok: true, to }` for the page to navigate to, or `{ ok: false, message }`. */
export const POST: RequestHandler = async ({ request, locals }) => {
  // Restarting clears smites, so it counts as judging.
  if ((await getStanding(db, locals.user.id)).muted) return refuse(403, MUTED_MESSAGE);
  const unconfirmed = () => refuse(400, 'Confirm that you want to restart your career.');
  let form: FormData;
  try {
    form = await request.formData();
  } catch (error) {
    // `formData()` throws a TypeError for a body it cannot parse as a form.
    if (error instanceof TypeError) return unconfirmed();
    throw error;
  }
  if (form.get('confirmed') !== 'yes') return unconfirmed();

  let outcome: { reset: boolean };
  try {
    outcome = await restartCareer(db, locals.user.id, queueDeps.now());
  } catch (error) {
    console.error('knights: career restart failed', { error });
    return refuse(500, 'Your career could not be restarted. Try again in a moment.');
  }
  if (!outcome.reset) return json({ ok: true, to: '/home' });

  // The career is already reset; the original game's counters are caches it rebuilds on a miss.
  await forgetLegacyCounters(locals.user.id).catch((error) =>
    console.error('knights: could not clear the original game counters', { error })
  );
  return json({ ok: true, to: '/play' });
};
