import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
  dismissRecap,
  findRecap,
  getDailyStatus,
  getRecapState,
} from '$lib/server/daily/daily.service';
import { getPlayerStatus } from '$lib/server/player-status';
import { queueDeps } from '$lib/server/queue/runtime';
import type { RequestHandler } from './$types';

/** The header button's recap, read on click rather than on every page load: it is shown whether or not today's was dismissed or the popup opted out. */
export const GET: RequestHandler = async ({ locals }) => {
  const playerId = locals.user.id;
  const now = queueDeps.now();
  const [recap, state, status] = await Promise.all([
    findRecap(db, { playerId, now }),
    getRecapState(db, { playerId, now }),
    getPlayerStatus(db, playerId),
  ]);
  const daily = status ? await getDailyStatus(db, { playerId, rank: status.rank, now }) : null;
  return json({
    recap,
    optOut: state.optedOut,
    watch: daily && { streak: daily.streak, size: daily.watchSize, done: daily.watchDone },
  });
};

/** Closing the dialog: dismisses today's recap and stores the checkbox as the player's opt-out. */
export const POST: RequestHandler = async ({ request, locals }) => {
  const optOut = (await request.formData()).get('optOut') === 'on';
  try {
    await dismissRecap(db, { playerId: locals.user.id, now: queueDeps.now(), optOut });
  } catch (error) {
    console.error('knights: could not store the recap dismissal', { error });
    return json({ message: 'Could not save that. Try again.' }, { status: 500 });
  }
  return json({ ok: true });
};
