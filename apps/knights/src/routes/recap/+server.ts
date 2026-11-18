import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { dismissRecap, findRecap } from '$lib/server/daily/daily.service';
import { queueDeps } from '$lib/server/queue/runtime';
import type { RequestHandler } from './$types';

/** The header button's recap, read on click rather than on every page load: it is shown whether or not today's was already seen. */
export const GET: RequestHandler = async ({ locals }) => {
  const recap = await findRecap(db, { playerId: locals.user.id, now: queueDeps.now() });
  return json({ recap });
};

/** Marks today's recap seen (home card or header dialog). The stored popup opt-out is left as it was. */
export const POST: RequestHandler = async ({ locals }) => {
  try {
    await dismissRecap(db, { playerId: locals.user.id, now: queueDeps.now() });
  } catch (error) {
    console.error('knights: could not store the recap dismissal', { error });
    return json({ message: 'Could not save that. Try again.' }, { status: 500 });
  }
  return json({ ok: true });
};
